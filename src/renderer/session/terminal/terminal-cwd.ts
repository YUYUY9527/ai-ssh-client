/** 从终端输出/提示符解析当前工作目录（纯函数，可单测）。 */

function tailText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(-maxChars);
}

/** 是否为绝对远端路径（SFTP/ shell PWD）。 */
export function isAbsoluteRemotePath(path: string): boolean {
  return path.startsWith('/');
}

/** 是否为 shell 家目录记法（~ 或 ~/...）。 */
export function isTildeRemotePath(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}

/**
 * 是否应用新的 cwd。
 * 禁止用提示符里的 ~/... 覆盖已有绝对路径：SFTP 的 ~ 按登录家目录展开，
 * 与 PS1 里的 ~（按 $HOME）可能不是同一位置。
 */
export function shouldReplaceCwd(current: string | null | undefined, next: string): boolean {
  const cur = current?.trim();
  const value = next.trim();
  if (!value) {
    return false;
  }
  if (!cur) {
    return true;
  }
  if (cur === value) {
    return false;
  }
  if (isAbsoluteRemotePath(cur) && isTildeRemotePath(value)) {
    return false;
  }
  return true;
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

  // 只取最后一个冒号后的路径，避免 user@host:port 等干扰
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

  // 只取最近一条提示符路径；~ 与绝对路径的取舍交给 resolveTransferOpenPath / shouldReplaceCwd
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
 * 在候选中优先绝对路径；来源优先级：
 * 实时提示符 > OSC7(shell) > 会话缓存 > 已有浏览路径。
 * 会话缓存不再含「按 cd 输入乐观推断」的假路径，但仍可能过期，故排在 shell 之后。
 */
export function resolveTransferOpenPath(options: {
  livePromptCwd?: string | null;
  shellCwd?: string | null;
  sessionCwd?: string | null;
  browserPath?: string | null;
  fallbackPath: string;
}): string {
  const ranked = [
    options.livePromptCwd,
    options.shellCwd,
    options.sessionCwd,
    options.browserPath,
  ]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));

  const absolute = ranked.find(isAbsoluteRemotePath);
  if (absolute) {
    return absolute;
  }

  return ranked[0] || options.fallbackPath;
}
