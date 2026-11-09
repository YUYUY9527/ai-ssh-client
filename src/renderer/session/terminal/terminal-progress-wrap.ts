/**
 * 进度条换行保护。
 *
 * 下载工具（tqdm / wget / curl）用 `\r` 回到行首原地刷新进度。若进度行比终端
 * 当前列数宽一点点（典型场景：下载开始后窗口变窄或打开侧栏，工具仍按旧宽度绘制），
 * xterm 会先软换行，随后每帧 `\r` 都落在新的一行上，屏幕被同一进度无限刷屏。
 *
 * 这里只对“看起来像进度条、且跟在裸 \r 后面”的文本临时关闭自动换行（DECAWM
 * `\x1b[?7l`），遇到换行或空闲后恢复 `\x1b[?7h`。这样超宽进度会按终端宽度裁切在
 * 一行内原地刷新，普通长行输出仍然正常折行，不改变任何数据。
 */

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 可见字符宽度（忽略 ANSI 控制序列与控制字符；进度文本都是单宽字符）。 */
export function visibleTextWidth(text: string): number {
  return text.replace(ANSI_ESCAPE_RE, '').replace(/[\x00-\x1f\x7f]/g, '').length;
}

/** 是否像下载/任务进度条文本（例如 `24%|████| 918M/3.72G [39:47, 543kB/s]`）。 */
export function looksLikeProgressText(text: string): boolean {
  const plain = text.replace(ANSI_ESCAPE_RE, '');
  if (!/\d{1,3}(?:\.\d+)?%/.test(plain)) {
    return false;
  }
  return plain.includes('|') || /\d+(?:\.\d+)?\s*[kKMGT]?B\/s/.test(plain) || /\d+(?:\.\d+)?\s*it\/s/.test(plain);
}

export interface ProgressWrapState {
  /** 当前是否已经为本轮进度写入了 `\x1b[?7l`，等待恢复。 */
  active: boolean;
}

export function createProgressWrapState(): ProgressWrapState {
  return { active: false };
}

/**
 * 给一段终端输出注入自动换行开关。返回可直接 `term.write` 的文本；调用方在
 * `state.active` 为 true 且本段没有换行时，应安排一个定时器稍后写入 `\x1b[?7h`。
 */
export function guardCarriageReturnProgress(
  chunk: string,
  state: ProgressWrapState,
): string {
  if (!chunk) {
    return chunk;
  }

  const parts = chunk.split(/(\r\n|\r|\n)/);
  let output = '';

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index % 2 === 1) {
      // 分隔符：遇到换行就结束本轮进度保护。
      if (part.includes('\n') && state.active) {
        output += '\x1b[?7h';
        state.active = false;
      }
      output += part;
      continue;
    }
    if (!part) {
      continue;
    }

    const previousDelimiter = index > 0 ? parts[index - 1] : '';
    const afterBareCarriageReturn = previousDelimiter === '\r';
    const shouldGuard = state.active
      ? looksLikeProgressText(part)
      : afterBareCarriageReturn && looksLikeProgressText(part);

    if (shouldGuard && !state.active) {
      output += '\x1b[?7l';
      state.active = true;
    }
    output += part;
  }

  return output;
}

/** 恢复自动换行，返回需要写入的控制序列（未激活时返回空串）。 */
export function releaseProgressWrap(state: ProgressWrapState): string {
  if (!state.active) {
    return '';
  }
  state.active = false;
  return '\x1b[?7h';
}
