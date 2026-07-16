import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 shared/constants.ts 提取 DEFAULT_SETTINGS 对象（真实源，非复刻）。 */
function loadDefaultSettingsFromTs(): Record<string, unknown> {
  const sourcePath = path.join(ROOT, 'src', 'shared', 'constants.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/export const DEFAULT_SETTINGS = (\{[\s\S]*?\});/);
  expect(match, 'DEFAULT_SETTINGS not found in constants.ts').toBeTruthy();
  const objectLiteral = match![1].replace(/ as const/g, '');
  return Function(`"use strict"; return (${objectLiteral});`)();
}

/** 从 server/index.cjs 读取 defaultSettings 真实对象。 */
function loadServerDefaultSettings(): Record<string, unknown> {
  const sourcePath = path.join(ROOT, 'server', 'index.cjs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/const defaultSettings = (\{[\s\S]*?\});/);
  expect(match, 'defaultSettings not found in server/index.cjs').toBeTruthy();
  return Function(`"use strict"; return (${match![1]});`)();
}

const REQUIRED = [
  'terminalScrollback',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalCopyOnSelect',
  'terminalShellIntegration',
];

describe('settings-persistence-fields', () => {
  it('keeps shared and server defaults in sync', () => {
    const shared = loadDefaultSettingsFromTs();
    const server = loadServerDefaultSettings();
    for (const key of REQUIRED) {
      expect(shared[key], `shared DEFAULT_SETTINGS missing ${key}`).not.toBe(undefined);
      expect(server[key], `server defaultSettings missing ${key}`).not.toBe(undefined);
      expect(server[key], `server/shared mismatch for ${key}`).toBe(shared[key]);
    }
  });

  it('declares the fields in the Rust AppSettings model', () => {
    const sourcePath = path.join(ROOT, 'src-tauri', 'src', 'models', 'settings.rs');
    const source = fs.readFileSync(sourcePath, 'utf8');
    for (const field of [
      'terminal_scrollback',
      'terminal_cursor_style',
      'terminal_cursor_blink',
      'terminal_copy_on_select',
      'terminal_shell_integration',
    ]) {
      expect(source, `Rust AppSettings missing ${field}`).toMatch(new RegExp(`pub ${field}:`));
    }
    expect(source).toMatch(/terminal_scrollback:\s*Some\(3000\)/);
    expect(source).toMatch(/terminal_cursor_style:\s*Some\("block"\.to_string\(\)\)/);
    expect(source).toMatch(/terminal_cursor_blink:\s*Some\(true\)/);
    expect(source).toMatch(/terminal_copy_on_select:\s*Some\(false\)/);
    expect(source).toMatch(/terminal_shell_integration:\s*Some\(true\)/);
  });

  it('normalizeSettings fills defaults and preserves overrides', () => {
    const defaultSettings = loadServerDefaultSettings();
    function normalizeSettings(settings: Record<string, unknown>) {
      const normalized: Record<string, unknown> = { ...defaultSettings, ...(settings || {}) };
      delete normalized.agentMaxExecutionSteps;
      return normalized;
    }

    const normalized = normalizeSettings({ language: 'en-US', fontSize: 16 });
    expect(normalized.terminalScrollback).toBe(defaultSettings.terminalScrollback);
    expect(normalized.terminalCursorStyle).toBe('block');
    expect(normalized.terminalCopyOnSelect).toBe(false);
    expect(normalized.terminalShellIntegration).toBe(true);
    expect(normalized.fontSize).toBe(16);

    const custom = normalizeSettings({
      terminalScrollback: 9000,
      terminalCursorStyle: 'underline',
      terminalCursorBlink: false,
      terminalCopyOnSelect: true,
      terminalShellIntegration: false,
    });
    expect(custom.terminalScrollback).toBe(9000);
    expect(custom.terminalCursorStyle).toBe('underline');
    expect(custom.terminalCursorBlink).toBe(false);
    expect(custom.terminalCopyOnSelect).toBe(true);
    expect(custom.terminalShellIntegration).toBe(false);
  });
});
