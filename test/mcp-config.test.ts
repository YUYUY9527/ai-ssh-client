import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecretStore } from '../server/secret-store.cjs';
import {
  createConfigStore,
  listConnectionSummaries,
  resolveConnection,
} from '../server/mcp/config.cjs';

let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-mcp-config-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeConfig(connections: any[], hostTrustRecords: any[] = []) {
  const secretStore = createSecretStore({ dataDir });
  const payload = secretStore.encryptStore({ connections, hostTrustRecords, settings: {} });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(payload, null, 2));
}

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'demo',
  host: '10.0.0.9',
  port: 22,
  username: 'root',
  password: 'super-secret',
  ...overrides,
});

describe('mcp config store', () => {
  it('decrypts credentials for the SSH pool but never exposes them in summaries', () => {
    writeConfig([connection()]);
    const store = createConfigStore({ dataDir });
    const summaries = listConnectionSummaries(store.read(), store.trustRecords());

    expect(summaries).toEqual([
      expect.objectContaining({
        id: 'c1',
        name: 'demo',
        host: '10.0.0.9',
        port: 22,
        username: 'root',
        authType: 'password',
        trusted: false,
      }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain('super-secret');
    expect(store.read().connections[0].password).toBe('super-secret');
  });

  it('marks trust records and resolves connections by id or unique name', () => {
    writeConfig(
      [connection(), connection({ id: 'c2', name: 'keybox', password: undefined, privateKey: 'KEY' })],
      [{ host: '10.0.0.9', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', trustedAt: 123 }],
    );
    const store = createConfigStore({ dataDir });
    const storeData = store.read();

    expect(listConnectionSummaries(storeData, store.trustRecords())[0]).toMatchObject({
      name: 'demo',
      trusted: true,
      trustedAt: 123,
    });
    expect(resolveConnection(storeData, 'c2').name).toBe('keybox');
    expect(resolveConnection(storeData, 'keybox').id).toBe('c2');
    expect(listConnectionSummaries(storeData, store.trustRecords())[1]).toMatchObject({
      authType: 'private-key',
    });
  });

  it('reports unknown, ambiguous, and credential-less connections with actionable codes', () => {
    writeConfig([
      connection(),
      connection({ id: 'c2' }),
      connection({ id: 'c3', name: 'nocreds', password: undefined }),
    ]);
    const store = createConfigStore({ dataDir });
    const storeData = store.read();

    expect(() => resolveConnection(storeData, 'missing')).toThrow(/未知连接/);
    expect(() => resolveConnection(storeData, 'demo')).toThrow(/不唯一/);
    expect(() => resolveConnection(storeData, 'nocreds')).toThrow(/没有保存密码或私钥/);
    try {
      resolveConnection(storeData, 'missing');
    } catch (error: any) {
      expect(error.code).toBe('unknown-connection');
    }
  });

  it('writes trust records without disturbing encrypted credentials', () => {
    writeConfig([connection()]);
    const store = createConfigStore({ dataDir });

    store.saveTrustRecords([
      { host: '10.0.0.9', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:new', trustedAt: 456 },
    ]);

    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    expect(raw.connections[0].password.startsWith('enc:v1:')).toBe(true);
    expect(raw.hostTrustRecords).toHaveLength(1);
    expect(store.read().connections[0].password).toBe('super-secret');
    expect(store.trustRecords()[0].fingerprint).toBe('SHA256:new');
  });

  it('returns an empty connection list when no config exists', () => {
    const store = createConfigStore({ dataDir });
    expect(store.read().connections).toEqual([]);
    expect(listConnectionSummaries(store.read(), store.trustRecords())).toEqual([]);
  });
});