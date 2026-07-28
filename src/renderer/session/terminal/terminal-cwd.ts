/** 从终端输出/提示符解析当前工作目录（纯函数，可单测）。 */

function tailText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(-maxChars);
}

/** 剥离 OSC/CSI 等控制序列，保留可解析的提示符文本。 */
export function stripTerminalControlSequences(input: string): string {
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === '\u001b') {
      const next = input[index + 1];
      if (next === ']') {
        index += 2;
        let previousEscape = false;
        for (; index < input.length; index += 1) {
          const oscChar = input[index];
          if (oscChar === '\u0007' || (previousEscape && oscChar === '\\')) {
            break;
          }
          previousEscape = oscChar === '\u001b';
        }
      } else if (next === '[') {
        index += 2;
        for (; index < input.length; index += 1) {
          const csiChar = input[index];
          if (csiChar >= '@' && csiChar <= '~') {
            break;
          }
        }
      } else if (next) {
        index += 1;
      }
      continue;
    }

    if (ch === '\0') {
      continue;
    }

    if (ch < ' ' && ch !== '\r' && ch !== '\n' && ch !== '\t') {
      continue;
    }

    output += ch;
  }

  return output;
}

/** 从单行提示符解析 cwd（支持 user@host:path、[user@host path] 等）。 */
export function parsePromptCwd(line: string): string | null {
  const trimmed = line.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (!trimmed || (lastChar !== '$' && lastChar !== '#' && lastChar !== '%')) {
    return null;
  }

  const bracketMatch = trimmed.match(/\[([^\]]+)\]\s*[#$%]$/);
  if (bracketMatch) {
    const candidate = bracketMatch[1].trim().split(/\s+/).pop();
    if (candidate && (candidate.startsWith('~') || candidate.startsWith('/'))) {
      return candidate;
    }
  }

  const colonMatch = trimmed.match(/:([~/][^\s#$%]*)\s*[#$%]$/);
  if (colonMatch) {
    return colonMatch[1];
  }

  const trailingMatch = trimmed.match(/(?:^|\s)([~/][^\s#$%]*)\s*[#$%]$/);
  if (trailingMatch) {
    return trailingMatch[1];
  }

  return null;
}

/** 从近期终端输出中提取最近一次提示符里的 cwd。 */
export function extractCwdFromTerminalOutput(output: string): string | null {
  const normalized = stripTerminalControlSequences(tailText(output, 4096)).replace(/\r/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-12)
    .reverse();

  for (const line of lines) {
    const cwd = parsePromptCwd(line);
    if (cwd) {
      return cwd;
    }
  }

  return parsePromptCwd(normalized.trim());
}

/**
 * 打开 SFTP 时解析目标目录。
 * 优先实时提示符与会话 cwd（含 cd/prompt 追踪），再回退 OSC7 / 已有浏览路径。
 * 不把可能过期的 shellCwd 放在 sessionCwd 之前。
 */
export function resolveTransferOpenPath(options: {
  livePromptCwd?: string | null;
  shellCwd?: string | null;
  sessionCwd?: string | null;
  browserPath?: string | null;
  fallbackPath: string;
}): string {
  const candidates = [
    options.livePromptCwd,
    options.sessionCwd,
    options.shellCwd,
    options.browserPath,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return options.fallbackPath;
}
