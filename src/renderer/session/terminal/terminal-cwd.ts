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

/** 是否为「仅家目录」绝对路径（如 /root、/home/ubuntu），不含子路径。 */
export function isBareHomeAbsolutePath(path: string): boolean {
  const value = path.trim();
  if (value === '/root' || value === '/home') {
    return true;
  }
  // /home/user、/Users/user；含子路径则不是裸家目录
  return /^\/(?:home|Users)\/[^/]+$/.test(value);
}

/**
 * 是否应用新的 cwd。
 * 一般禁止用 ~/... 覆盖已有绝对路径（SFTP 的 ~ 与 PS1 的 ~ 可能不同家）。
 * 例外：当前只是裸家目录绝对路径（常见登录 OSC7=/root）时，允许被更具体的 ~/sub 推进，
 * 否则会话会永远钉在 /root，右键传输无法跟上。
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
    // /root + ~/projects → 允许；/home/docker/buildkit + ~/x → 拒绝
    if (value.startsWith('~/') && isBareHomeAbsolutePath(cur)) {
      return true;
    }
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

/** 常见提示符结尾字符（含 powerline / oh-my-zsh 风格）。 */
const PROMPT_END_CHARS = new Set(['$', '#', '%', '>', '❯', '➜', '⇒']);

function endsWithPromptChar(value: string): boolean {
  if (!value) {
    return false;
  }
  return PROMPT_END_CHARS.has(value[value.length - 1]);
}

/** 从单行提示符解析 cwd（支持 user@host:path、[user@host path] 等）。 */
export function parsePromptCwd(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || !endsWithPromptChar(trimmed)) {
    return null;
  }

  // 去掉末尾提示符，便于统一匹配
  const body = trimmed.slice(0, -1).trimEnd();

  const bracketMatch = body.match(/\[([^\]]+)\]\s*$/);
  if (bracketMatch) {
    const candidate = bracketMatch[1].trim().split(/\s+/).pop();
    if (candidate && (candidate.startsWith('~') || candidate.startsWith('/'))) {
      return candidate;
    }
  }

  // 只取最后一个冒号后的路径，避免 user@host:port 等干扰
  const colonMatch = body.match(/:([~/][^\s]*)$/);
  if (colonMatch) {
    return colonMatch[1];
  }

  const trailingMatch = body.match(/(?:^|\s)([~/][^\s]*)$/);
  if (trailingMatch) {
    return trailingMatch[1];
  }

  return null;
}

/**
 * 从整段文本里抓「最近一次」路径提示（容错：提示符后已开始输入命令时仍能取到路径）。
 * 例：`root@host:/var/log# cd /tmp` → `/var/log`
 */
export function extractLastPathHint(text: string): string | null {
  if (!text) {
    return null;
  }
  // 括号提示符：[user@host /path] 或 [user@host ~]
  const bracketMatches = [...text.matchAll(/\[([^\]]+)\]\s*[#$%>❯➜⇒]/g)];
  for (let i = bracketMatches.length - 1; i >= 0; i -= 1) {
    const inner = bracketMatches[i][1]?.trim().split(/\s+/).pop();
    if (inner && (inner.startsWith('~') || inner.startsWith('/'))) {
      return inner;
    }
  }

  // user@host:/path# 或 user@host:~/x$
  const colonMatches = [...text.matchAll(/:([~/][^\s#$%>❯➜⇒]*)\s*[#$%>❯➜⇒]/g)];
  if (colonMatches.length > 0) {
    return colonMatches[colonMatches.length - 1][1];
  }

  // 行尾孤立路径
  const trailingMatches = [...text.matchAll(/(?:^|\s)([~/][^\s#$%>❯➜⇒]*)\s*[#$%>❯➜⇒]/g)];
  if (trailingMatches.length > 0) {
    return trailingMatches[trailingMatches.length - 1][1];
  }

  return null;
}

/** 从近期终端输出中提取最近一次提示符里的 cwd。 */
export function extractCwdFromTerminalOutput(output: string): string | null {
  const normalized = stripTerminalControlSequences(tailText(output, 8192)).replace(/\r/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-20)
    .reverse();

  // 只取最近一条提示符路径；~ 与绝对路径的取舍交给 resolveTransferOpenPath / shouldReplaceCwd
  for (const line of lines) {
    const cwd = parsePromptCwd(line);
    if (cwd) {
      return cwd;
    }
  }

  // 当前行可能已在输入命令（不以 #/$ 结尾），回退整段扫描
  return extractLastPathHint(normalized) || parsePromptCwd(normalized.trim());
}

/**
 * 判断绝对路径是否像是对 ~ / ~/rel 的展开。
 * 用于：提示符是 ~/x 时，可用会话里的 /home/.../x 升级；但不能被过期 OSC7=/root 抢走。
 */
export function isPlausibleTildeExpansion(tildePath: string, absolutePath: string): boolean {
  const tilde = tildePath.trim();
  const absolute = absolutePath.trim();
  if (!isTildeRemotePath(tilde) || !isAbsoluteRemotePath(absolute)) {
    return false;
  }
  // 裸 ~：仅当绝对路径本身就是家目录根时视为展开
  if (tilde === '~') {
    return isBareHomeAbsolutePath(absolute);
  }
  const relative = tilde.slice(2);
  if (!relative) {
    return false;
  }
  return absolute === `/${relative}` || absolute.endsWith(`/${relative}`);
}

/**
 * 打开 SFTP 时解析目标目录。
 *
 * 来源优先级（高→低）：live 提示符 > 会话 cwd > OSC7 shell > 已有浏览路径。
 * 取最高优先级非空候选；若它是 ~ 记法，仅当更低优先级存在「像是其展开」的绝对路径时才升级。
 *
 * 这样：
 * - live=~/x、session=/home/u/x、shell=/root → /home/u/x（合理展开）
 * - live=~/x、session=/root、shell=/root → ~/x（避免登录 OSC7 钉死 /root）
 * - live=/etc、session=/otetc、shell=/root → /etc（屏幕真路径纠正误推断）
 * - live 空、session=/home/x、shell=/root → /home/x（cd 追踪优先于过期 OSC7）
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
    options.sessionCwd,
    options.shellCwd,
    options.browserPath,
  ]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));

  const primary = ranked[0];
  if (!primary) {
    return options.fallbackPath;
  }

  // 最高优先级已是绝对路径：直接用（屏幕/会话真值）
  if (isAbsoluteRemotePath(primary)) {
    return primary;
  }

  // 最高优先级是 ~ 记法：仅接受后续「像展开」的绝对路径，拒绝无关的 /root
  if (isTildeRemotePath(primary)) {
    const expanded = ranked.slice(1).find((candidate) => (
      isAbsoluteRemotePath(candidate) && isPlausibleTildeExpansion(primary, candidate)
    ));
    return expanded || primary;
  }

  return primary;
}
