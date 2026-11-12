import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  createTerminalModeState,
  emitTerminalModeRestore,
  loadTerminalModeState,
  saveTerminalModeState,
  scanTerminalModes,
  type ModeStorage,
} from '../src/renderer/session/terminal/terminal-modes';

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));

function fakeStorage(initial: Record<string, string> = {}): ModeStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('scanTerminalModes', () => {
  it('tracks bracketed paste on/off', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, 'hello\x1b[?2004hworld');
    expect(state.bracketedPaste).toBe(true);
    scanTerminalModes(state, '\x1b[?2004l');
    expect(state.bracketedPaste).toBe(false);
  });

  it('keeps mouse tracking modes mutually exclusive', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, '\x1b[?1000h');
    expect(state.mouseTracking).toBe('1000');
    scanTerminalModes(state, '\x1b[?1002h');
    expect(state.mouseTracking).toBe('1002');
    // 关闭一个非当前生效的鼠标模式不应清空当前模式
    scanTerminalModes(state, '\x1b[?1000l');
    expect(state.mouseTracking).toBe('1002');
    scanTerminalModes(state, '\x1b[?1002l');
    expect(state.mouseTracking).toBeNull();
  });

  it('parses combined private-mode parameters', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, '\x1b[?1000;1006h');
    expect(state.mouseTracking).toBe('1000');
    expect(state.sgrMouse).toBe(true);
  });

  it('tracks cursor keys, autowrap and cursor visibility', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, '\x1b[?1h\x1b[?7l\x1b[?25l');
    expect(state.appCursorKeys).toBe(true);
    expect(state.autoWrap).toBe(false);
    expect(state.cursorVisible).toBe(false);
  });

  it('ignores unrelated private modes', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, '\x1b[?1034h\x1b[?12h\x1b[?1049h');
    expect(state.bracketedPaste).toBeUndefined();
    expect(state.mouseTracking).toBeUndefined();
    expect(state.appCursorKeys).toBeUndefined();
    expect(state.sgrMouse).toBeUndefined();
  });

  it('resumes a mode sequence split across chunks', () => {
    const state = createTerminalModeState();
    scanTerminalModes(state, 'output\x1b[?200');
    // 尚未闭合，不应误判
    expect(state.bracketedPaste).toBeUndefined();
    scanTerminalModes(state, '4h more');
    expect(state.bracketedPaste).toBe(true);
    expect(state.pendingTail).toBe('');
  });
});

describe('emitTerminalModeRestore', () => {
  it('emits h for on and l for off in a fixed order', () => {
    const restore = emitTerminalModeRestore({
      appCursorKeys: true,
      autoWrap: false,
      cursorVisible: false,
      sgrMouse: true,
      mouseTracking: '1002',
      bracketedPaste: true,
    });
    expect(restore).toBe('\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?1006h\x1b[?1002h\x1b[?2004h');
  });

  it('emits nothing for unknown modes', () => {
    expect(emitTerminalModeRestore(createTerminalModeState())).toBe('');
  });
});

describe('mode state persistence', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    saveTerminalModeState(storage, 'sess-1', {
      bracketedPaste: true,
      mouseTracking: '1000',
      appCursorKeys: true,
    });
    const loaded = loadTerminalModeState(storage, 'sess-1');
    expect(loaded).toEqual({ bracketedPaste: true, mouseTracking: '1000', appCursorKeys: true });
  });

  it('sanitizes dirty stored values', () => {
    const storage = fakeStorage({
      'ai-ssh-terminal-modes:sess-2': JSON.stringify({
        bracketedPaste: 'yes',
        mouseTracking: '9999',
        autoWrap: true,
        junk: 1,
      }),
    });
    expect(loadTerminalModeState(storage, 'sess-2')).toEqual({ autoWrap: true });
  });

  it('returns empty for missing storage, session or corrupt json', () => {
    expect(loadTerminalModeState(null, 'x')).toEqual({});
    expect(loadTerminalModeState(fakeStorage(), null)).toEqual({});
    const broken = fakeStorage({ 'ai-ssh-terminal-modes:sess-3': '{not json' });
    expect(loadTerminalModeState(broken, 'sess-3')).toEqual({});
  });
});

describe('mode restore with a real xterm instance', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reset() drops one-shot DECSET and emitTerminalModeRestore brings them back', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
    const state = createTerminalModeState();

    // 模拟程序启动时的一次性声明
    const startup = '\x1b[?2004h\x1b[?1000h\x1b[?1006h';
    scanTerminalModes(state, startup);
    term.write(startup);
    await tick();
    expect(term.modes.bracketedPasteMode).toBe(true);

    // 模拟 replay 的 term.reset()（RIS 全量复位）
    term.reset();
    await tick();
    expect(term.modes.bracketedPasteMode).toBe(false);

    // 重放后按记录恢复
    term.write(emitTerminalModeRestore(state));
    await tick();
    expect(term.modes.bracketedPasteMode).toBe(true);
  });
});
