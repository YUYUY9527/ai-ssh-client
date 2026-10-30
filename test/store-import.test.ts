import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { normalizeImportData, applyImportData, importSummary } = require(
  path.join(ROOT, 'server', 'store-import.cjs'),
) as {
  normalizeImportData: (input: any) => any;
  applyImportData: (store: any, imported: any, merge: boolean, defaults?: any) => any;
  importSummary: (imported: any) => any;
};

function buildStore() {
  return {
    connections: [{ id: 'c-old', host: 'h', username: 'u' }],
    settings: { theme: 'dark' },
    commandHistory: [{ id: 'h-old' }],
    quickCommands: [{ id: 'q-old' }],
    quickCommandGroups: [{ id: 'g-old' }],
    aiProviders: [{ id: 'p-old', name: 'old' }],
    hostTrustRecords: [{ host: 'a.com', port: 22, fingerprint: 'SHA256:old' }],
  };
}

describe('normalizeImportData 区分缺失与显式空数组', () => {
  it('字段缺失 -> undefined；显式 [] -> []', () => {
    const missing = normalizeImportData({ data: {} });
    expect(missing.aiProviders).toBeUndefined();
    expect(missing.quickCommands).toBeUndefined();
    expect(missing.hostTrustRecords).toBeUndefined();

    const empty = normalizeImportData({
      data: { aiProviders: [], quickCommands: [], hostTrustRecords: [], command_history: [] },
    });
    expect(empty.aiProviders).toEqual([]);
    expect(empty.quickCommands).toEqual([]);
    expect(empty.hostTrustRecords).toEqual([]);
    expect(empty.commandHistory).toEqual([]);
  });
});

describe('applyImportData 覆盖模式', () => {
  it('显式空数组会清空 providers/快捷命令/分组/信任记录/历史', () => {
    const store = buildStore();
    const imported = normalizeImportData({
      data: {
        connections: [{ id: 'c-new', host: 'h2', username: 'u2' }],
        aiProviders: [],
        quickCommands: [],
        quickCommandGroups: [],
        hostTrustRecords: [],
        commandHistory: [],
      },
    });
    applyImportData(store, imported, false);
    expect(store.aiProviders).toEqual([]);
    expect(store.quickCommands).toEqual([]);
    expect(store.quickCommandGroups).toEqual([]);
    expect(store.hostTrustRecords).toEqual([]);
    expect(store.commandHistory).toEqual([]);
    expect(store.connections).toEqual([{ id: 'c-new', host: 'h2', username: 'u2', name: 'h2', port: 22, password: undefined, privateKey: undefined, passphrase: undefined }]);
  });

  it('字段缺失时保留原有集合', () => {
    const store = buildStore();
    const imported = normalizeImportData({ data: { connections: [] } });
    applyImportData(store, imported, false);
    expect(store.aiProviders).toHaveLength(1);
    expect(store.quickCommands).toHaveLength(1);
    expect(store.quickCommandGroups).toHaveLength(1);
    expect(store.hostTrustRecords).toHaveLength(1);
    expect(store.commandHistory).toHaveLength(1);
  });

  it('非空备份直接替换（不是追加）', () => {
    const store = buildStore();
    const imported = normalizeImportData({
      data: {
        aiProviders: [{ id: 'p-new' }],
        quickCommands: [{ id: 'q-new' }],
        hostTrustRecords: [{ host: 'b.com', port: 22, fingerprint: 'SHA256:new' }],
        commandHistory: [{ id: 'h-new' }],
      },
    });
    applyImportData(store, imported, false);
    expect(store.aiProviders.map((p: any) => p.id)).toEqual(['p-new']);
    expect(store.quickCommands.map((q: any) => q.id)).toEqual(['q-new']);
    expect(store.hostTrustRecords.map((t: any) => t.host)).toEqual(['b.com']);
    expect(store.commandHistory.map((h: any) => h.id)).toEqual(['h-new']);
  });
});

describe('applyImportData 合并模式', () => {
  it('追加并覆盖同 id，不因空数组清空', () => {
    const store = buildStore();
    const imported = normalizeImportData({
      data: {
        aiProviders: [{ id: 'p-old', name: 'updated' }, { id: 'p-new' }],
        quickCommands: [],
      },
    });
    applyImportData(store, imported, true);
    const ids = store.aiProviders.map((p: any) => p.id);
    expect(ids).toContain('p-old');
    expect(ids).toContain('p-new');
    // 同 id 被更新而不是保留旧值
    expect(store.aiProviders.find((p: any) => p.id === 'p-old').name).toBe('updated');
    // 空数组在合并模式下不清空
    expect(store.quickCommands).toHaveLength(1);
  });
});

describe('importSummary', () => {
  it('缺失字段计 0，不抛错', () => {
    const summary = importSummary(normalizeImportData({ data: { connections: [] } }));
    expect(summary).toMatchObject({
      connections: 0,
      aiProviders: 0,
      quickCommands: 0,
      quickCommandGroups: 0,
      hostTrustRecords: 0,
    });
  });
});
