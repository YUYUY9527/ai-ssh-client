import { describe, expect, it } from 'vitest';
import { extractKeyOutput, normalizeTerminalText, stripAnsi } from '../src/renderer/agent/runtime/text';

describe('agent runtime text helpers', () => {
  it('stripAnsi 去掉颜色与控制序列', () => {
    const input = '\u001b[31mred\u001b[0m plain';
    expect(stripAnsi(input)).toBe('red plain');
  });

  it('normalizeTerminalText 统一换行并去 NUL', () => {
    const input = 'a\r\nb\u0000\r\nc   \n';
    expect(normalizeTerminalText(input)).toBe('a\n\nb\n\nc\n');
  });

  it('extractKeyOutput 短文本原样返回', () => {
    expect(extractKeyOutput('hello', 100)).toBe('hello');
  });

  it('extractKeyOutput 超长时保留错误行与末尾行', () => {
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push(`line ${i}`);
    lines[5] = 'ERROR: disk full';
    const output = lines.join('\n');
    const result = extractKeyOutput(output, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain('ERROR: disk full');
    expect(result).toContain('line 199');
  });
});
