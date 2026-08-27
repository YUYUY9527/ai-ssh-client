import { describe, expect, it } from 'vitest';
import {
  deltaAfterBoundedSlide,
  planTerminalOutputSync,
} from '../src/renderer/session/terminal/terminal-output-sync';

describe('terminal-output-sync', () => {
  it('appends when current extends previous', () => {
    expect(planTerminalOutputSync('hello', 'hello world')).toEqual({
      action: 'append',
      chunk: ' world',
    });
  });

  it('replays on first paint', () => {
    expect(planTerminalOutputSync('', 'boot\n')).toEqual({
      action: 'replay',
      chunk: 'boot\n',
    });
  });

  it('replays empty when output cleared', () => {
    expect(planTerminalOutputSync('old', '')).toEqual({
      action: 'replay',
      chunk: '',
    });
  });

  it('recovers delta after head truncation at capacity', () => {
    const previous = 'AAAAAAAAAA';
    const current = 'AAAAAAAAAB';
    expect(deltaAfterBoundedSlide(previous, current)).toBe('B');
    expect(planTerminalOutputSync(previous, current)).toEqual({
      action: 'append',
      chunk: 'B',
    });
  });

  it('recovers multi-byte slide after truncation', () => {
    const previous = 'XXXXYYYYYY';
    const current = 'XXYYYYYYZZ';
    expect(deltaAfterBoundedSlide(previous, current)).toBe('ZZ');
    expect(planTerminalOutputSync(previous, current)).toEqual({
      action: 'append',
      chunk: 'ZZ',
    });
  });

  it('replays when buffers share no slide alignment', () => {
    expect(deltaAfterBoundedSlide('alpha-only', 'zeta-only')).toBeNull();
    expect(planTerminalOutputSync('alpha-only', 'zeta-only')).toEqual({
      action: 'replay',
      chunk: 'zeta-only',
    });
  });

  it('replays when truncation mixes tail and new head', () => {
    // 截断 + 头部插入导致字节流无法滑动对齐时，必须全量重建避免水位错位丢内容
    expect(planTerminalOutputSync('AAABBBCCCDDD', 'XXCCCDDDYYY')).toEqual({
      action: 'replay',
      chunk: 'XXCCCDDDYYY',
    });
  });

  it('noops when unchanged', () => {
    expect(planTerminalOutputSync('same', 'same')).toEqual({ action: 'noop' });
  });

  it('注入头位置变化不构成内容增量：无内容变化时 noop，不再触发 replay', () => {
    // 上一轮 store 窗口含注入头（rendered 已同步），新一轮截断又注入新头，
    // 但内容窗口完全一致 → 应 noop（否则 replay→Ctrl+L→重绘→再截断→…死循环）
    const content = '$ nano big\r\n\x1b[?1049h\x1b[2dLine one\r\x1b[3dLine two';
    const windowed = `\x1b[?1049h${content}`;
    expect(planTerminalOutputSync(content, windowed)).toEqual({ action: 'noop' });
  });

  it('旧窗口无头、新窗口注入头 + 内容增量 → 补写入头后 append 增量', () => {
    // prev：完整流（无前导注入头，头在流中部）；curr：超限截断窗口（注入头 + 尾部）
    const prev = 'a$ nano big\r\n\x1b[?1049h\x1b[2dLine 1\r\x1b[3dLine 2';
    const curr = `\x1b[?1049h\x1b[2dLine 1\r\x1b[3dLine 2\r\x1b[4dLine 3\recursed`;
    // 头部剥离后：prevStripped = prev（天然头不在前导），currStripped 以内容开始；
    // 追加路径应补写注入头，避免 xterm 停在 normal buffer。
    expect(planTerminalOutputSync(prev, curr)).toEqual({
      action: 'append',
      chunk: `\x1b[?1049h\r\x1b[4dLine 3\recursed`,
    });
  });

  it('旧窗口已含注入头 → 后续截断增量直接 append，不再 replay（防循环关键）', () => {
    // 模拟真实循环：第 2 次截断后 prev 已经有头，本轮 curr 又有新头，
    // 内容增量应 append（含 delta），而不是走上 replay。
    const base = '$ nano big\r\n\x1b[?1049h\x1b[2dLine 1\r\x1b[3dLine 2';
    const prevWindow = `\x1b[?1049h${base}`;
    const currWindow = `\x1b[?1049h${base}\r\x1b[4dLine 3\recursed`;
    expect(planTerminalOutputSync(prevWindow, currWindow)).toEqual({
      action: 'append',
      chunk: '\r\x1b[4dLine 3\recursed',
    });
  });

  it('内容窗口真对不齐（旧尾新头混合）仍走 replay 全量重建', () => {
    const prev = `\x1b[?1049hAAAABBBB`;
    const curr = `\x1b[?1049hCCCCDDDD`;
    expect(planTerminalOutputSync(prev, curr)).toEqual({
      action: 'replay',
      chunk: curr,
    });
  });
});
