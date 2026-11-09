import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  createProgressWrapState,
  guardCarriageReturnProgress,
  looksLikeProgressText,
  releaseProgressWrap,
  visibleTextWidth,
} from '../src/renderer/session/terminal/terminal-progress-wrap';

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));

function countNonemptyRows(term: Terminal): number {
  const buffer = term.buffer.active;
  let count = 0;
  for (let y = 0; y < buffer.length; y += 1) {
    if ((buffer.getLine(y)?.translateToString(true) || '').length > 0) {
      count += 1;
    }
  }
  return count;
}

describe('terminal-progress-wrap helpers', () => {
  it('computes visible width without ANSI escapes', () => {
    expect(visibleTextWidth('\x1b[32m24%|abc\x1b[0m')).toBe(7);
    expect(visibleTextWidth('\x1b[?25l')).toBe(0);
  });

  it('recognizes download progress text', () => {
    expect(looksLikeProgressText(' 24%|████████| 918M/3.72G [39:47<1:33:08, 543kB/s]')).toBe(true);
    expect(looksLikeProgressText('\x1b[32m 9%|███| 357M/3.72G [20:00<1:58:13, 511kB/s]\x1b[0m')).toBe(true);
    expect(looksLikeProgressText(' 9%|███| 10/20 [00:01<00:01, 12.3it/s]')).toBe(true);
    expect(looksLikeProgressText('normal output 100% complete')).toBe(false);
    expect(looksLikeProgressText('-rw-r--r-- 1 root root 1024 file.bin')).toBe(false);
  });

  it('disables autowrap after a bare CR progress segment and restores it at newline', () => {
    const state = createProgressWrapState();
    const chunk = `\r 24%|${'█'.repeat(100)}| 918M/3.72G [39:47, 543kB/s]`;
    const guarded = guardCarriageReturnProgress(chunk, state);
    expect(guarded.startsWith('\r\x1b[?7l')).toBe(true);
    expect(state.active).toBe(true);

    const ending = guardCarriageReturnProgress('\nnormal line\n', state);
    expect(ending.startsWith('\x1b[?7h\n')).toBe(true);
    expect(state.active).toBe(false);
  });

  it('leaves ordinary CRLF output untouched', () => {
    const state = createProgressWrapState();
    const chunk = 'first line\r\nsecond line\r\n';
    expect(guardCarriageReturnProgress(chunk, state)).toBe(chunk);
    expect(state.active).toBe(false);
  });

  it('leaves long non-progress lines to normal wrapping', () => {
    const state = createProgressWrapState();
    const chunk = `\r${'plain-command-'.repeat(10)}`;
    expect(guardCarriageReturnProgress(chunk, state)).toBe(chunk);
    expect(state.active).toBe(false);
  });
});

describe('terminal-progress-wrap with xterm', () => {
  it('keeps overlong CR progress on one row', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
    const state = createProgressWrapState();
    for (let i = 0; i < 20; i += 1) {
      const line = `\r 24%|${'█'.repeat(100)}| ${i}MB/3.72G [39:47<1:33:08, 543kB/s]`;
      term.write(guardCarriageReturnProgress(line, state));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    term.write(releaseProgressWrap(state));
    console.log('overlong nonempty rows:', countNonemptyRows(term));
    expect(countNonemptyRows(term)).toBe(1);
  });

  it('collapses a replayed block of overlong progress frames to one row', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
    const state = createProgressWrapState();
    let replay = '';
    for (let i = 0; i < 20; i += 1) {
      replay += `\r 24%|${'█'.repeat(100)}| ${i}MB/3.72G [39:47, 543kB/s]`;
    }
    replay += '\n';
    term.write(guardCarriageReturnProgress(replay, state));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(countNonemptyRows(term)).toBe(1);
  });

  it('restores normal wrapping for long output after progress', async () => {
    const term = new Terminal({ cols: 20, rows: 24, scrollback: 1000 });
    const state = createProgressWrapState();
    term.write(guardCarriageReturnProgress(`\r 24%|${'█'.repeat(40)}| 1MB/s\n`, state));
    await new Promise((resolve) => setTimeout(resolve, 0));
    term.write('B'.repeat(45));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(countNonemptyRows(term)).toBeGreaterThan(1);
  });
});

