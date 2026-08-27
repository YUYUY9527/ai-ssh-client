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

/** CSI 终止字节范围（0x40-0x7E，参数中间字节为 0x20-0x3F）。 */
function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7E;
}

/** OSC/DCS/APC/PM/SOS 序列族的第二字节（均以 ST 或 BEL 终止）。 */
const STRING_SEQUENCE_TAILS: ReadonlySet<string> = new Set([']', 'P', 'X', '^', '_']);

/** 2 字节 ESC 序列族的第二字节（后跟单个终结字节）。 */
const TWO_BYTE_PREFIX: ReadonlySet<string> = new Set(['(', ')', '*', '+', '-', '.', '/', '#', '%']);

/** 单字节 ESC 序列：ESC + 1 字节即完成（C1 控制/单字节命令）。 */
const SINGLE_BYTE_TAILS: ReadonlySet<string> = new Set([
  '7', '8', '9', '=', '>', 'D', 'E', 'F', 'G', 'H', 'K', 'M', 'N',
  'O', 'Z', 'c',
]);

/**
 * 扫描 content 中从 escIndex（必须指向 \x1b）开始的转义序列，
 * 返回序列结束后的下标（终止字节之后）；未闭合/畸形返回 -1。
 *
 * 覆盖常见序列族：
 * - CSI（ESC [）：参数字节 0x20-0x3F + 终止字节 0x40-0x7E；
 * - OSC/DCS/APC/PM/SOS（ESC ] P X ^ _）：以 BEL 或 ST（ESC \）终止；
 * - 2 字节字符集序列（ESC ( B 等）；
 * - 单字节 ESC 序列（ESC 7/8/D/E/F/H 等）。
 */
export function escapeSequenceEndAt(content: string, escIndex: number): number {
  const next = content[escIndex + 1];
  if (next === undefined) {
    return -1;
  }

  if (next === '[') {
    // CSI：参数字节 0x20-0x3F 后跟终止字节 0x40-0x7E。
    let j = escIndex + 2;
    while (j < content.length) {
      const code = content.charCodeAt(j);
      j += 1;
      if (isCsiFinalByte(code)) {
        return j;
      }
    }
    return -1;
  }

  if (STRING_SEQUENCE_TAILS.has(next)) {
    // OSC/DCS/APC/PM/SOS：以 BEL 或 ST（ESC \）终止。
    let j = escIndex + 2;
    while (j < content.length) {
      const ch = content[j];
      if (ch === '\x07') {
        return j + 1;
      }
      if (ch === '\x1b' && content[j + 1] === '\\') {
        return j + 2;
      }
      j += 1;
    }
    return -1;
  }

  if (TWO_BYTE_PREFIX.has(next)) {
    // ESC + prefix + 终结字节（如 ESC ( B：字符集选择）。
    return escIndex + 3 <= content.length ? escIndex + 3 : -1;
  }

  if (SINGLE_BYTE_TAILS.has(next)) {
    // ESC + 单字节命令（如 ESC 7 保存光标）。
    return escIndex + 2 <= content.length ? escIndex + 2 : -1;
  }

  // 未知 ESC 用法：按 2 字节序列保守处理。
  return escIndex + 2 <= content.length ? escIndex + 2 : -1;
}

/**
 * trans 尾部未完成的转义序列（流在该处被帧/块切断）。
 * 返回该序列在 content 内的起始下标（指向 ESC）；尾部无悬挂序列返回 -1。
 *
 * 场景：SSH 输出被 WS/PTY 帧切成任意大小，`\x1b[18;1H` 可能跨帧：
 * 前一帧以 `\x1b` 结尾（悬挂），后一帧以 `[18;1H` 开头（裸续接）。
 * xterm 流式解析可跨 write 续接，但若中途插入其他序列（如注头 1049h），
 * 悬挂 ESC 被打断丢弃，裸残片会被当作文本绘制 → 行尾粘连。
 */
export function pendingEscapeAtEnd(content: string): number {
  if (!content) {
    return -1;
  }
  const esc = content.lastIndexOf('\x1b');
  if (esc === -1) {
    return -1;
  }
  // 从 ESC 起扫描：若序列能完整解析到 content 内结束，说明不是悬挂序列。
  const end = escapeSequenceEndAt(content, esc);
  return end === -1 ? esc : -1;
}

/**
 * 续接匹配：prev 尾部有悬挂序列（pendingEsc），delta 是否是它的续接字节？
 * 返回 delta 中"续接序列完成"的偏移（之后可安全插入新序列）；
 * delta 不与悬挂序列续接时返回 0。
 *
 * 示例：prev 尾 `\x1b`（悬挂 CSI 起始），delta = `[18;1H2285...`
 * → 续接完成点在 `H` 之后（偏移 7），返回 7。
 */
export function continuationOffset(delta: string, pendingEsc: number, prev: string): number {
  if (!delta || pendingEsc < 0) {
    return 0;
  }
  const seqBody = delta;
  // 悬挂序列 = prev 尾部从 ESC 起；它是 delta 的开头字节 + 更早的中间字节。
  // 扫描 delta：从 delta[0] 起，按"悬挂序列的续接"扫描终止字节。
  const full = prev + delta;
  const end = escapeSequenceEndAt(full, pendingEsc);
  if (end === -1) {
    // 仍不完整：整段 delta 都是续接体的一部分（如 `\x1b[18` + 悬挂，等待更多）→
    // 不视为续接完成，按 0 处理（调用方决定策略）。
    return 0;
  }
  const offset = end - prev.length;
  return offset > 0 ? offset : 0;
}

/**
 * 转义序列边界对齐后的安全窗口起始下标。
 *
 * 背景：nano/vim 在 alt screen 内的重绘流没有 LF/CRLF 行边界（翻页/重绘
 * 全用 CUP/VPA 绝对定位），按字节截断时行边界对齐失效，窗口起点极易落在
 * `\x1b[8;1H` 这类 CSI 序列内部：ESC 被丢在窗口外，序列残余（如 `8;1H`）
 * 被 xterm 当作普通文本绘制在行尾 → 行号与内容重叠粘连、画面错乱。
 *
 * 规则：若截断点恰好落在一个转义序列内部，则把起点前移到该序列结束之后
 * （丢弃完整的半个序列——宁可少显示一个序列，不可把流切出碎片）；
 * 若截断点原本就是干净的文本/序列边界，则原样保留。
 */
export function alignToEscapeBoundary(content: string, cut: number): number {
  if (cut <= 0 || cut >= content.length) {
    return cut;
  }
  // 截断点之前最近的 ESC：若截断点在这条序列内部，需要前移。
  const esc = content.lastIndexOf('\x1b', cut - 1);
  if (esc === -1) {
    return cut;
  }
  const seqEnd = escapeSequenceEndAt(content, esc);
  if (seqEnd === -1 || seqEnd > content.length) {
    // 序列未闭合（畸形流）：保守留在原位，不冒险清空窗口。
    return cut;
  }
  // 截断点在 (esc, seqEnd) 内 → 序列被拦腰切断 → 前移到序列结束之后；
  // 否则截断点本身是安全边界。
  return cut >= seqEnd ? cut : seqEnd;
}

/**
 * 按字节上限截断输出并保持 alt screen 状态。
 *
 * 语义与旧实现（slice(-maxBytes) + 行边界对齐）一致，额外：
 * - 截断点对齐到转义序列边界：alt 屏幕内（nano/vim）的重绘流无 LF/CRLF
 *   行边界（行边界对齐失效），起点必须保证不落在 CSI/OSC 等序列内部，
 *   否则序列残余会被当作文本绘制（行号粘连、画面错乱）；
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

  // 0) 若输入本身以注入头开始（如 server 窗口再被 client 截断），
  //    保留该头：它已经保证"从 alt 状态开始"，后续逻辑只处理内容窗口。
  //    注意：头是状态元数据，不计入内容窗口长度。
  let header = '';
  let content = fullContent;
  if (content.startsWith(ALT_ENTER_SEQUENCE)) {
    header = ALT_ENTER_SEQUENCE;
    content = content.slice(ALT_ENTER_SEQUENCE.length);
  }

  // 1) 尾部窗口，切点对齐到转义序列边界（alt 流内无行边界，防止切碎序列）。
  const cut = alignToEscapeBoundary(content, content.length - maxBytes);
  let truncated = content.slice(cut);

  // 2) 行边界对齐：普通 shell 流（含 LF/CRLF）从完整行开始，避免行首残片。
  // 注意：nano/vim 进入 alt screen 后重绘流没有 LF（全用 CUP 绝对定位），
  // search(/[\r\n]/) 找不到行边界、返回 -1，此时保留转义边界对齐的结果。
  const lineStart = truncated.search(/[\r\n]/);
  if (lineStart > 0) {
    truncated = truncated.slice(lineStart);
  }

  // 3) 仅当截断前处于 alt、且窗口内没有任何切换序列（唯一 1049h 被滑掉）时注入。
  //    注：若输入本身已带注入头（header 非空），该头已保证 alt 状态，
  //    不再二次注入（重复 1049h 会让 xterm 保存/恢复光标语义错乱）。
  let result = truncated;
  if (!header && scanAltScreenState(fullContent) && detectLastAltSwitch(result) === null) {
    result = ALT_ENTER_SEQUENCE + result;
  }
  // 已剥离的注入头原样保留（server 窗口头）。
  return header + result;
}
