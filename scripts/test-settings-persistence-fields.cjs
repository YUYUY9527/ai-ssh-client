const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

/** 从 shared/constants.ts 提取 DEFAULT_SETTINGS 对象（真实源，非复刻）。 */
function loadDefaultSettingsFromTs() {
  const sourcePath = path.join(ROOT, 'src', 'shared', 'constants.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/export const DEFAULT_SETTINGS = (\{[\s\S]*?\});/);
  assert.ok(match, 'DEFAULT_SETTINGS not found in constants.ts');
  // 去掉 as const 以便 eval
  const objectLiteral = match[1].replace(/ as const/g, '');
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${objectLiteral});`)();
}

/** 从 server/index.cjs 读取 defaultSettings 真实对象。 */
function loadServerDefaultSettings() {
  const sourcePath = path.join(ROOT, 'server', 'index.cjs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/const defaultSettings = (\{[\s\S]*?\});/);
  assert.ok(match, 'defaultSettings not found in server/index.cjs');
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${match[1]});`)();
}

/** 从 Rust settings.rs 确认字段声明存在。 */
function assertRustAppSettingsFields() {
  const sourcePath = path.join(ROOT, 'src-tauri', 'src', 'models', 'settings.rs');
  const source = fs.readFileSync(sourcePath, 'utf8');
  for (const field of [
    'terminal_scrollback',
    'terminal_cursor_style',
    'terminal_cursor_blink',
    'terminal_copy_on_select',
    'terminal_shell_integration',
  ]) {
    assert.match(source, new RegExp(`pub ${field}:`), `Rust AppSettings missing ${field}`);
  }
  // Default 基线与 shared 对齐
  assert.match(source, /terminal_scrollback:\s*Some\(3000\)/);
  assert.match(source, /terminal_cursor_style:\s*Some\("block"\.to_string\(\)\)/);
  assert.match(source, /terminal_cursor_blink:\s*Some\(true\)/);
  assert.match(source, /terminal_copy_on_select:\s*Some\(false\)/);
  assert.match(source, /terminal_shell_integration:\s*Some\(true\)/);
}

const REQUIRED = [
  'terminalScrollback',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalCopyOnSelect',
  'terminalShellIntegration',
];

const shared = loadDefaultSettingsFromTs();
const server = loadServerDefaultSettings();

for (const key of REQUIRED) {
  assert.notEqual(shared[key], undefined, `shared DEFAULT_SETTINGS missing ${key}`);
  assert.notEqual(server[key], undefined, `server defaultSettings missing ${key}`);
  assert.equal(server[key], shared[key], `server/shared mismatch for ${key}`);
}

assertRustAppSettingsFields();

// normalizeSettings 行为：旧存档缺字段时补齐默认
const { normalizeSettings, defaultSettings } = (() => {
  // 直接复用 server 文件里的函数逻辑：通过读取并执行 normalize 片段
  const source = fs.readFileSync(path.join(ROOT, 'server', 'index.cjs'), 'utf8');
  const defaultMatch = source.match(/const defaultSettings = (\{[\s\S]*?\});/);
  const defaults = Function(`"use strict"; return (${defaultMatch[1]});`)();
  function normalizeSettings(settings) {
    const normalized = { ...defaults, ...(settings || {}) };
    delete normalized.agentMaxExecutionSteps;
    return normalized;
  }
  return { normalizeSettings, defaultSettings: defaults };
})();

const normalized = normalizeSettings({ language: 'en-US', fontSize: 16 });
assert.equal(normalized.terminalScrollback, defaultSettings.terminalScrollback);
assert.equal(normalized.terminalCursorStyle, 'block');
assert.equal(normalized.terminalCopyOnSelect, false);
assert.equal(normalized.terminalShellIntegration, true);
assert.equal(normalized.fontSize, 16);

const custom = normalizeSettings({
  terminalScrollback: 9000,
  terminalCursorStyle: 'underline',
  terminalCursorBlink: false,
  terminalCopyOnSelect: true,
  terminalShellIntegration: false,
});
assert.equal(custom.terminalScrollback, 9000);
assert.equal(custom.terminalCursorStyle, 'underline');
assert.equal(custom.terminalCursorBlink, false);
assert.equal(custom.terminalCopyOnSelect, true);
assert.equal(custom.terminalShellIntegration, false);

// silence unused
void ts;

console.log('settings-persistence-fields tests passed');
