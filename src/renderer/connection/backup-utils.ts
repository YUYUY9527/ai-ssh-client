import type { SSHConnection } from '../../shared/types';

export type BackupConflict = {
  incoming: SSHConnection;
  existing: SSHConnection;
  reason: 'id' | 'endpoint';
};

/** Normalizes backup JSON that may be wrapped as `{ data: ... }`. */
export function unwrapBackupData(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const root = input as Record<string, unknown>;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

/** Extracts SSH connections from a backup object. */
export function extractConnectionsFromBackup(data: Record<string, unknown>): SSHConnection[] {
  const list = data.connections || data.sshConnections || data.ssh_connections;
  if (!Array.isArray(list)) {
    return [];
  }
  const connections: SSHConnection[] = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const row = item as Record<string, unknown>;
    const host = String(row.host || '').trim();
    const username = String(row.username || '').trim();
    if (!host || !username) {
      return;
    }
    connections.push({
      id: String(row.id || `import-${Date.now()}-${index}`),
      name: String(row.name || host),
      host,
      port: Number(row.port || 22) || 22,
      username,
      password: typeof row.password === 'string' ? row.password : undefined,
      privateKey: typeof row.privateKey === 'string'
        ? row.privateKey
        : typeof row.private_key === 'string'
          ? row.private_key
          : undefined,
      passphrase: typeof row.passphrase === 'string' ? row.passphrase : undefined,
    });
  });
  return connections;
}

/** Finds id or host@user:port conflicts against current connections. */
export function findConnectionConflicts(
  existing: SSHConnection[],
  incoming: SSHConnection[],
): BackupConflict[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const byEndpoint = new Map(
    existing.map((item) => [`${item.username}@${item.host}:${item.port}`.toLowerCase(), item]),
  );
  const conflicts: BackupConflict[] = [];

  incoming.forEach((item) => {
    const idHit = byId.get(item.id);
    if (idHit) {
      conflicts.push({ incoming: item, existing: idHit, reason: 'id' });
      return;
    }
    const endpoint = `${item.username}@${item.host}:${item.port}`.toLowerCase();
    const endpointHit = byEndpoint.get(endpoint);
    if (endpointHit) {
      conflicts.push({ incoming: item, existing: endpointHit, reason: 'endpoint' });
    }
  });

  return conflicts;
}

/** Triggers a browser download for a JSON/text payload. */
export function downloadTextFile(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Reads a local File as text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
