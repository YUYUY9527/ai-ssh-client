/**
 * 计算 session 输出字符串相对已渲染前缀的增量策略。
 *
 * 全量 clear+rewrite 会让 xterm 重解析历史 OSC/CSI 查询并再次 onData 应答，
 * 应答经 PTY 回显后再写入 store → 截断 → 再次回放，形成死循环刷屏
 *（典型症状：无限刷 `11;rgb:0606/0b0b/1010`）。
 *
 * 注意：store / server 截断时会注入 \x1b[?1049h 头（见 terminal-alt
 * prepareWindowForReplay，保 alt screen 状态）。该头部是"状态元数据"，
 * 每次截断都会滑落旧头、注入新头（位置随窗口变化），若直接参与滑动对齐，
 * 已渲染窗口与新窗口永远对不齐 → 无限 replay + 校准 Ctrl+L → nano 重绘
 * 回流 → 再截断再注入 → 再对不齐 → replay 死循环（症状：周期性重放、
 * 行号/内容重叠错位、帮助栏消失）。对齐时须先把注入头剥离后再比较，
 * 追加增量时按头部差异补写（xterm 缺头一次补齐 / 头消失走 replay 收敛）。
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
 * store/server 截断时可能注入 \x1b[?1049h 状态头（prepareWindowForReplay）。
 * 该头每次截断位置都会变化：若参与对齐，已渲染窗口与新窗口永远对不齐，
 * 触发无限 replay + Ctrl+L 校准循环（nano 行号错位、帮助栏消失）。
 * 对齐时识别并剥离它，仅对"内容窗口"做滑动比较；
 * delta 返回时再把头部差异作为增量的一部分补回。
 */
const ALT_ENTER_SEQUENCE = '\x1b[?1049h';

/** 剥离一个前导的 \x1b[?1049h 注入头。无注入头时原样返回。 */
function stripAltEnterHeader(content: string): string {
  return content.startsWith(ALT_ENTER_SEQUENCE)
    ? content.slice(ALT_ENTER_SEQUENCE.length)
    : content;
}

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

  // 剥离各自的前导注入头后再比较：注入头是"状态元数据"，每次截断都会
  // 滑落旧头、注入新头（位置随窗口变化），直接比较必然对不齐。
  // 头差异不构成内容增量：追加路径会按缺头情况补写头，而不是全量重放。
  const prevStripped = stripAltEnterHeader(previousOutput);
  const currStripped = stripAltEnterHeader(currentOutput);

  const delta = deltaAfterBoundedSlide(prevStripped, currStripped);
  if (delta === null) {
    // 内容窗口无法对齐（store 头部截断后旧尾新头混合）：
    // 只对齐水位会让 xterm 与 store 从此错位，后续 append 按截断视角计算，
    // vim 大文件滚动时画面缺行、内容丢失。改走 replay 全量重建，
    // xterm 与 store 严格一致（OSC/CSI 查询应答死循环已由输入挂起机制拦截）。
    return { action: 'replay', chunk: currentOutput };
  }
  if (!delta) {
    // 内容无增量（仅注入头位置变化）：无内容变化 → 不动作，
    // 避免截断→注入头→对不齐→replay→Ctrl+L→… 的无限循环。
    return { action: 'noop' };
  }
  // 前缀注入头位置不一致时补写头，保证 xterm 状态与 store 一致：
  // - 旧窗口无头、新窗口有头（首次进入 alt 后超限）→ 补头；
  // - 旧窗口有头、新窗口无头 → 不补（内容对齐保留，头已滑落，无碍）。
  const head = prevStripped.length !== previousOutput.length
    ? '' // 旧窗口已渲染了头 → 内容增量即可，头无需重复
    : currStripped.length !== currentOutput.length
      ? ALT_ENTER_SEQUENCE
      : '';
  return { action: 'append', chunk: `${head}${delta}` };
}
