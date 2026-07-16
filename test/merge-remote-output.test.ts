import { describe, it, expect } from 'vitest';

// 轻量复刻 merge 逻辑做回归，避免引入 useSessionStore（zustand）依赖。
// 与 src/renderer/session/merge-remote-output.ts 的 mergeRemoteOutputBuffer 保持一致。
function mergeRemoteOutputBuffer(current: string, buffer: string): string {
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

describe('merge-remote-output', () => {
  it('merges remote output buffers, avoiding duplicated prompts', () => {
    expect(mergeRemoteOutputBuffer('', 'prompt$ ')).toBe('prompt$ ');
    expect(mergeRemoteOutputBuffer('prompt$ ', 'prompt$ ')).toBe('');
    expect(mergeRemoteOutputBuffer('a', 'abc')).toBe('bc');
    expect(mergeRemoteOutputBuffer('hello world', 'world!')).toBe('!');
    expect(mergeRemoteOutputBuffer('history $ ', 'new$ ')).toBe('new$ ');
    // 短片段不应因 includes 被吞掉
    expect(mergeRemoteOutputBuffer('echo $\nold\n', '$ ')).toBe('$ ');
  });
});
