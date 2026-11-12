import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentAttachmentStore } from '../server/agent-attachments.cjs';

const dirs: string[] = [];

function makeStore(options: { maxBytes?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-att-'));
  dirs.push(dir);
  return { dir, store: createAgentAttachmentStore({ dataDir: dir, ...options }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent-attachments', () => {
  it('保存图片并原样读回 base64', () => {
    const { store } = makeStore();
    const data = Buffer.from('hello-image').toString('base64');
    const meta = store.save({ name: 'x.png', type: 'image/png', dataBase64: data });
    expect(meta.size).toBe(11);
    expect(store.read(meta.id)?.dataBase64).toBe(data);
  });

  it('拒绝不支持的类型与空数据', () => {
    const { store } = makeStore();
    expect(() => store.save({ type: 'application/zip', dataBase64: 'QUJD' })).toThrow(/unsupported/);
    expect(() => store.save({ type: 'image/png', dataBase64: '' })).toThrow(/empty/);
  });

  it('超过大小上限时报错', () => {
    const { store } = makeStore({ maxBytes: 4 });
    expect(() => store.save({ type: 'text/plain', dataBase64: Buffer.from('12345').toString('base64') })).toThrow(/too large/);
  });

  it('remove 后读不到', () => {
    const { store } = makeStore();
    const meta = store.save({ type: 'text/plain', dataBase64: Buffer.from('abc').toString('base64') });
    expect(store.remove(meta.id)).toBe(true);
    expect(store.read(meta.id)).toBeNull();
  });

  it('cleanup 清理过期附件', () => {
    const { store } = makeStore();
    const meta = store.save({ type: 'text/plain', dataBase64: Buffer.from('abc').toString('base64') });
    expect(store.cleanup(Date.now())).toBe(0);
    expect(store.cleanup(Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    expect(store.read(meta.id)).toBeNull();
  });
});
