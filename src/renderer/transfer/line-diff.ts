export type DiffLineKind = 'equal' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  leftLine?: number;
  rightLine?: number;
}

export interface LineDiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
  truncated: boolean;
}

const MAX_LCS_CELLS = 400_000;

/**
 * 轻量按行 Diff 算法：
 * - 先裁掉公共前后缀降低计算量；
 * - 中间段用 LCS 精确对齐；超过阈值时安全降级为顺序块对比避免卡顿。
 */
export function computeLineDiff(beforeText: string, afterText: string): LineDiffResult {
  const left = String(beforeText ?? '').replace(/\r\n/g, '\n').split('\n');
  const right = String(afterText ?? '').replace(/\r\n/g, '\n').split('\n');

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let truncated = false;

  for (let i = 0; i < prefix; i += 1) {
    lines.push({ kind: 'equal', text: left[i], leftLine: i + 1, rightLine: i + 1 });
    unchanged += 1;
  }

  const midLeft = left.slice(prefix, left.length - suffix);
  const midRight = right.slice(prefix, right.length - suffix);

  if (midLeft.length * midRight.length <= MAX_LCS_CELLS) {
    const m = midLeft.length;
    const n = midRight.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midLeft[i] === midRight[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const across = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= across ? down : across;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midLeft[i] === midRight[j]) {
        lines.push({
          kind: 'equal',
          text: midLeft[i],
          leftLine: prefix + i + 1,
          rightLine: prefix + j + 1,
        });
        unchanged += 1;
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        lines.push({ kind: 'remove', text: midLeft[i], leftLine: prefix + i + 1 });
        removed += 1;
        i += 1;
      } else {
        lines.push({ kind: 'add', text: midRight[j], rightLine: prefix + j + 1 });
        added += 1;
        j += 1;
      }
    }
    while (i < m) {
      lines.push({ kind: 'remove', text: midLeft[i], leftLine: prefix + i + 1 });
      removed += 1;
      i += 1;
    }
    while (j < n) {
      lines.push({ kind: 'add', text: midRight[j], rightLine: prefix + j + 1 });
      added += 1;
      j += 1;
    }
  } else {
    truncated = true;
    for (let i = 0; i < midLeft.length; i += 1) {
      lines.push({ kind: 'remove', text: midLeft[i], leftLine: prefix + i + 1 });
      removed += 1;
    }
    for (let j = 0; j < midRight.length; j += 1) {
      lines.push({ kind: 'add', text: midRight[j], rightLine: prefix + j + 1 });
      added += 1;
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const lIdx = left.length - suffix + i;
    const rIdx = right.length - suffix + i;
    lines.push({ kind: 'equal', text: left[lIdx], leftLine: lIdx + 1, rightLine: rIdx + 1 });
    unchanged += 1;
  }

  return { lines, added, removed, unchanged, truncated };
}
