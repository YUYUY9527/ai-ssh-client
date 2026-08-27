import {
  ALT_ENTER_SEQUENCE,
  continuationOffset,
  pendingEscapeAtEnd,
} from './terminal-alt';

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
 *
 * 追加路径的第二个坑：xterm 尾部可能悬挂未完成的转义序列（WS/PTY 帧把
 * `\x1b[18;1H` 切成前帧 `\x1b` + 后帧 `[18;1H`；滑动对齐又把 `\x1b[18;1H`
 * 切开成 prev 尾 `\x1b` + delta 首 `[18;1H`）。若注入头直接插在 delta 前，
 * xterm 会丢弃挂起的 ESC 去解析 1049h，裸残片 `[18;1H` 被当文本打印 →
 * 行号与内容重叠粘连。注入头必须插在续接序列完成之后（见 continuationOffset）。
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
  const resolved = deltaAfterBoundedSlideDetailed(previous, current, maxSlide);
  return resolved === null ? null : resolved.delta;
}

/**
 * 同 deltaAfterBoundedSlide，额外返回 `kept`（previous 中被保留并已渲染的部分
 * 长度）。调用方需据此判断 xterm 末尾是否有悬挂转义序列，从而决定注入头
 * （1049h）应插入的位置，避免打断跨帧续接的转义序列（行号粘连根因）。
 */
export function deltaAfterBoundedSlideDetailed(
  previous: string,
  current: string,
  maxSlide: number = MAX_SLIDE_PROBE,
): { delta: string; kept: number } | null {
  if (current === previous) {
    return { delta: '', kept: previous.length };
  }
  if (!previous) {
    return { delta: current, kept: 0 };
  }
  if (!current) {
    return null;
  }
  if (current.startsWith(previous)) {
    return { delta: current.slice(previous.length), kept: previous.length };
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
      // 滑动对齐可能把转义序列拦腰切开：prev 尾（已渲染）以悬挂 ESC 结尾，
      // current 续接处是裸字节（如 `[18;1H`）。xterm 处于等待续接状态时，
      // 给 delta 补回 ESC 前缀让 xterm 收完整序列；无悬挂时原样返回。
      let delta = current.slice(kept);
      if (kept - 1 >= 0 && previous[kept - 1] === '\x1b'
        && delta[0] && delta[0] !== '\x1b') {
        delta = `\x1b${delta}`;
      }
      return { delta, kept };
    }
  }

  return null;
}

/**
 * 组装追加 chunk：注入头（如 1049h 状态头）不能打断 xterm 尾部的悬挂转义
 * 序列续接。若已渲染前缀末尾有未完成的转义序列（WS/PTY 帧把 `\x1b[18;1H`
 * 切成前帧 `\x1b` + 后帧 `[18;1H`），xterm 正处于"等待续接"状态，此时直接
 * 在 delta 前注入新序列会让 xterm 丢弃挂起的 ESC、把裸字节当文本绘制
 * （行号/内容重叠粘连）。注入头须插在续接序列完成之后。
 */
function assembleAppendChunk(
  delta: string,
  prevStripped: string,
  head: string,
): string {
  if (!head) {
    return delta;
  }
  // prev 尾部若存在未闭合的转义序列（xterm 处于等待续接状态），
  // 注入头必须插在续接序列完成之后，否则 xterm 丢弃挂起的 ESC、
  // 把裸续接字节当文本绘制（行号粘连）。注意：kept 是滑动对齐的
  // 保留长度，但悬挂 ESC 可能恰好在 kept 边界附近（prev 尾部），
  // 因此用完整 prevStripped 检测尾部悬挂。
  const pendingEsc = pendingEscapeAtEnd(prevStripped);
  if (pendingEsc < 0) {
    // xterm 尾部干净 → 头插最前即可。
    return `${head}${delta}`;
  }
  const offset = continuationOffset(delta, pendingEsc, prevStripped);
  if (offset > 0 && offset <= delta.length) {
    // 续接序列完成点之后插入头：xterm 先收完 `\x1b[18;1H` 再收 1049h。
    return `${delta.slice(0, offset)}${head}${delta.slice(offset)}`;
  }
  // delta 本身还只是续接序列的一部分（尚未完成）：此时插入任何序列都会
  // 毁掉续接 → 先跳过注入头，等下一轮续接完成后再补（头语义不变）。
  return delta;
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

  const resolved = deltaAfterBoundedSlideDetailed(prevStripped, currStripped);
  if (resolved === null) {
    // 内容窗口无法对齐（store 头部截断后旧尾新头混合）：
    // 只对齐水位会让 xterm 与 store 从此错位，后续 append 按截断视角计算，
    // vim 大文件滚动时画面缺行、内容丢失。改走 replay 全量重建，
    // xterm 与 store 严格一致（OSC/CSI 查询应答死循环已由输入挂起机制拦截）。
    return { action: 'replay', chunk: currentOutput };
  }
  if (!resolved.delta) {
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
  const chunk = assembleAppendChunk(
    resolved.delta,
    prevStripped,
    head,
  );
  return { action: 'append', chunk };
}
