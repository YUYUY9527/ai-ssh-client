import type { SSHConnection } from '../../shared/types';

/**
 * Parses OpenSSH config text into connection drafts.
 * Supports Host / HostName / User / Port / IdentityFile (content not loaded).
 */
export function parseOpenSshConfig(content: string): SSHConnection[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const hosts: Array<{
    aliases: string[];
    hostName?: string;
    user?: string;
    port?: number;
  }> = [];
  let current: (typeof hosts)[number] | null = null;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, '');

    if (key === 'host') {
      // 跳过通配 Host *
      const aliases = value.split(/\s+/).filter((item) => item && !item.includes('*') && !item.includes('?'));
      if (aliases.length === 0) {
        current = null;
        continue;
      }
      current = { aliases };
      hosts.push(current);
      continue;
    }

    if (!current) continue;
    if (key === 'hostname') current.hostName = value;
    if (key === 'user') current.user = value;
    if (key === 'port') {
      const port = Number(value);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        current.port = port;
      }
    }
  }

  const now = Date.now();
  const connections: SSHConnection[] = [];
  hosts.forEach((item, index) => {
    const name = item.aliases[0];
    const host = item.hostName || name;
    const username = item.user || '';
    if (!host || !username) {
      return;
    }
    connections.push({
      id: `ssh-config-${now}-${index}`,
      name,
      host,
      port: item.port || 22,
      username,
    });
  });

  return connections;
}
