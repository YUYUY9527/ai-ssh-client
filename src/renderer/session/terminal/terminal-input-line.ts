/**
 * 读取终端里「用户正在输入的那一行」。
 *
 * 为什么需要单独一个模块：`term.buffer.active.getLine(cursorY)` 只返回**一个视觉行**。
 * 输入超过终端宽度后会软折行，直接把它当命令行会丢掉折行之前的部分
 * （真实回归：长中文提问提交后 `userInput` 少了尾巴，
 * 例如输入「还能查询到其他虚拟机吗」只提交了「还能查询到其他虚拟」）。
 * 这里顺着 `isWrapped` 把逻辑行拼回来，再剥离提示符前缀。
 */

/** xterm `IBufferLine` 的最小可用子集（便于纯函数测试）。 */
export interface TerminalBufferLineLike {
  /** xterm：本行是上一行软折行的续行。 */
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

/** 逻辑行最多向上回溯的视觉行数：防止异常 buffer 造成长时间扫描。 */
export const MAX_LOGICAL_LINE_ROWS = 64;

/** 把光标所在逻辑行（含其折行）拼成一个字符串。 */
export function readLogicalBufferLine(
  getLine: (index: number) => TerminalBufferLineLike | undefined,
  cursorY: number,
  maxRows: number = MAX_LOGICAL_LINE_ROWS,
): string {
  let startY = cursorY;
  for (let steps = 0; steps < maxRows && startY > 0; steps += 1) {
    const line = getLine(startY);
    if (!line || !line.isWrapped) {
      break;
    }
    startY -= 1;
  }

  let text = '';
  for (let y = startY; y <= cursorY; y += 1) {
    const line = getLine(y);
    if (!line) {
      break;
    }
    text += line.translateToString(true);
  }
  return text;
}

/**
 * 提示符前缀：与 `isShellPromptReadyForAgent` 认可的形式保持一致
 * （`[user@host ~]#` / `user@host:~$` / `sh-4.2#` / 现代提示符 `❯`）。
 */
const PROMPT_PREFIX_PATTERNS: RegExp[] = [
  /^\[[^\]]+\][#$%]\s*/,
  /^[^\s@]+@[^\s:]+:[^\s]*[$#%]\s*/,
  /^(?:ba)?sh-[^\s]+[$#%]\s*/,
  /^[^\s]*[❯➜λ]\s*/,
];

export interface PromptStripResult {
  /** 剥掉提示符后的内容（未识别到提示符时为整行）。 */
  text: string;
  /** 是否真的识别到了提示符前缀。 */
  matched: boolean;
}

/** 剥离提示符前缀；识别不出提示符时 `matched` 为 false。 */
export function stripPromptPrefix(line: string): PromptStripResult {
  for (const pattern of PROMPT_PREFIX_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return { text: line.slice(match[0].length), matched: true };
    }
  }
  return { text: line, matched: false };
}

/**
 * 判定「光标停在 shell 提示符上、后面是我们正在输入的内容」。
 * 折行后的续行本身不含提示符，因此必须传入拼好的逻辑行。
 */
export function isPromptLineReady(logicalLine: string): boolean {
  const line = logicalLine.replace(/\s+$/, '');
  if (!line || line === '#') {
    return false;
  }
  return stripPromptPrefix(line).matched;
}

/**
 * 决定回车时真正提交的内容。
 *
 * 本地逐字符追踪对「一路键入」是精确的，但会在这些情况下漂移：粘贴（不经过
 * `onData`）、历史召回（↑）、光标编辑（←/→、Delete、Home/End 都不在建模范围内，
 * 只靠 backspace 无法还原）以及中文输入法的候选回退。屏幕上的逻辑行是**远端已经
 * 回显的事实**，所以两者不一致时以屏幕为准；唯一例外是「追踪是屏幕的超集」——
 * 那说明回显还没追上刚敲入的字符，用追踪保住尾部。
 */
export function resolveSubmittedInput(trackedInput: string, screenInput: string): string {
  const tracked = trackedInput.trim();
  const screen = screenInput.trim();
  if (!screen) {
    return tracked;
  }
  if (!tracked) {
    return screen;
  }
  if (screen === tracked) {
    return tracked;
  }
  // 回显滞后：追踪以屏幕为前缀 → 以追踪为准（不丢最近键入的字符）
  if (tracked.startsWith(screen)) {
    return tracked;
  }
  return screen;
}
