/**
 * 终端 alt screen 状态跟踪与截断窗口复原。
 *
 * 背景：nano / vim 等全屏程序进入 alt screen 时只发送一次
 * `\x1b[?1049h`（在输出流的最头部），之后的翻页/重绘全部用
 * CUP/VPA（\e[Nd、\e[N;MH）在既有行上绝对定位重绘，不再发 1049 序列。
 *
 * 输出缓冲（server / store / localStorage 快照）按字节上限截断时，
 * 保留的是流的尾部窗口——唯一的 1049h 必然被滑掉。此时若把窗口
 * 直接重放进 xterm，xterm 停在 normal buffer，远端的增量重绘全部
 * 定位错位（行号粘连、内容不全），且标题/状态栏/帮助栏等只在打开
 * 一瞬间绘制过的行永远丢失（下方编辑指引消失）。
 *
 * 解法：截断时按"截断前内容是否处于 alt screen"决定是否在窗口头部
 * 注入 `\x1b[?1049h`，保证任何以该窗口开头的重放都从 alt 状态开始。
 */

/** 进入/退出 alt screen 的常见序列族（1049/1047/47）。 */
const ALT_SWITCH_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;

/** 注入用的标准进入序列（xterm.js 与 vim/nano 均识别）。 */
export const ALT_ENTER_SEQUENCE = '\x1b[?1049h';

export type AltSwitchState = 'h' | 'l' | null;

/** 扫描内容中最后一次 alt screen 切换；无任何切换返回 null。 */
export function detectLastAltSwitch(content: string): AltSwitchState {
  if (!content) {
    return null;
  }
  let last: 'h' | 'l' | null = null;
  ALT_SWITCH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ALT_SWITCH_RE.exec(content)) !== null) {
    last = match[1] as 'h' | 'l';
  }
  return last;
}

/** 最后一次切换是否为"进入 alt screen"。无切换时返回 false。 */
export function scanAltScreenState(content: string): boolean {
  return detectLastAltSwitch(content) === 'h';
}

/**
 * 按字节上限截断输出并保持 alt screen 状态。
 *
 * 语义与旧实现（slice(-maxBytes) + 行边界对齐）一致，额外：
 * - 截断前内容处于 alt screen、且截断后的窗口内没有任何进入序列时
 *   （唯一的 1049h 被滑掉），在窗口头部注入 `\x1b[?1049h`；
 * - 窗口内已有的最后一次切换决定注入与否：若窗口内仍然保留了进入
 *   序列（内容中段重新进入过 alt），或窗口以退出序列（1049l）结尾，
 *   则不再注入，避免重复进 alt 导致清屏闪烁 / 状态误判。
 */
export function prepareWindowForReplay(
  fullContent: string,
  maxBytes: number,
): string {
  if (!fullContent || maxBytes <= 0 || fullContent.length <= maxBytes) {
    return fullContent || '';
  }

  let truncated = fullContent.slice(-maxBytes);
  const lineStart = truncated.search(/[\r\n]/);
  if (lineStart > 0) {
    truncated = truncated.slice(lineStart);
  }

  // 仅当截断前处于 alt、且窗口内没有任何切换序列（唯一 1049h 被滑掉）时注入。
  if (scanAltScreenState(fullContent) && detectLastAltSwitch(truncated) === null) {
    return ALT_ENTER_SEQUENCE + truncated;
  }
  return truncated;
}
