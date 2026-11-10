export interface SessionCommandEntry {
  id: string;
  command: string;
  timestamp: number;
  cwd?: string;
  executedBy: 'user' | 'ai';
}

const MAX_COMMANDS_PER_CONNECTION = 200;
const buffers = new Map<string, SessionCommandEntry[]>();

export const SESSION_COMMAND_UPDATED_EVENT = 'session-command-history-updated';

function keyFor(connectionId: string): string {
  return connectionId || '__unknown__';
}

/**
 * 记录当前连接本次会话里输入的命令，只保存在内存中，不写入任何配置文件。
 * 面板会把这份内存记录和服务器 ~/.bash_history 合并展示。
 */
export function recordSessionCommand(
  connectionId: string,
  entry: Omit<SessionCommandEntry, 'id' | 'timestamp'> & { timestamp?: number },
): void {
  const command = entry.command.trim();
  if (!command) {
    return;
  }
  const key = keyFor(connectionId);
  const current = buffers.get(key) ?? [];
  const next: SessionCommandEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    command,
    timestamp: entry.timestamp ?? Date.now(),
    cwd: entry.cwd,
    executedBy: entry.executedBy,
  };
  buffers.set(key, [next, ...current].slice(0, MAX_COMMANDS_PER_CONNECTION));

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_COMMAND_UPDATED_EVENT, {
      detail: { connectionId },
    }));
  }
}

export function getSessionCommands(connectionId: string): readonly SessionCommandEntry[] {
  return buffers.get(keyFor(connectionId)) ?? [];
}

export function clearSessionCommands(connectionId: string): void {
  buffers.delete(keyFor(connectionId));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_COMMAND_UPDATED_EVENT, {
      detail: { connectionId },
    }));
  }
}
