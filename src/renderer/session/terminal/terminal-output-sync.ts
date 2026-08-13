/**
 * 计算 session 输出字符串相对已渲染前缀的增量策略。
 *
 * 全量 clear+rewrite 会让 xterm 重解析历史 OSC/CSI 查询并再次 onData 应答，
 * 应答经 PTY 回显后再写入 store → 截断 → 再次回放，形成死循环刷屏
 *（典型症状：无限刷 `11;rgb:0606/0b0b/1010`）。
 */

export type TerminalOutputSyncPlan =
  | { action: 'noop' }
  | { action: 'append'; chunk: string }
  | { action: 'replay'; chunk: string };

/** 单次追赶的最大滑动字节，防止截断对齐时 O(n²) 扫整段 scrollback。 */
const MAX_SLIDE_PROBE = 1024 * 1024;
/** 滑动探测最大尝试次数：超过即放弃对齐走 replay，避免不可对齐时 O(n²) 卡死。 */
const MAX_SLIDE_TRIES = 128 * 1024;

/**
 * store 在 maxBytes 处头部截断后：
 * current === previous.slice(slide) + delta
 * 返回应写入 xterm 的 delta；无法对齐时返回 null。
 */
export function deltaAfterBoundedSlide(
  previous: string,
  current: string,
  maxSlide: number = MAX_SLIDE_PROBE,
): string | null {
  if (current === previous) {
    return '';
  }
  if (!previous) {
    return current;
  }
  if (!current) {
    return null;
  }
  if (current.startsWith(previous)) {
    return current.slice(previous.length);
  }

  // previous 被从头部滑掉 slide 字节后再接上新尾部（kept 必须 >0，全量替换走 replay）
  const maxK = Math.min(previous.length - 1, maxSlide);
  const slideLimit = Math.min(maxK, MAX_SLIDE_TRIES);
  for (let slide = 1; slide <= slideLimit; slide += 1) {
    const kept = previous.length - slide;
    if (kept <= 0 || kept > current.length) {
      continue;
    }
    if (previous.slice(slide) === current.slice(0, kept)) {
      return current.slice(kept);
    }
  }

  return null;
}

/** 根据已渲染前缀与最新 store 输出，决定如何喂给 xterm。 */
export function planTerminalOutputSync(
  previousOutput: string,
  currentOutput: string,
): TerminalOutputSyncPlan {
  if (currentOutput === previousOutput) {
    return { action: 'noop' };
  }

  if (!currentOutput) {
    return { action: 'replay', chunk: '' };
  }

  if (!previousOutput) {
    return { action: 'replay', chunk: currentOutput };
  }

  const delta = deltaAfterBoundedSlide(previousOutput, currentOutput);
  if (delta === null || !delta) {
    // 无法对齐（store 头部截断后旧尾新头混合）：
    // 只对齐水位会让 xterm 与 store 从此错位，后续 append 按截断视角计算，
    // vim 大文件滚动时画面缺行、内容丢失。改走 replay 全量重建，
    // xterm 与 store 严格一致（OSC/CSI 查询应答死循环已由输入挂起机制拦截）。
    return { action: 'replay', chunk: currentOutput };
  }
  return { action: 'append', chunk: delta };
}
