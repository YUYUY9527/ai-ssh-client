/** 终端专业设置：归一化 / 默认值 / 应用到 xterm 的纯函数。 */

export const MIN_TERMINAL_SCROLLBACK = 100;
export const MAX_TERMINAL_SCROLLBACK = 100_000;
export const DEFAULT_TERMINAL_SCROLLBACK = 3000;

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export const TERMINAL_CURSOR_STYLES: TerminalCursorStyle[] = ['block', 'underline', 'bar'];

export interface TerminalRuntimeSettings {
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  shellIntegration: boolean;
}

/** 将 scrollback 行数限制在合法区间。 */
export function clampTerminalScrollback(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TERMINAL_SCROLLBACK;
  }
  return Math.min(
    Math.max(Math.round(value as number), MIN_TERMINAL_SCROLLBACK),
    MAX_TERMINAL_SCROLLBACK,
  );
}

/** 归一化光标样式；非法值回落为 block。 */
export function normalizeCursorStyle(value: string | undefined): TerminalCursorStyle {
  if (value === 'underline' || value === 'bar' || value === 'block') {
    return value;
  }
  return 'block';
}

/** 归一化光标闪烁开关，默认开启。 */
export function normalizeCursorBlink(value: boolean | undefined): boolean {
  return value !== false;
}

/** 归一化选中即复制，默认关闭。 */
export function normalizeCopyOnSelect(value: boolean | undefined): boolean {
  return value === true;
}

/** 归一化 Shell Integration 开关，默认开启。 */
export function normalizeShellIntegration(value: boolean | undefined): boolean {
  return value !== false;
}

/** 从 AppSettings 片段解析出可应用到 xterm 的运行时设置。 */
export function resolveTerminalRuntimeSettings(input?: {
  terminalScrollback?: number;
  terminalCursorStyle?: string;
  terminalCursorBlink?: boolean;
  terminalCopyOnSelect?: boolean;
  terminalShellIntegration?: boolean;
}): TerminalRuntimeSettings {
  return {
    scrollback: clampTerminalScrollback(input?.terminalScrollback),
    cursorStyle: normalizeCursorStyle(input?.terminalCursorStyle),
    cursorBlink: normalizeCursorBlink(input?.terminalCursorBlink),
    copyOnSelect: normalizeCopyOnSelect(input?.terminalCopyOnSelect),
    shellIntegration: normalizeShellIntegration(input?.terminalShellIntegration),
  };
}

/** 生成写入 xterm.options 的字段（不含 copyOnSelect 监听）。 */
export function toXtermOptionPatch(settings: TerminalRuntimeSettings): {
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
} {
  return {
    scrollback: settings.scrollback,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
  };
}
