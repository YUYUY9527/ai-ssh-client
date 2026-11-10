import type { IPCResult, PrivateKeyFileResult } from '../../shared/ipc-types';
import type { SSHConnection } from '../../shared/types';
import type { OpenSshConnectionDraft } from './parse-openssh-config';

export type PrivateKeyReader = (filePath: string) => Promise<IPCResult<PrivateKeyFileResult>>;

export interface OpenSshIdentityLoadResult {
  connections: SSHConnection[];
  loadedKeys: number;
  failedKeys: number;
}

/**
 * Reads IdentityFile paths referenced by an imported OpenSSH config and folds
 * the file contents into the connection's privateKey field.
 */
export async function loadOpenSshIdentityFiles(
  drafts: OpenSshConnectionDraft[],
  readKey: PrivateKeyReader = (filePath) => window.electronAPI.readPrivateKeyFile(filePath),
): Promise<OpenSshIdentityLoadResult> {
  let loadedKeys = 0;
  let failedKeys = 0;
  const connections: SSHConnection[] = [];

  for (const draft of drafts) {
    const { identityFile, ...connection } = draft;
    if (!identityFile) {
      connections.push(connection);
      continue;
    }

    try {
      const result = await readKey(identityFile);
      if (result.success && result.data?.content) {
        connection.privateKey = result.data.content;
        loadedKeys += 1;
      } else {
        failedKeys += 1;
      }
    } catch {
      failedKeys += 1;
    }

    connections.push(connection);
  }

  return { connections, loadedKeys, failedKeys };
}
