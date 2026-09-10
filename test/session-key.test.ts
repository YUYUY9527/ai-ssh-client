import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { sessionKeyOf, clientKeysOf } = require(
  path.join(ROOT, 'server', 'session-key.cjs'),
) as {
  sessionKeyOf: (connectionId: string, clientId?: string) => string;
  clientKeysOf: (keys: string[], clientId?: string) => string[];
};

describe('sessionKeyOf', () => {
  it('由 connectionId 与 clientId 组成复合键', () => {
    expect(sessionKeyOf('conn-1', 'client-a')).toBe('conn-1::client-a');
  });

  it('clientId 缺省时退化为空后缀（不抛异常）', () => {
    expect(sessionKeyOf('conn-1')).toBe('conn-1::');
    expect(sessionKeyOf('conn-1', '')).toBe('conn-1::');
    expect(sessionKeyOf('conn-1', undefined)).toBe('conn-1::');
  });

  it('同一 connectionId 的不同 clientId 得到不同键（多标签页隔离基础）', () => {
    expect(sessionKeyOf('conn-1', 'a')).not.toBe(sessionKeyOf('conn-1', 'b'));
  });
});

describe('clientKeysOf', () => {
  it('只挑出属于指定客户端的键', () => {
    const keys = [
      sessionKeyOf('conn-1', 'a'),
      sessionKeyOf('conn-2', 'a'),
      sessionKeyOf('conn-1', 'b'),
    ];

    expect(clientKeysOf(keys, 'a')).toEqual([
      sessionKeyOf('conn-1', 'a'),
      sessionKeyOf('conn-2', 'a'),
    ]);
  });

  it('暂停一个客户端不会波及同一主机上的其他客户端（回归：原按 connectionId 索引会互相误伤）', () => {
    const keys = [
      sessionKeyOf('shared-host', 'client-a'),
      sessionKeyOf('shared-host', 'client-b'),
    ];

    const forA = clientKeysOf(keys, 'client-a');

    expect(forA).toEqual([sessionKeyOf('shared-host', 'client-a')]);
    expect(forA).not.toContain(sessionKeyOf('shared-host', 'client-b'));
  });

  it('空 clientId 只匹配空后缀，不会误匹配具名客户端', () => {
    const keys = [
      sessionKeyOf('conn-1', ''),
      sessionKeyOf('conn-1', 'a'),
      sessionKeyOf('conn-1', 'aa'),
    ];

    expect(clientKeysOf(keys, '')).toEqual([sessionKeyOf('conn-1', '')]);
  });

  it('后缀精确匹配：client 名是另一个的前缀时不会串', () => {
    const keys = [
      sessionKeyOf('conn-1', 'client'),
      sessionKeyOf('conn-1', 'client-2'),
    ];

    expect(clientKeysOf(keys, 'client')).toEqual([sessionKeyOf('conn-1', 'client')]);
  });

  it('connectionId 自身含 :: 时仍按最后一段判定归属', () => {
    const key = sessionKeyOf('host::weird', 'client-a');

    expect(key).toBe('host::weird::client-a');
    expect(clientKeysOf([key], 'client-a')).toEqual([key]);
    expect(clientKeysOf([key], 'weird')).toEqual([]);
  });

  it('空列表与无匹配返回空数组', () => {
    expect(clientKeysOf([], 'a')).toEqual([]);
    expect(clientKeysOf([sessionKeyOf('c', 'a')], 'zzz')).toEqual([]);
  });
});
