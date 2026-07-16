import { describe, it, expect } from 'vitest';
import {
  clampTerminalScrollback,
  normalizeCursorStyle,
  normalizeCursorBlink,
  normalizeCopyOnSelect,
  resolveTerminalRuntimeSettings,
  toXtermOptionPatch,
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../src/renderer/session/terminal/terminal-settings';

describe('terminal-settings', () => {
  it('clamps scrollback within bounds', () => {
    expect(clampTerminalScrollback(5000)).toBe(5000);
    expect(clampTerminalScrollback(0)).toBe(MIN_TERMINAL_SCROLLBACK);
    expect(clampTerminalScrollback(999999)).toBe(MAX_TERMINAL_SCROLLBACK);
    expect(clampTerminalScrollback(undefined)).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    expect(clampTerminalScrollback(Number.NaN)).toBe(DEFAULT_TERMINAL_SCROLLBACK);
  });

  it('normalizes cursor style', () => {
    expect(normalizeCursorStyle('block')).toBe('block');
    expect(normalizeCursorStyle('underline')).toBe('underline');
    expect(normalizeCursorStyle('bar')).toBe('bar');
    expect(normalizeCursorStyle('invalid')).toBe('block');
    expect(normalizeCursorStyle(undefined)).toBe('block');
  });

  it('normalizes cursor blink', () => {
    expect(normalizeCursorBlink(true)).toBe(true);
    expect(normalizeCursorBlink(false)).toBe(false);
    expect(normalizeCursorBlink(undefined)).toBe(true);
  });

  it('normalizes copy on select', () => {
    expect(normalizeCopyOnSelect(true)).toBe(true);
    expect(normalizeCopyOnSelect(false)).toBe(false);
    expect(normalizeCopyOnSelect(undefined)).toBe(false);
  });

  it('resolves runtime settings and produces xterm patch', () => {
    const resolved = resolveTerminalRuntimeSettings({
      terminalScrollback: 50,
      terminalCursorStyle: 'bar',
      terminalCursorBlink: false,
      terminalCopyOnSelect: true,
    });
    expect(resolved.scrollback).toBe(MIN_TERMINAL_SCROLLBACK);
    expect(resolved.cursorStyle).toBe('bar');
    expect(resolved.cursorBlink).toBe(false);
    expect(resolved.copyOnSelect).toBe(true);

    expect(toXtermOptionPatch(resolved)).toEqual({
      scrollback: MIN_TERMINAL_SCROLLBACK,
      cursorStyle: 'bar',
      cursorBlink: false,
    });
  });
});
