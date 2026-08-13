/**
 * 终端重放（replay）后的状态校准工具。
 *
 * 背景：store / server 输出缓冲超限时按行边界截断，重放 chunk 可能
 * 丢失 alt screen 进入序列（\x1b[?1049h）。此时 xterm 停留在 normal
 * buffer，vim 等全屏程序的实际输出画在 scrollback 上——典型症状：
 * 右侧出现滚动条、向下滚动丢内容。
 */

/**
 * 扫描输出 chunk 中最后一次 alt screen 切换序列（\x1b[?1049h/l）。
 * 返回 chunk 是否以"进入 alt screen"结尾，即远端程序（vim 等）
 * 是否正运行在全屏模式。
 */
export function detectChunkEndsInAltScreen(chunk: string): boolean {
  if (!chunk) {
    return false;
  }
  let last: 'h' | 'l' | null = null;
  const re = /\x1b\[\?1049([hl])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    last = match[1] as 'h' | 'l';
  }
  return last === 'h';
}

/**
 * 计算重放后需要的校准动作：
 * - `write`：需要补写进 xterm 的序列（xterm 未处于 alt buffer 时补 1049h）
 * - `redraw`：是否应向 PTY 发送 Ctrl+L（\x0c）让全屏程序重绘画面
 */
export function planReplayCalibration(
  chunk: string,
  xtermInAlternateScreen: boolean,
): { write: string; redraw: boolean } {
  if (!detectChunkEndsInAltScreen(chunk)) {
    return { write: '', redraw: false };
  }
  return {
    write: xtermInAlternateScreen ? '' : '\x1b[?1049h',
    redraw: true,
  };
}
