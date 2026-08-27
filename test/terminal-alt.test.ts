import { describe, it, expect } from 'vitest';
import {
  ALT_ENTER_SEQUENCE,
  detectLastAltSwitch,
  prepareWindowForReplay,
  scanAltScreenState,
} from '../src/renderer/session/terminal/terminal-alt';

describe('scanAltScreenState / detectLastAltSwitch', () => {
  it('空内容 / 无切换 → 非 alt / null', () => {
    expect(scanAltScreenState('')).toBe(false);
    expect(scanAltScreenState('$ echo hi\r\nhi\r\n$ ')).toBe(false);
    expect(detectLastAltSwitch('$ echo hi\r\n')).toBeNull();
  });

  it('进入后无退出 → alt', () => {
    expect(scanAltScreenState(`$ vim\r\n\x1b[?1049h`)).toBe(true);
    expect(detectLastAltSwitch(`$ vim\r\n\x1b[?1049h`)).toBe('h');
  });

  it('进入后退出 → 非 alt；多次切换取最后一次', () => {
    expect(scanAltScreenState(`\x1b[?1049h\x1b[?1049l`)).toBe(false);
    expect(scanAltScreenState(`\x1b[?1049l\x1b[?1049h`)).toBe(true);
    expect(detectLastAltSwitch(`\x1b[?1049l\x1b[?1049h`)).toBe('h');
  });

  it('兼容 1047 / 47 序列族', () => {
    expect(scanAltScreenState(`\x1b[?1047h`)).toBe(true);
    expect(scanAltScreenState(`\x1b[?47h`)).toBe(true);
    expect(scanAltScreenState(`\x1b[?47l`)).toBe(false);
  });
});

describe('prepareWindowForReplay', () => {
  it('未超限：原样返回', () => {
    const content = '$ echo hi\r\nhi\r\n$ ';
    expect(prepareWindowForReplay(content, 150 * 1024)).toBe(content);
  });

  it('超限且截断前在 alt、窗口内无切换 → 注入 1049h 头', () => {
    // 构造：头部 1049h + 大量行边界内容 + 尾部 alt 重绘增量（无切换）
    const head = `$ nano big\r\n\x1b[?1049h\x1b[1;32r\x1b[H`;
    const body = `${'\r\nLine xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.repeat(5000)}`;
    const tail = `\r\x1b[2dLine at top\x1b[3dLine two`;
    const content = head + body + tail;
    expect(content.length).toBeGreaterThan(150 * 1024);
    expect(scanAltScreenState(content)).toBe(true);

    const windowed = prepareWindowForReplay(content, 150 * 1024);
    expect(windowed.startsWith(ALT_ENTER_SEQUENCE)).toBe(true);
    // 窗口以完整行开始（行边界对齐后注入头在最前）
    expect(windowed.length).toBeLessThanOrEqual(150 * 1024 + ALT_ENTER_SEQUENCE.length);
  });

  it('超限但截断窗口内保留进入序列（内容中段重新进 alt）→ 不重复注入', () => {
    const head = `$ nano a\r\n\x1b[?1049h`;
    const body = `${'\r\nLine xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.repeat(200)}`;
    return expect((() => {
      const mid = `${head}${body}`;
      // 故意构造：窗口应包含一个二次进入序列
      const content = `${mid}\x1b[?1049h${body}${body}${body}${body}${body}`;
      const windowed = prepareWindowForReplay(content, 150 * 1024);
      // 窗口内 detectLastAltSwitch 非 null → 不注入
      return detectLastAltSwitch(windowed);
    })()).not.toBeNull();
  });

  it('超限且截断前不在 alt（普通 shell）→ 不注入', () => {
    const content = `${'echo line\r\n'.repeat(20000)}tail`;
    const windowed = prepareWindowForReplay(content, 150 * 1024);
    expect(windowed.startsWith(ALT_ENTER_SEQUENCE)).toBe(false);
    expect(scanAltScreenState(content)).toBe(false);
  });

  it('超限且截断窗口以退出序列结尾（曾在 alt 后退出）→ 不注入', () => {
    const head = `$ vim\r\n\x1b[?1049h`;
    const body = `${'\r\nLine xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.repeat(2000)}`;
    const content = `$ vim\r\n\x1b[?1049h${body}${body}${body}${body}\x1b[?1049l$ `;
    const windowed = prepareWindowForReplay(content, 150 * 1024);
    expect(scanAltScreenState(content)).toBe(false);
    expect(windowed.startsWith(ALT_ENTER_SEQUENCE)).toBe(false);
  });
});
