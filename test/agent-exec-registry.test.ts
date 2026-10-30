import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { deleteIfCurrent } = require(
  path.join(ROOT, 'server', 'agent-exec-registry.cjs'),
) as {
  deleteIfCurrent: <V>(map: Map<string, V>, key: string, handle: V) => boolean;
};

describe('deleteIfCurrent', () => {
  it('句柄仍是本次 run 的句柄时删除并返回 true', () => {
    const map = new Map<string, () => void>();
    const handle = () => {};
    map.set('conn-1::client-a', handle);

    expect(deleteIfCurrent(map, 'conn-1::client-a', handle)).toBe(true);
    expect(map.has('conn-1::client-a')).toBe(false);
  });

  it('句柄已被新 run 替换时不删除（回归 #3：旧任务迟到 finish 不能清掉新任务的取消句柄）', () => {
    const map = new Map<string, () => void>();
    const oldHandle = () => {};
    const newHandle = () => {};
    map.set('conn-1::client-a', newHandle);

    expect(deleteIfCurrent(map, 'conn-1::client-a', oldHandle)).toBe(false);
    expect(map.get('conn-1::client-a')).toBe(newHandle);
  });

  it('key 不存在时返回 false 且不报错', () => {
    const map = new Map<string, () => void>();

    expect(deleteIfCurrent(map, 'missing', () => {})).toBe(false);
    expect(map.size).toBe(0);
  });
});
