/**
 * 终端重放（replay）后的状态校准工具。
 *
 * 背景：store / server 输出缓冲超限时按行边界截断，重放 chunk 可能
 * 丢失 alt screen 进入序列（\x1b[?1049h）。此时 xterm 停留在 normal
 * buffer，vim / nano 等全屏程序的实际输出画在 scrollback 上——典型
 * 症状：右侧出现滚动条、向下滚动丢内容、画面定位错位、标题/状态栏/
 * 帮助栏（打开时绘制一次）全部丢失。
 *
 * 两个失稳场景：
 * 1) 截断窗口滑掉了唯一的 1049h 且窗口内无任何 alt 切换（nano 常见：
 *    1049h 只在打开时发一次）→ chunk 中无进入序列，xterm 停在 normal；
 * 2) 窗口尾部最后一次切换是"进入"（vim 场景）→ chunk 以 1049h 结尾，
 *    xterm 同样未处于 alt。
 *
 * 修复：结合"重放后 xterm 状态"与"重放前 xterm 状态"：
 * - chunk 尾部为进入 alt（场景 2）→ 按重放后状态补 1049h + Ctrl+L；
 * - chunk 无任何切换、但重放前 xterm 已在 alt（场景 1）→ 补 1049h +
 *   Ctrl+L 重绘（nano 对 Ctrl+L 全屏重绘，可完整重建标题/帮助栏）。
 */
import { detectLastAltSwitch, scanAltScreenState } from './terminal-alt';

/** 兼容旧导出：chunk 尾部最后一次切换是否为"进入 alt"。 */
export function detectChunkEndsInAltScreen(chunk: string): boolean {
  return scanAltScreenState(chunk);
}

/**
 * 计算重放后需要的校准动作：
 * - `write`：需要补写进 xterm 的序列（xterm 未处于 alt buffer 时补 1049h）
 * - `redraw`：是否应向 PTY 发送 Ctrl+L（\x0c）让全屏程序重绘画面
 *
 * @param chunk 重放写入 xterm 的完整输出
 * @param xtermInAlternateScreen 重放后 xterm 是否处于 alt screen
 * @param wasInAlternateScreen 重放前 xterm 是否处于 alt screen
 *   （term.reset() 之前捕获；截断窗口滑掉 1049h 时用于判断远端还在全屏模式）
 */
export function planReplayCalibration(
  chunk: string,
  xtermInAlternateScreen: boolean,
  wasInAlternateScreen = false,
): { write: string; redraw: boolean } {
  // chunk 尾部为"进入 alt"：远端确实在全屏模式，xterm 未必在 → 按状态补头
  if (scanAltScreenState(chunk)) {
    return {
      write: xtermInAlternateScreen ? '' : '\x1b[?1049h',
      redraw: true,
    };
  }

  // chunk 无任何 alt 切换（截断窗口滑掉了唯一的 1049h）：若重放前 xterm
  // 已在 alt，说明远端仍在全屏模式 → 补头 + 让远端 Ctrl+L 全屏重绘。
  if (detectLastAltSwitch(chunk) === null && wasInAlternateScreen) {
    return { write: '\x1b[?1049h', redraw: true };
  }

  return { write: '', redraw: false };
}
