/**
 * 旧版 Vim（7.x，CentOS 7 自带）不支持 bracketed paste（DECSET 2004），
 * 终端无法通过转义序列让它按字面插入多行内容。此时直接粘贴多行，
 * Vim 会把每个换行当成回车，触发 autoindent + comments 续行，
 * 于是首行以 `#` 开头时后续每一行都会被自动补上 `#`。
 *
 * 唯一可靠的绕过办法是临时打开 Vim 的 `:set paste`。这里负责识别 Vim，
 * 并生成「开启 paste → 插入文本 → 关闭 paste」的按键序列。
 */
import type { Terminal as XTerm } from '@xterm/xterm';

const PASTE_END = '\x1b[201~';

/** 把剪贴板文本规范成 Vim paste 模式下的插入内容（LF 换行，剔除 bracketed 结束标记）。 */
export function normalizeVimPasteText(text: string): string {
  return text.split(PASTE_END).join('').replace(/\r\n?/g, '\n');
}

/**
 * 生成安全粘贴的按键序列：ESC 回普通模式 → `:set paste` → 进入插入 → 文本 → ESC → `:set nopaste` → 回到插入。
 * 结束在插入模式，符合「在编辑中粘贴」的常见预期。
 */
export function buildVimSafePasteSequence(text: string): string {
  const body = normalizeVimPasteText(text);
  return `\x1b:set paste\r` + `i${body}` + `\x1b:set nopaste\r` + `i`;
}

/** 强特征：Vim 独有的模式行（nano/less 不会出现）。 */
const VIM_MODE_LINE = /^\s*--\s*(INSERT|VISUAL|SELECT|REPLACE|COMMAND|NORMAL)\s*--/i;

/** 弱特征：Vim 标尺/文件名行，需配合空行标记 `~` 一起判定。 */
const VIM_RULER_PATTERNS: RegExp[] = [
  /^\d+,\d+(?:-\d+)?\s+(All|Top|Bot|%)/,
  /^"[^"]+"\s+(?:\[Modified\]\s+)?\d+L?,?\s*\d*B?/,
  /^--\s*No Name\s*--/i,
];

/**
 * 从终端当前屏幕的行文本推断是不是 Vim（用于决定是否提供安全粘贴）。
 * 模式行命中即可确认；否则要同时命中标尺行与空行标记 `~`，避免误判 nano/less。
 */
export function looksLikeVimScreen(rows: readonly string[]): boolean {
  if (rows.some((row) => VIM_MODE_LINE.test(row))) {
    return true;
  }
  const hasRuler = rows.some((row) => VIM_RULER_PATTERNS.some((pattern) => pattern.test(row)));
  if (!hasRuler) {
    return false;
  }
  return rows.some((row) => row.trimStart().startsWith('~'));
}

/** 读取终端当前所有可见行文本。 */
export function readTerminalRows(term: XTerm): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
  }
  return rows;
}

/**
 * 是否处于「旧版 Vim 且未启用 bracketed paste」——此时多行粘贴会被 autoindent 污染，
 * 值得向用户提示并提供 `:set paste` 安全粘贴。
 */
export function isVimWithoutBracketedPaste(term: XTerm | null | undefined): boolean {
  if (!term) {
    return false;
  }
  if (term.modes.bracketedPasteMode) {
    return false;
  }
  if (term.buffer.active.type !== 'alternate') {
    return false;
  }
  return looksLikeVimScreen(readTerminalRows(term));
}
