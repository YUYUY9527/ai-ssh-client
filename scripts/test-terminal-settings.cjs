const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

/** 编译并加载生产模块 terminal-settings.ts。 */
function loadModule(relativeSource) {
  const sourcePath = path.join(__dirname, '..', relativeSource);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-termset-'));
  const outputPath = path.join(tempDir, path.basename(relativeSource, '.ts') + '.cjs');
  fs.writeFileSync(outputPath, output);
  return { mod: require(outputPath), tempDir };
}

const { mod, tempDir } = loadModule('src/renderer/session/terminal/terminal-settings.ts');
const {
  clampTerminalScrollback,
  normalizeCursorStyle,
  normalizeCursorBlink,
  normalizeCopyOnSelect,
  resolveTerminalRuntimeSettings,
  toXtermOptionPatch,
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} = mod;

try {
  // scrollback：合法值、夹取、默认
  assert.equal(clampTerminalScrollback(5000), 5000);
  assert.equal(clampTerminalScrollback(0), MIN_TERMINAL_SCROLLBACK);
  assert.equal(clampTerminalScrollback(999999), MAX_TERMINAL_SCROLLBACK);
  assert.equal(clampTerminalScrollback(undefined), DEFAULT_TERMINAL_SCROLLBACK);
  assert.equal(clampTerminalScrollback(Number.NaN), DEFAULT_TERMINAL_SCROLLBACK);

  // cursor style
  assert.equal(normalizeCursorStyle('block'), 'block');
  assert.equal(normalizeCursorStyle('underline'), 'underline');
  assert.equal(normalizeCursorStyle('bar'), 'bar');
  assert.equal(normalizeCursorStyle('invalid'), 'block');
  assert.equal(normalizeCursorStyle(undefined), 'block');

  // cursor blink
  assert.equal(normalizeCursorBlink(true), true);
  assert.equal(normalizeCursorBlink(false), false);
  assert.equal(normalizeCursorBlink(undefined), true);

  // copy on select
  assert.equal(normalizeCopyOnSelect(true), true);
  assert.equal(normalizeCopyOnSelect(false), false);
  assert.equal(normalizeCopyOnSelect(undefined), false);

  const resolved = resolveTerminalRuntimeSettings({
    terminalScrollback: 50,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: false,
    terminalCopyOnSelect: true,
  });
  assert.equal(resolved.scrollback, MIN_TERMINAL_SCROLLBACK);
  assert.equal(resolved.cursorStyle, 'bar');
  assert.equal(resolved.cursorBlink, false);
  assert.equal(resolved.copyOnSelect, true);

  const patch = toXtermOptionPatch(resolved);
  assert.deepEqual(patch, {
    scrollback: MIN_TERMINAL_SCROLLBACK,
    cursorStyle: 'bar',
    cursorBlink: false,
  });

  console.log('terminal-settings tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
