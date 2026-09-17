import { describe, it, expect } from 'vitest';
import {
  CLIPBOARD_PASTE_FALLBACK_MS,
  createClipboardPasteFallback,
  gateTerminalPaste,
  isMultiLinePaste,
  prepareTerminalPaste,
  resolvePasteConfirmation,
} from '../src/renderer/session/terminal/paste-safety';

/** 手动调度的定时器替身：只在测试显式 flush 时执行。 */
function createManualScheduler() {
  const tasks: { callback: () => void; delayMs: number; canceled: boolean }[] = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      tasks.push({ callback, delayMs, canceled: false });
      return tasks.length - 1;
    },
    flush() {
      for (const task of tasks.splice(0)) {
        task.callback();
      }
    },
    get delays() {
      return tasks.map((task) => task.delayMs);
    },
  };
}

describe('paste-safety', () => {
  it('sends single-line paste without confirmation', () => {
    expect(isMultiLinePaste('echo hello')).toBe(false);
    const single = gateTerminalPaste('echo hello');
    expect(single.action).toBe('send');
    expect(single.text).toBe('echo hello');
  });

  it('blocks multi-line paste with \\n for confirmation', () => {
    expect(isMultiLinePaste('line1\nline2')).toBe(true);
    const multiN = gateTerminalPaste('line1\nline2');
    expect(multiN.action).toBe('confirm');
    expect(multiN.previewText).toBe('line1\nline2');
    expect(multiN.preparedText).toBe('line1\rline2');
  });

  it('blocks multi-line paste with \\r for confirmation', () => {
    const multiR = gateTerminalPaste('a\rb');
    expect(multiR.action).toBe('confirm');
  });

  it('returns CR-normalized text when confirmed', () => {
    const confirmed = gateTerminalPaste('line1\r\nline2\nline3', true);
    expect(confirmed.action).toBe('send');
    expect(confirmed.text).toBe(prepareTerminalPaste('line1\r\nline2\nline3'));
    expect(confirmed.text).toBe('line1\rline2\rline3');
  });

  it('resolves paste confirmation', () => {
    const multiN = gateTerminalPaste('line1\nline2');
    expect(resolvePasteConfirmation(multiN.preparedText, false)).toBe('');
    expect(resolvePasteConfirmation(multiN.preparedText, true)).toBe(multiN.preparedText);
  });

  it('skips empty paste', () => {
    expect(gateTerminalPaste('').action).toBe('skip');
  });
});

describe('clipboard paste fallback', () => {
  it('uses the paste event alone when it arrives in time', () => {
    const scheduler = createManualScheduler();
    const fallback = createClipboardPasteFallback(scheduler.schedule);
    let sent = 0;

    // Ctrl+V：先安排兜底，随后原生 paste 事件把它作废 → 只粘贴一次。
    fallback.arm(() => { sent += 1; });
    expect(scheduler.delays).toEqual([CLIPBOARD_PASTE_FALLBACK_MS]);
    fallback.markHandled();
    scheduler.flush();

    expect(sent).toBe(0);
  });

  it('falls back to the clipboard when no paste event arrives', () => {
    const scheduler = createManualScheduler();
    const fallback = createClipboardPasteFallback(scheduler.schedule);
    let sent = 0;

    fallback.arm(() => { sent += 1; });
    scheduler.flush();

    expect(sent).toBe(1);
  });

  it('sends at most once per keystroke', () => {
    const scheduler = createManualScheduler();
    const fallback = createClipboardPasteFallback(scheduler.schedule);
    let sent = 0;

    // 第一次 Ctrl+V 收到 paste 事件、第二次没有：总计只应发送两次（1 次 paste + 1 次兜底）。
    fallback.arm(() => { sent += 1; });
    fallback.markHandled();
    fallback.arm(() => { sent += 1; });
    scheduler.flush();

    expect(sent).toBe(1);
  });

  it('cancels the fallback when the terminal instance is disposed', () => {
    const scheduler = createManualScheduler();
    const fallback = createClipboardPasteFallback(scheduler.schedule);
    let sent = 0;

    fallback.arm(() => { sent += 1; });
    fallback.cancel();
    scheduler.flush();

    expect(sent).toBe(0);
  });
});
