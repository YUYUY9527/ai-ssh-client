import type { SessionCommandEntry } from './session-command-buffer';

const HISTORY_FILES = ['~/.bash_history', '~/.zsh_history'];

const NOISE_PATTERNS = [
  /__AIS_PWD_/,
  /__AGENT_DONE_/,
  /__ais_ec/,
  /\bstty\s+-echo\b/,
];

export function isHistoryNoise(command: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * 解析 bash/zsh 的 history 文件内容。
 * bash 在开启 HISTTIMEFORMAT 时会以 `#<秒级时间戳>` 单独占一行；
 * zsh 的 extended history 格式为 `: <时间戳>:<耗时>;<命令>`。
 */
export function parseUnixHistory(text: string): SessionCommandEntry[] {
  const entries: SessionCommandEntry[] = [];
  let pendingTimestamp: number | undefined;
  let index = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      continue;
    }

    const bashTimestamp = /^#(\d{10,13})$/.exec(line.trim());
    if (bashTimestamp) {
      const value = Number(bashTimestamp[1]);
      pendingTimestamp = bashTimestamp[1].length <= 10 ? value * 1000 : value;
      continue;
    }

    const zshEntry = /^: (\d+):\d+;(.*)$/.exec(line);
    let command = zshEntry ? zshEntry[2] : line;
    const timestamp = zshEntry
      ? Number(zshEntry[1]) * 1000
      : pendingTimestamp;
    pendingTimestamp = undefined;

    command = command.trim();
    if (!command || isHistoryNoise(command)) {
      continue;
    }

    entries.push({
      id: `remote-${index}-${command}`,
      command,
      timestamp: timestamp ?? 0,
      executedBy: 'user',
    });
    index += 1;
  }

  return entries;
}

/** 当前会话内存记录在前，服务器 history 文件按从新到旧在后。 */
export function mergeHistorySources(
  sessionCommands: readonly SessionCommandEntry[],
  remoteCommands: readonly SessionCommandEntry[],
): SessionCommandEntry[] {
  return [...sessionCommands, ...[...remoteCommands].reverse()].slice(0, 300);
}

export async function loadServerHistory(connectionId: string): Promise<SessionCommandEntry[]> {
  if (!connectionId || !window.electronAPI?.readSftpTextFile) {
    return [];
  }

  for (const path of HISTORY_FILES) {
    try {
      const result = await window.electronAPI.readSftpTextFile(connectionId, path);
      if (!result.success || !result.data?.content.trim()) {
        continue;
      }
      return parseUnixHistory(result.data.content);
    } catch {
      // 文件不存在或无权限时继续尝试下一个 shell 的 history 文件。
    }
  }

  return [];
}
