import { describe, expect, it } from 'vitest';
import {
  formatAgentAnswerForDisplay,
  normalizeAgentTerminalText,
} from '../src/renderer/agent/terminal-agent-chat';

/** 与实现一致的最小显示宽度（CJK/全角按 2 列），仅用于断言列对齐。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0x3000 && code <= 0x303e)
      ? 2
      : 1;
  }
  return width;
}

describe('formatAgentAnswerForDisplay', () => {
  it('把 Markdown 表格渲染成 CJK 宽度对齐的纯文本', () => {
    const input = [
      '当前主机共 4 个 Docker 容器：',
      '',
      '| 容器名 | 镜像 | 状态 | 端口 |',
      '| --- | --- | --- | --- |',
      '| magpie | ghcr.io/yetone/magpie:latest | Up 6 小时 (healthy) | 3425、3430 |',
      '| subapi-redis | redis:8-alpine | Exited (0) 2 小时前 | - |',
    ].join('\n');

    const output = formatAgentAnswerForDisplay(input);
    const lines = output.split('\n');
    // 不再保留竖线管道
    expect(output).not.toContain('|');
    // 表头 + 分隔线 + 数据行
    expect(lines[2]).toContain('容器名');
    expect(lines[3]).toMatch(/^-+/);
    expect(lines[4]).toContain('magpie');
    // 列对齐：表头与数据行第二列起点按显示宽度对齐（CJK 占 2 列，不能用字符索引比较）
    const headerPrefix = lines[2].slice(0, lines[2].indexOf('镜像'));
    const rowPrefix = lines[4].slice(0, lines[4].indexOf('ghcr.io'));
    expect(displayWidth(rowPrefix)).toBe(displayWidth(headerPrefix));
  });

  it('剥掉行内修饰符与标题井号，链接保留地址', () => {
    const output = formatAgentAnswerForDisplay('## 摘要\n这是**重点**，见 [文档](https://example.com/a)。');
    expect(output).toBe('摘要\n这是重点，见 文档 (https://example.com/a)。');
  });

  it('围栏代码块内容原样保留', () => {
    const output = formatAgentAnswerForDisplay('```\n| a | b |\n  spaced    line\n```');
    expect(output).toContain('| a | b |');
    expect(output).toContain('  spaced    line');
  });

  it('非标准表格（无分隔行）原样保留', () => {
    const input = '| a | b |\n| c | d |';
    expect(formatAgentAnswerForDisplay(input)).toBe(input);
  });
});

describe('normalizeAgentTerminalText 与表格', () => {
  it('保留表格列对齐空格，散文行照常折叠空白', () => {
    const table = [
      '| 容器名 | 状态 |',
      '| --- | --- |',
      '| magpie | Up 6 小时 |',
    ].join('\n');
    const output = normalizeAgentTerminalText(`说明文字：  多余   空格\n\n${table}`);
    const lines = output.split('\n');
    expect(lines[0]).toBe('说明文字： 多余 空格'); // 散文行折叠空白（即使含全角标点后跟 2+ 空格）
    expect(lines[0]).not.toContain('  ');
    expect(lines[4]).toMatch(/^magpie {2}Up/); // 表格列间保留至少两个空格
  });
});
