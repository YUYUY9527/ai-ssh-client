/** 会话日志文本导出辅助。 */

/**
 * 从 xterm buffer 序列化可见/缓冲文本；失败时返回空串。
 * 使用 duck-typed buffer 以便单测不依赖真实 xterm。
 */
export function serializeXtermBuffer(term: {
  buffer?: {
    active?: {
      length: number;
      getLine?: (index: number) => { translateToString?: (trimRight?: boolean) => string } | undefined;
    };
  };
} | null | undefined): string {
  const active = term?.buffer?.active;
  if (!active || typeof active.length !== 'number' || !active.getLine) {
    return '';
  }

  const lines: string[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const line = active.getLine(i);
    const text = line?.translateToString?.(true) ?? '';
    lines.push(text);
  }

  // 去掉尾部空行，保留内容中的空行
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * 选择要保存的会话日志：优先 xterm 缓冲，否则回退 session 输出缓存。
 */
export function resolveSessionLogText(
  xtermText: string,
  sessionOutput: string | undefined | null,
): string {
  if (xtermText && xtermText.trim().length > 0) {
    return xtermText;
  }
  return sessionOutput || '';
}

/** 生成默认日志文件名。 */
export function buildSessionLogFilename(sessionId?: string | null, now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const idPart = sessionId ? sessionId.slice(0, 8) : 'session';
  return `terminal-log-${idPart}-${stamp}.txt`;
}
