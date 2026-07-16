const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

/** 编译并加载生产模块 paste-safety.ts（真实入口，非复刻）。 */
function loadModule(relativeSource) {
  const sourcePath = path.join(__dirname, '..', relativeSource);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-paste-'));
  const outputPath = path.join(tempDir, path.basename(relativeSource, '.ts') + '.cjs');
  fs.writeFileSync(outputPath, output);
  const mod = require(outputPath);
  return { mod, tempDir };
}

const { mod, tempDir } = loadModule('src/renderer/session/terminal/paste-safety.ts');
const {
  gateTerminalPaste,
  isMultiLinePaste,
  prepareTerminalPaste,
  resolvePasteConfirmation,
} = mod;

try {
  // 单行 → 直接发送，无需确认
  assert.equal(isMultiLinePaste('echo hello'), false);
  const single = gateTerminalPaste('echo hello');
  assert.equal(single.action, 'send');
  assert.equal(single.text, 'echo hello');

  // 多行 \n → 阻塞待确认
  assert.equal(isMultiLinePaste('line1\nline2'), true);
  const multiN = gateTerminalPaste('line1\nline2');
  assert.equal(multiN.action, 'confirm');
  assert.equal(multiN.previewText, 'line1\nline2');
  assert.equal(multiN.preparedText, 'line1\rline2');

  // 多行 \r → 同样阻塞
  const multiR = gateTerminalPaste('a\rb');
  assert.equal(multiR.action, 'confirm');

  // 确认 → 返回 CR 规范化文本
  const confirmed = gateTerminalPaste('line1\r\nline2\nline3', true);
  assert.equal(confirmed.action, 'send');
  assert.equal(confirmed.text, prepareTerminalPaste('line1\r\nline2\nline3'));
  assert.equal(confirmed.text, 'line1\rline2\rline3');

  // 取消 → 空串，不发送
  assert.equal(resolvePasteConfirmation(multiN.preparedText, false), '');
  assert.equal(resolvePasteConfirmation(multiN.preparedText, true), multiN.preparedText);

  // 空文本 skip
  assert.equal(gateTerminalPaste('').action, 'skip');

  console.log('paste-safety tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
