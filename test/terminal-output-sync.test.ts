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
});
