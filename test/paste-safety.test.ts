import { describe, it, expect } from 'vitest';
import {
  CLIPBOARD_PASTE_FALLBACK_MS,
  createClipboardPasteFallback,
  gateTerminalPaste,
  isMultiLinePaste,
  prepareTerminalPaste,
  resolvePasteConfirmation,
  trackPastedInput,
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

describe('trackPastedInput — 粘贴文本不得丢失', () => {
  /**
   * 真实回归：粘贴「Portainer Agent」后再手打「是什么」并回车，`@ai` 只收到「是什么」。
   * 原因是粘贴被浏览器 paste 事件拦截后直接下发远端 shell，绕过了输入行追踪。
   */
  it('单行粘贴并入当前输入行', () => {
    expect(trackPastedInput({ input: '', reliable: true }, 'Portainer Agent'))
      .toEqual({ input: 'Portainer Agent', reliable: true });
    expect(trackPastedInput({ input: 'Portainer Agent', reliable: true }, '是什么'))
      .toEqual({ input: 'Portainer Agent是什么', reliable: true });
  });

  it('已有键入内容时接在后面', () => {
    expect(trackPastedInput({ input: 'grep ', reliable: true }, 'error /var/log/syslog'))
      .toEqual({ input: 'grep error /var/log/syslog', reliable: true });
  });

  it('含换行的粘贴会被远端执行，视为已提交（清空并标记不可靠）', () => {
    expect(trackPastedInput({ input: 'ls', reliable: true }, 'cmd1\ncmd2'))
      .toEqual({ input: '', reliable: false });
    expect(trackPastedInput({ input: 'ls', reliable: true }, 'cmd\r'))
      .toEqual({ input: '', reliable: false });
  });

  it('追踪已不可靠（用过 ↑/Tab）时保持原状，交给提示符回退解析', () => {
    const state = { input: '', reliable: false };
    expect(trackPastedInput(state, 'pasted text')).toBe(state);
  });

  it('空粘贴不改动追踪', () => {
    const state = { input: 'ls', reliable: true };
    expect(trackPastedInput(state, '')).toBe(state);
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
