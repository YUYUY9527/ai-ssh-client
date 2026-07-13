const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'renderer', 'history', 'command-history-index.ts');
const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-history-'));
const outputPath = path.join(tempDir, 'command-history-index.cjs');

try {
  fs.writeFileSync(outputPath, output);
  const { nextTrackedCwd, normalizeHistoryPath } = require(outputPath);
  assert.equal(normalizeHistoryPath('~/..'), '~/..');
  assert.equal(normalizeHistoryPath('~/project/../..'), '~/..');
  assert.equal(nextTrackedCwd('~', 'cd ..'), '~/..');
  assert.equal(nextTrackedCwd('~', 'cd ../shared'), '~/../shared');
  assert.equal(nextTrackedCwd('/var/log', 'cd ..'), '/var');
  console.log('command history index tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
