import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

interface SecretStore {
  encrypt: (value: unknown) => unknown;
  decrypt: (value: unknown) => unknown;
  encryptStore: (store: any) => any;
  decryptStore: (store: any) => any;
  isEncrypted: (value: unknown) => boolean;
  keySource: 'env' | 'file';
  resetCache: () => void;
}

const { createSecretStore, isEncrypted, PREFIX, KEY_FILE } = require(
  path.join(ROOT, 'server', 'secret-store.cjs'),
) as {
  createSecretStore: (options?: { dataDir?: string; passphrase?: string }) => SecretStore;
  isEncrypted: (value: unknown) => boolean;
  PREFIX: string;
  KEY_FILE: string;
};

let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-secret-'));
  // 解密失败会打告警，测试中静音以免刷屏（断言处按需单独 mock）。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 单个值
// ---------------------------------------------------------------------------

describe('encrypt / decrypt 单值', () => {
  it('加解密往返一致', () => {
    const store = createSecretStore({ dataDir });
    const plain = 'p@ssw0rd-中文-🔐';

    const cipher = store.encrypt(plain);

    expect(typeof cipher).toBe('string');
    expect(cipher).not.toBe(plain);
    expect((cipher as string).startsWith(PREFIX)).toBe(true);
    expect(store.decrypt(cipher)).toBe(plain);
  });

  it('密文不包含明文片段（不是编码/混淆）', () => {
    const store = createSecretStore({ dataDir });
    const cipher = store.encrypt('SUPER-SECRET-VALUE') as string;

    expect(cipher).not.toContain('SUPER-SECRET-VALUE');
    expect(Buffer.from(cipher, 'utf8').toString('utf8')).not.toContain('SUPER');
  });

  it('同一明文两次加密得到不同密文（随机 IV）', () => {
    const store = createSecretStore({ dataDir });

    const first = store.encrypt('same-input');
    const second = store.encrypt('same-input');

    expect(first).not.toBe(second);
    expect(store.decrypt(first)).toBe('same-input');
    expect(store.decrypt(second)).toBe('same-input');
  });

  it('空值与非字符串原样返回，不产生密文', () => {
    const store = createSecretStore({ dataDir });

    expect(store.encrypt('')).toBe('');
    expect(store.encrypt(undefined)).toBeUndefined();
    expect(store.encrypt(null)).toBeNull();
    expect(store.encrypt(42)).toBe(42);
  });

  it('encrypt 幂等：已加密的值不会被再次包裹', () => {
    const store = createSecretStore({ dataDir });
    const once = store.encrypt('value') as string;

    expect(store.encrypt(once)).toBe(once);
    expect(store.decrypt(store.encrypt(once))).toBe('value');
  });

  it('历史明文数据原样返回，便于渐进迁移', () => {
    const store = createSecretStore({ dataDir });

    expect(store.decrypt('legacy-plaintext-password')).toBe('legacy-plaintext-password');
    expect(isEncrypted('legacy-plaintext-password')).toBe(false);
  });

  it('密文被篡改时解密返回 null（GCM 认证失败），不抛异常', () => {
    const store = createSecretStore({ dataDir });
    const cipher = store.encrypt('tamper-me') as string;
    const parts = cipher.slice(PREFIX.length).split(':');
    // 翻转密文最后一个字符
    const last = parts[2].slice(-2);
    const flipped = last === 'AA' ? 'BB' : 'AA';
    const tampered = `${PREFIX}${parts[0]}:${parts[1]}:${parts[2].slice(0, -2)}${flipped}`;

    expect(store.decrypt(tampered)).toBeNull();
  });

  it('格式损坏的密文返回 null', () => {
    const store = createSecretStore({ dataDir });

    expect(store.decrypt(`${PREFIX}only-one-part`)).toBeNull();
    expect(store.decrypt(`${PREFIX}a:b`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 密钥来源与重启
// ---------------------------------------------------------------------------

describe('密钥来源', () => {
  it('文件模式：生成 0600 的 secret.key，且新实例（模拟重启）仍能解密', () => {
    const first = createSecretStore({ dataDir });
    const cipher = first.encrypt('survives-restart') as string;

    const keyPath = path.join(dataDir, KEY_FILE);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath).length).toBe(32);
    // Windows 上 mode 位不被完整支持，仅在类 Unix 平台断言
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }

    const second = createSecretStore({ dataDir });
    expect(second.decrypt(cipher)).toBe('survives-restart');
    expect(first.keySource).toBe('file');
  });

  it('文件模式：密钥不匹配时返回 null 而不是抛异常', () => {
    const first = createSecretStore({ dataDir });
    const cipher = first.encrypt('secret-a') as string;

    // 换一个数据目录 → 换一把密钥
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-secret-other-'));
    try {
      const other = createSecretStore({ dataDir: otherDir });
      expect(other.decrypt(cipher)).toBeNull();
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('env 模式：从口令派生密钥，不写密钥文件', () => {
    const store = createSecretStore({ dataDir, passphrase: 'deploy-passphrase' });
    const cipher = store.encrypt('env-protected') as string;

    expect(store.keySource).toBe('env');
    expect(fs.existsSync(path.join(dataDir, KEY_FILE))).toBe(false);
    expect(store.decrypt(cipher)).toBe('env-protected');

    // 同一口令的新实例（模拟重启）仍可解密
    const restarted = createSecretStore({ dataDir, passphrase: 'deploy-passphrase' });
    expect(restarted.decrypt(cipher)).toBe('env-protected');
  });

  it('env 模式：更换口令后无法解密（返回 null）', () => {
    const store = createSecretStore({ dataDir, passphrase: 'old-passphrase' });
    const cipher = store.encrypt('rotated') as string;

    const rotated = createSecretStore({ dataDir, passphrase: 'new-passphrase' });
    expect(rotated.decrypt(cipher)).toBeNull();
  });

  it('解密失败只告警一次，避免刷屏', () => {
    const store = createSecretStore({ dataDir });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cipher = store.encrypt('x') as string;

    const other = createSecretStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'x-')) });
    other.decrypt(cipher);
    other.decrypt(cipher);
    other.decrypt(cipher);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 整个 store
// ---------------------------------------------------------------------------

describe('encryptStore / decryptStore', () => {
  const buildStore = () => ({
    connections: [
      {
        id: 'c1',
        name: 'prod',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        password: 'ssh-password',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        passphrase: 'key-passphrase',
      },
      { id: 'c2', name: 'no-secret', host: '10.0.0.2', port: 22, username: 'ubuntu' },
    ],
    aiProviders: [
      { id: 'p1', name: 'openai', type: 'openai', apiKey: 'sk-secret-key', isActive: true },
      { id: 'p2', name: 'ollama', type: 'ollama', isActive: false },
    ],
    settings: { theme: 'dark' },
    hostTrustRecords: [{ host: 'a.com', port: 22, fingerprint: 'SHA256:x' }],
  });

  it('往返后凭据恢复原值，非敏感字段不受影响', () => {
    const store = createSecretStore({ dataDir });
    const original = buildStore();

    const encrypted = store.encryptStore(original);
    const restored = store.decryptStore(encrypted);

    expect(restored.connections[0].password).toBe('ssh-password');
    expect(restored.connections[0].privateKey).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(restored.connections[0].passphrase).toBe('key-passphrase');
    expect(restored.aiProviders[0].apiKey).toBe('sk-secret-key');

    expect(restored.connections[0]).toMatchObject({ id: 'c1', name: 'prod', host: '10.0.0.1' });
    expect(restored.settings).toEqual({ theme: 'dark' });
    expect(restored.hostTrustRecords).toHaveLength(1);
  });

  it('落盘形态中不含任何明文凭据', () => {
    const store = createSecretStore({ dataDir });
    const serialized = JSON.stringify(store.encryptStore(buildStore()));

    expect(serialized).not.toContain('ssh-password');
    expect(serialized).not.toContain('key-passphrase');
    expect(serialized).not.toContain('sk-secret-key');
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    // 但元数据仍然可读（便于排错与手工检查）
    expect(serialized).toContain('10.0.0.1');
    expect(serialized).toContain('prod');
  });

  it('缺失敏感字段的连接不会被凭空补上字段', () => {
    const store = createSecretStore({ dataDir });
    const encrypted = store.encryptStore(buildStore());
    const restored = store.decryptStore(encrypted);

    expect('password' in restored.connections[1]).toBe(false);
    expect('apiKey' in restored.aiProviders[1]).toBe(false);
  });

  it('不修改入参对象（返回浅拷贝）', () => {
    const store = createSecretStore({ dataDir });
    const original = buildStore();

    store.encryptStore(original);

    expect(original.connections[0].password).toBe('ssh-password');
    expect(original.aiProviders[0].apiKey).toBe('sk-secret-key');
  });

  it('非数组/异常输入安全返回', () => {
    const store = createSecretStore({ dataDir });

    expect(store.encryptStore(null)).toBeNull();
    expect(store.encryptStore({ connections: 'not-an-array' }).connections).toBe('not-an-array');
    expect(store.encryptStore({ connections: [null, 'x', 5] }).connections).toEqual([null, 'x', 5]);
  });

  it('明文与密文混合的历史数据可同时解密（迁移期）', () => {
    const store = createSecretStore({ dataDir });
    const mixed = {
      connections: [
        { id: 'old', password: 'plaintext-legacy' },
        { id: 'new', password: store.encrypt('already-encrypted') },
      ],
    };

    const restored = store.decryptStore(mixed);
    expect(restored.connections[0].password).toBe('plaintext-legacy');
    expect(restored.connections[1].password).toBe('already-encrypted');
  });

  it('再次写盘的混合数据会被全部加密', () => {
    const store = createSecretStore({ dataDir });
    const mixed = {
      connections: [
        { id: 'old', password: 'plaintext-legacy' },
        { id: 'new', password: store.encrypt('already-encrypted') },
      ],
    };

    const encrypted = store.encryptStore(mixed);
    expect(store.isEncrypted(encrypted.connections[0].password)).toBe(true);
    expect(store.isEncrypted(encrypted.connections[1].password)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain('plaintext-legacy');
  });
});
