const assert = require('node:assert/strict');

// 轻量复刻 merge 逻辑做回归（避免 TS 路径依赖）
function mergeRemoteOutputBuffer(current, buffer) {
  if (!buffer) return '';
  if (!current) return buffer;
  if (current.endsWith(buffer)) return '';
  if (buffer.startsWith(current)) return buffer.slice(current.length);
  const max = Math.min(current.length, buffer.length, 4096);
  for (let size = max; size >= 4; size -= 1) {
    if (buffer.startsWith(current.slice(-size))) {
      return buffer.slice(size);
    }
  }
  return buffer;
}

assert.equal(mergeRemoteOutputBuffer('', 'prompt$ '), 'prompt$ ');
assert.equal(mergeRemoteOutputBuffer('prompt$ ', 'prompt$ '), '');
assert.equal(mergeRemoteOutputBuffer('a', 'abc'), 'bc');
assert.equal(mergeRemoteOutputBuffer('hello world', 'world!'), '!');
assert.equal(mergeRemoteOutputBuffer('history $ ', 'new$ '), 'new$ ');
// 短片段不应因 includes 被吞掉
assert.equal(mergeRemoteOutputBuffer('echo $\nold\n', '$ '), '$ ');

console.log('merge-remote-output tests passed');
