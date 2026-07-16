const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

/** 编译并加载生产模块 shell-integration.ts。 */
function loadModule(relativeSource) {
  const sourcePath = path.join(__dirname, '..', relativeSource);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-shell-'));
  const outputPath = path.join(tempDir, path.basename(relativeSource, '.ts') + '.cjs');
  fs.writeFileSync(outputPath, output);
  return { mod: require(outputPath), tempDir };
}

const { mod, tempDir } = loadModule('src/renderer/session/terminal/shell-integration.ts');
const {
  detectHttpUrls,
  isOpenableHttpUrl,
  createShellIntegrationState,
  parseOsc7Cwd,
  parseOsc133Marker,
  consumeShellIntegrationChunk,
  applyOscPayload,
  ShellIntegrationParser,
} = mod;

try {
  // URL 识别
  const urls = detectHttpUrls('see https://example.com/path and http://localhost:8080/x');
  assert.deepEqual(urls, ['https://example.com/path', 'http://localhost:8080/x']);
  assert.equal(isOpenableHttpUrl('https://example.com/path'), true);
  assert.equal(isOpenableHttpUrl('ftp://example.com'), false);
  assert.equal(isOpenableHttpUrl('not a url'), false);

  // OSC 7 cwd
  assert.equal(parseOsc7Cwd('7;file://host/home/user/project'), '/home/user/project');
  assert.equal(parseOsc7Cwd('7;file:///tmp/foo'), '/tmp/foo');

  // OSC 133 markers
  assert.deepEqual(parseOsc133Marker('133;A'), { marker: 'A', exitCode: null });
  assert.deepEqual(parseOsc133Marker('133;B'), { marker: 'B', exitCode: null });
  assert.deepEqual(parseOsc133Marker('133;C'), { marker: 'C', exitCode: null });
  assert.deepEqual(parseOsc133Marker('133;D;0'), { marker: 'D', exitCode: 0 });
  assert.deepEqual(parseOsc133Marker('133;D;127'), { marker: 'D', exitCode: 127 });

  // 完整 chunk 消费
  let state = createShellIntegrationState();
  const chunk = [
    '\x1b]7;file://host/var/log\x07',
    '\x1b]133;A\x07',
    'prompt$ ',
    '\x1b]133;B\x07',
    'ls\r\n',
    '\x1b]133;C\x07',
    'file.txt\r\n',
    '\x1b]133;D;0\x07',
  ].join('');
  state = consumeShellIntegrationChunk(state, chunk);
  assert.equal(state.cwd, '/var/log');
  assert.equal(state.lastMarker, 'D');
  assert.equal(state.lastExitCode, 0);
  assert.equal(state.commandRunning, false);

  // 畸形输入不抛错
  assert.doesNotThrow(() => applyOscPayload(state, null));
  assert.doesNotThrow(() => consumeShellIntegrationChunk(state, '\x1b]7;not-a-uri\x07'));
  assert.doesNotThrow(() => detectHttpUrls(null));

  // 跨 chunk 解析器
  const parser = new ShellIntegrationParser();
  parser.feed('\x1b]7;file://h');
  assert.equal(parser.getState().cwd, null);
  parser.feed('/opt/app\x07');
  assert.equal(parser.getState().cwd, '/opt/app');

  console.log('links-shell-integration tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
