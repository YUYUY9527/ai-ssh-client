// 剥离 Agent sentinel 留下的视觉痕迹。
//
// Agent 写入 shell 的每条命令会被包装成:
//   <cmd>; printf '\n__AGENT_DONE_<runId>__:%s\n' "$?"
// 这条命令会产生两处"调试痕迹":
//   1. shell 自身对输入的回显: `; printf '\n__AGENT_DONE_<runId>__:%s\n' "$?"`
//   2. printf 实际输出的结束行: `__AGENT_DONE_<runId>__:<exitCode>`
//
// 这两处都不应出现在用户可见的终端里。数据按任意块到达,匹配点可能跨越多个块,
// 因此我们维护一个 buffer,只有"这一段不可能在构成 sentinel"时才 flush 出去。

// 命令回显:`); printf '\n<MARKER>:%s\n' "$?"`。这里的 \n 是字面 2 个字符(反斜杠+n)。
// 原命令被包在 `(cmd)` 子 shell 里,所以回显里 printf 前面是 `);`。
const ECHO_PATTERN = /\);\s*printf\s+'\\n__AGENT_DONE_\S+?__:%s\\n'\s+"\$\?"/g;
// 输出标记:必须等 printf 的结束换行到达后才剥离,否则会把退出码的数字误留下。
// 只吃自身这一行,不消耗前一行的换行,避免把前一行内容和 shell 提示符粘到一起。
const MARKER_PATTERN = /__AGENT_DONE_\S+?__:[^\r\n]*\r?\n/g;

// 只保留可能正在构成 sentinel 的最短尾部即可。最长 sentinel 大约是:
//   `; printf '\n__AGENT_DONE_<runId-~40>__:%s\n' "$?"` ≈ 80 字节
// 外加输出行 `__AGENT_DONE_<runId>__:<exit>` ≈ 60 字节。
// 给一倍余量。
const MAX_HOLDBACK_BYTES = 200;

// 疑似部分匹配的尾部特征:sentinel 标记前缀、printf 回显前缀。
// 用非贪婪的渐进式匹配,尽量让 match 落在最后一次疑似开头上。
// echo 分支从 `)` 开始(子 shell 结束后可能接 `; printf ...`)。
// sentinel 分支允许尾部出现 `\r`(等待 `\n`),避免 `__AGENT_DONE_x__:0\r` 在 `\n` 还没到的那一瞬间被误 flush。
const PARTIAL_TAIL_RE = new RegExp(
  [
    // sentinel 标记的前缀渐进匹配:从双下划线 `__` 开始(单个 `_` 太常见,不能 hold)
    '__(?:_|A(?:G(?:E(?:N(?:T(?:_(?:D(?:O(?:N(?:E(?:_[^\\n]*)?)?)?)?)?)?)?)?)?)?)?$',
    // 命令回显前缀:从 `);` 开始(单独的 `)` 太常见),后面可选 `printf ...` 的渐进部分
    '\\);\\s*(?:p(?:r(?:i(?:n(?:t(?:f[\\s\\S]*)?)?)?)?)?)?$',
  ].join('|'),
);

export interface SentinelStripper {
  feed: (chunk: string) => string;
  flush: () => string;
}

export function createSentinelStripper(): SentinelStripper {
  let buffer = '';

  const emitSafePrefix = (): string => {
    // 1. 剥完整匹配
    buffer = buffer.replace(ECHO_PATTERN, '').replace(MARKER_PATTERN, '');

    // 2. 找出末尾有没有疑似"还没到完整匹配"的前缀
    // 只检查 buffer 的最后一小段,避免 O(n) 正则扫描代价
    const scanFrom = Math.max(0, buffer.length - MAX_HOLDBACK_BYTES);
    const tail = buffer.slice(scanFrom);
    const match = PARTIAL_TAIL_RE.exec(tail);

    if (match) {
      const partialStart = scanFrom + match.index;
      const emit = buffer.slice(0, partialStart);
      buffer = buffer.slice(partialStart);
      return emit;
    }

    // 尾部没有嫌疑:立刻全部 flush。
    // 这里不再保留任何"滚动尾部",否则用户的逐字符输入回显(1 字节)会被积压,
    // 直到下一次有大量字节才吐出,看起来像是"输入没回显"。
    const emit = buffer;
    buffer = '';
    return emit;
  };

  const feed = (chunk: string): string => {
    if (!chunk) return '';
    buffer += chunk;
    return emitSafePrefix();
  };

  const flush = (): string => {
    const out = buffer.replace(ECHO_PATTERN, '').replace(MARKER_PATTERN, '');
    buffer = '';
    return out;
  };

  return { feed, flush };
}
