import type { AppSettings, HostTrustRecord, SSHConnection, SSHSessionState } from '../../../shared/types';
import type { IPCResult, SSHConnectResult, SSessionsResult } from '../../../shared/ipc-types';
import { tauriInvoke, type ListenerCleanup } from '../native';

export const nativeSsh = {
  connect: (
    connection: SSHConnection,
    cols?: number,
    rows?: number,
    settings?: AppSettings,
  ): Promise<IPCResult<SSHConnectResult>> => (
    tauriInvoke<SSHConnectResult>('ssh_connect', { connection, cols, rows, settings })
  ),
  disconnect: (connectionId: string): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_disconnect', { connectionId })
  ),
  execute: (connectionId: string, command: string): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_execute', { connectionId, command })
  ),
  executeSync: (connectionId: string, command: string): void => {
    void tauriInvoke<void>('ssh_execute_sync', { connectionId, command });
  },
  getSessions: (): Promise<IPCResult<SSessionsResult>> => (
    tauriInvoke<SSessionsResult>('ssh_get_sessions')
  ),
  resize: (connectionId: string, cols: number, rows: number): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_resize', { connectionId, cols, rows })
  ),
  testConnection: (connection: SSHConnection): Promise<IPCResult> => (
    tauriInvoke<void>('ssh_test_connection', { connection })
  ),
  getHostTrustRecord: (
    host: string,
    port: number,
  ): Promise<IPCResult<{ record: HostTrustRecord | null }>> => (
    tauriInvoke<{ record: HostTrustRecord | null }>('ssh_get_host_trust_record', { host, port })
  ),
};

export type SshDataListener = (data: {
  connectionId: string;
  data: string;
  type?: string;
  state?: SSHSessionState;
}) => void;

export type SshListenerCleanup = ListenerCleanup;
