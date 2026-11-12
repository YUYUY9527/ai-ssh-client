/**
 * 轻量行级 unified diff（无外部依赖，前后端通用）。
 *
 * 只用于「写文件前给用户看改动」，不追求完整 git 语义：基于最长公共子序列（LCS）
 * 生成 hunk，默认 3 行上下文。超大文件由调用方先截断，避免 O(n*m) 过大。
 */

export interface DiffHunkLine {
  type: 'context' | 'add' | 'del';
  text: string;
}

export interface UnifiedDiffResult {
  /** 是否有差异。 */
  changed: boolean;
  /** 形如 `--- a/<path>` / `+++ b/<path>` 的文本块。 */
  text: string;
}

const MAX_DIFF_INPUT_LINES = 8000;

function splitLines(source: string): string[] {
  // 保留行内容，统一去掉句尾 \r，避免 CRLF 造成的伪差异。
  return source.replace(/\r\n/g, '\n').split('\n');
}

function buildLcsMatrix(a: string[], b: string[]): number[][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

/** 生成原始行级操作序列（未加 hunk 头）。 */
export function diffLines(oldText: string, newText: string): DiffHunkLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_DIFF_INPUT_LINES || b.length > MAX_DIFF_INPUT_LINES) {
    return [
      { type: 'del', text: `[文件过大，仅显示摘要：原 ${a.length} 行]` },
      { type: 'add', text: `[新 ${b.length} 行]` },
    ];
  }
  const matrix = buildLcsMatrix(a, b);
  const out: DiffHunkLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i] });
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return out;
}

/**
 * 生成带 `--- a/<path>` / `+++ b/<path>` 头的 unified diff 文本。
 * `contextLines` 控制每个变更片段前后保留的上下文行数。
 */
export function unifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3,
): UnifiedDiffResult {
  const lines = diffLines(oldText, newText);
  if (!lines.some((line) => line.type !== 'context')) {
    return { changed: false, text: '' };
  }

  const header = [`--- a/${path}`, `+++ b/${path}`];
  const body: string[] = [];

  // 收集需要输出的行索引（变更行 ± contextLines）。
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'context') return;
    for (let k = Math.max(0, index - contextLines); k <= Math.min(lines.length - 1, index + contextLines); k += 1) {
      keep[k] = true;
    }
  });

  let index = 0;
  while (index < lines.length) {
    if (!keep[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && keep[index]) index += 1;
    const slice = lines.slice(start, index);
    const oldCount = slice.filter((line) => line.type !== 'add').length;
    const newCount = slice.filter((line) => line.type !== 'del').length;
    body.push(`@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`);
    for (const line of slice) {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      body.push(`${prefix}${line.text}`);
    }
  }

  return { changed: true, text: [...header, ...body].join('\n') };
}
