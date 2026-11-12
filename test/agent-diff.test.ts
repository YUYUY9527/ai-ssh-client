import { describe, expect, it } from 'vitest';
import { diffLines, unifiedDiff } from '../src/shared/agent-diff';

describe('agent diff', () => {
  it('无差异时 changed=false 且文本为空', () => {
    expect(unifiedDiff('/tmp/a.txt', 'a\nb\n', 'a\nb\n')).toEqual({ changed: false, text: '' });
  });

  it('标出新增/删除行', () => {
    const result = unifiedDiff('/tmp/a.txt', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(result.changed).toBe(true);
    expect(result.text).toContain('--- a//tmp/a.txt');
    expect(result.text).toContain('+++ b//tmp/a.txt');
    expect(result.text).toContain('-b');
    expect(result.text).toContain('+B');
    expect(result.text).toContain('+d');
  });

  it('diffLines 处理 CRLF 不产生伪差异', () => {
    const lines = diffLines('a\r\nb\r\n', 'a\nb\n');
    expect(lines.every((line) => line.type === 'context')).toBe(true);
  });

  it('超大输入退化为摘要', () => {
    const big = Array.from({ length: 8001 }, (_, index) => `line-${index}`).join('\n');
    const lines = diffLines(big, 'short');
    expect(lines[0].text).toContain('文件过大');
  });
});
