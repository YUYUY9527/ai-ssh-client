/**
 * 远端终端模式跟踪与 replay 恢复。
 *
 * 背景：vim / nano 等全屏程序在启动时用一次性的 DECSET 声明大量终端模式：
 * - ?2004 bracketed paste（粘贴保护依赖它）
 * - ?1000/?1002/?1003 鼠标跟踪，?1006 SGR 鼠标坐标编码
 * - ?1 应用光标键模式（方向键编码）
 * - ?25 光标可见，?7 自动换行
 * 这些序列只在流头部出现一次。输出缓冲（store / server / localStorage 快照）
 * 按 1MiB 从头部截断，或浏览器刷新 / 断线重连走 replay 时，`term.reset()`
 * （RIS 全量复位）会把它们全部清掉，而截断窗口里已不含这些 DECSET →
 * 重放后全屏程序的鼠标失效、bracketed paste 失效（多行粘贴又逐行执行）、
 * 光标异常、方向键编码回退。
 *
 * 解法：增量扫描输出流里的 DECSET/DECRST，记录关心的模式开关；replay 的
 * `term.reset()` 之后把这些模式重新写入。状态按 sessionId 存 sessionStorage，
 * 以覆盖"刷新页面时缓冲已超限、快照里已无 DECSET"的场景。
 *
 * 纯函数（不碰 DOM），便于单测。
 */

export type MouseTrackingMode = '1000' | '1002' | '1003' | null;

export interface TerminalModeState {
  /** ?1 应用光标键模式（DECCKM） */
  appCursorKeys?: boolean;
  /** ?7 自动换行（DECAWM，默认开） */
  autoWrap?: boolean;
  /** ?25 光标可见（默认开） */
  cursorVisible?: boolean;
  /** ?1000/?1002/?1003 鼠标跟踪（三者互斥，记录当前生效者） */
  mouseTracking?: MouseTrackingMode;
  /** ?1006 SGR 鼠标坐标编码 */
  sgrMouse?: boolean;
  /** ?2004 bracketed paste */
  bracketedPaste?: boolean;
  /** 跨块续接用的悬挂转义前缀（不持久化） */
  pendingTail?: string;
}

const DEC_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;
const MOUSE_MODES = new Set([1000, 1002, 1003]);
/** 判定"可能是 DEC 私有模式序列前缀"的悬挂尾，用于跨 WS 帧续接。 */
const PENDING_TAIL_RE = /^(?:\x1b|\x1b\[|\x1b\[\?[0-9;]*)$/;
const MAX_PENDING_TAIL = 16;

export function createTerminalModeState(): TerminalModeState {
  return {};
}

/**
 * 扫描一段输出，更新模式状态。返回同一 state（就地更新）。
 * 支持跨块续接：上一块尾部的悬挂前缀先拼到本块开头再扫描。
 */
export function scanTerminalModes(
  state: TerminalModeState,
  chunk: string,
): TerminalModeState {
  if (!state) {
    return state;
  }
  const combined = (state.pendingTail || '') + (chunk || '');
  if (!combined) {
    return state;
  }

  DEC_MODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEC_MODE_RE.exec(combined)) !== null) {
    const on = match[2] === 'h';
    for (const token of match[1].split(';')) {
      const code = Number.parseInt(token, 10);
      if (!Number.isInteger(code)) {
        continue;
      }
      if (MOUSE_MODES.has(code)) {
        if (on) {
          state.mouseTracking = String(code) as MouseTrackingMode;
        } else if (state.mouseTracking === String(code)) {
          state.mouseTracking = null;
        }
        continue;
      }
      switch (code) {
        case 1:
          state.appCursorKeys = on;
          break;
        case 7:
          state.autoWrap = on;
          break;
        case 25:
          state.cursorVisible = on;
          break;
        case 1006:
          state.sgrMouse = on;
          break;
        case 2004:
          state.bracketedPaste = on;
          break;
        default:
          break;
      }
    }
  }

  // 重新计算悬挂尾（本段末尾未闭合的、可能是模式序列前缀的 ESC 片段）。
  state.pendingTail = '';
  const esc = combined.lastIndexOf('\x1b');
  if (esc !== -1) {
    const tail = combined.slice(esc);
    if (tail.length <= MAX_PENDING_TAIL && PENDING_TAIL_RE.test(tail)) {
      state.pendingTail = tail;
    }
  }

  return state;
}

/**
 * 生成恢复模式所需的控制序列：把记录为"开"的模式发 h，记录为"关"的发 l；
 * 未知（undefined）不发送，交给 xterm 复位默认值。顺序固定，便于测试与阅读。
 */
export function emitTerminalModeRestore(state: TerminalModeState): string {
  if (!state) {
    return '';
  }
  let out = '';
  if (state.appCursorKeys === true) {
    out += '\x1b[?1h';
  } else if (state.appCursorKeys === false) {
    out += '\x1b[?1l';
  }
  if (state.autoWrap === true) {
    out += '\x1b[?7h';
  } else if (state.autoWrap === false) {
    out += '\x1b[?7l';
  }
  if (state.cursorVisible === true) {
    out += '\x1b[?25h';
  } else if (state.cursorVisible === false) {
    out += '\x1b[?25l';
  }
  if (state.sgrMouse === true) {
    out += '\x1b[?1006h';
  } else if (state.sgrMouse === false) {
    out += '\x1b[?1006l';
  }
  if (state.mouseTracking) {
    out += `\x1b[?${state.mouseTracking}h`;
  }
  if (state.bracketedPaste === true) {
    out += '\x1b[?2004h';
  } else if (state.bracketedPaste === false) {
    out += '\x1b[?2004l';
  }
  return out;
}

const STORAGE_PREFIX = 'ai-ssh-terminal-modes:';

function sanitizeModeState(value: unknown): TerminalModeState {
  const state: TerminalModeState = {};
  if (!value || typeof value !== 'object') {
    return state;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.appCursorKeys === 'boolean') state.appCursorKeys = record.appCursorKeys;
  if (typeof record.autoWrap === 'boolean') state.autoWrap = record.autoWrap;
  if (typeof record.cursorVisible === 'boolean') state.cursorVisible = record.cursorVisible;
  if (typeof record.sgrMouse === 'boolean') state.sgrMouse = record.sgrMouse;
  if (typeof record.bracketedPaste === 'boolean') state.bracketedPaste = record.bracketedPaste;
  if (record.mouseTracking === null || record.mouseTracking === '1000'
    || record.mouseTracking === '1002' || record.mouseTracking === '1003') {
    state.mouseTracking = record.mouseTracking as MouseTrackingMode;
  }
  return state;
}

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadTerminalModeState(
  storage: ModeStorage | null | undefined,
  sessionId: string | null | undefined,
): TerminalModeState {
  if (!storage || !sessionId) {
    return {};
  }
  try {
    const raw = storage.getItem(STORAGE_PREFIX + sessionId);
    if (!raw) {
      return {};
    }
    return sanitizeModeState(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveTerminalModeState(
  storage: ModeStorage | null | undefined,
  sessionId: string | null | undefined,
  state: TerminalModeState,
): void {
  if (!storage || !sessionId) {
    return;
  }
  try {
    storage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(sanitizeModeState(state)));
  } catch {
    // 忽略：sessionStorage 配额/隐私模式失败不应影响终端
  }
}
