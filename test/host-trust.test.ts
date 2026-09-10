import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ssh2 未提供类型声明，这里按测试所需的最小接口使用。
const { Server, Client, utils } = require('ssh2') as {
  Server: any;
  Client: any;
  utils: { generateKeyPairSync: (type: string) => { private: string; public: string } };
};

interface HostTrustRecord {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  trustedAt: number;
}

interface TrustPrompt {
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  kind: 'firstConnect' | 'keyChanged';
  previousAlgorithm?: string;
  previousFingerprint?: string;
}

interface HostTrust {
  getRecord: (host: string, port?: number) => HostTrustRecord | null;
  listRecords: () => HostTrustRecord[];
  upsertRecord: (record: Partial<HostTrustRecord>) => HostTrustRecord;
  deleteRecord: (host: string, port?: number) => boolean;
  clearRecords: () => void;
  respond: (requestId: string, accepted: boolean) => boolean;
  pendingCount: () => number;
  createVerifier: (input: {
    host: string;
    port?: number;
    clientId?: string;
  }) => (key: Buffer, verify: (permitted: boolean) => void) => void;
}

const { createHostTrust, fingerprintOf, DEFAULT_PROMPT_TIMEOUT_MS } = require(
  path.join(ROOT, 'server', 'host-trust.cjs'),
) as {
  createHostTrust: (options: Record<string, unknown>) => HostTrust;
  fingerprintOf: (key: Buffer) => string;
  DEFAULT_PROMPT_TIMEOUT_MS: number;
};

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

interface Harness {
  trust: HostTrust;
  prompts: Array<{ clientId: string; prompt: TrustPrompt }>;
  records: HostTrustRecord[];
  setDeliver: (count: number) => void;
}

function createHarness(overrides: Record<string, unknown> = {}): Harness {
  let records: HostTrustRecord[] = [];
  const prompts: Array<{ clientId: string; prompt: TrustPrompt }> = [];
  let deliver = 1;

  const trust = createHostTrust({
    loadRecords: () => records,
    saveRecords: (next: HostTrustRecord[]) => {
      records = next;
    },
    emitPrompt: (clientId: string, prompt: TrustPrompt) => {
      prompts.push({ clientId, prompt });
      return deliver;
    },
    now: () => 1_700_000_000_000,
    promptTimeoutMs: 200,
    ...overrides,
  });

  return {
    trust,
    prompts,
    get records() {
      return records;
    },
    setDeliver: (count: number) => {
      deliver = count;
    },
  } as Harness;
}

const openServers: any[] = [];

async function startSshServer(hostKey: { private: string }): Promise<number> {
  const server = new Server({ hostKeys: [hostKey.private] }, (client: any) => {
    client.on('error', () => {});
    client.on('authentication', (ctx: any) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept: any) => accept().on('pty').on('shell').on('exec', (a: any) => a()));
    });
  });
  server.on('error', () => {});
  openServers.push(server);

  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** 用给定的 hostVerifier 真连一次，返回握手是否成功。 */
function connectOnce(
  port: number,
  hostVerifier: (key: Buffer, verify: (permitted: boolean) => void) => void,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const client = new Client();
    client
      .on('ready', () => {
        client.end();
        resolve({ ok: true });
      })
      .on('error', (error: Error) => resolve({ ok: false, error: error.message }))
      .connect({
        host: '127.0.0.1',
        port,
        username: 'probe',
        password: 'x',
        readyTimeout: 5000,
        hostVerifier,
      });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: condition not met in time');
}

/** 走完整的一次握手：等提示 → 按 choose 决定 → 返回结果与提示。 */
async function handshake(port: number, harness: Harness, choose: boolean | 'none') {
  const verifier = harness.trust.createVerifier({
    host: '127.0.0.1',
    port,
    clientId: 'web-client:test',
  });
  const pending = connectOnce(port, verifier);
  if (choose !== 'none') {
    await waitFor(() => harness.prompts.length > 0);
    const { requestId } = harness.prompts[harness.prompts.length - 1].prompt;
    harness.trust.respond(requestId, choose);
  }
  return { result: await pending, prompt: harness.prompts[harness.prompts.length - 1]?.prompt };
}

afterEach(() => {
  while (openServers.length > 0) {
    openServers.pop()?.close();
  }
});

// ---------------------------------------------------------------------------
// 指纹与算法
// ---------------------------------------------------------------------------

describe('fingerprintOf', () => {
  it('输出 OpenSSH 风格 SHA256 指纹且不带 base64 padding', () => {
    const key = Buffer.from('probe-key-material');
    const expected = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    const fingerprint = fingerprintOf(key);

    expect(fingerprint).toBe(`SHA256:${expected}`);
    expect(fingerprint.startsWith('SHA256:')).toBe(true);
    expect(fingerprint).not.toContain('=');
  });

  it('不同密钥得到不同指纹', () => {
    expect(fingerprintOf(Buffer.from('a'))).not.toBe(fingerprintOf(Buffer.from('b')));
  });
});

// ---------------------------------------------------------------------------
// 真实 SSH 握手：首次连接
// ---------------------------------------------------------------------------

describe('主机指纹校验（真实握手）', () => {
  it('首次连接先询问用户，接受后握手成功并落盘信任记录', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();

    const { result, prompt } = await handshake(port, harness, true);

    expect(result.ok).toBe(true);
    expect(prompt).toBeTruthy();
    expect(prompt!.kind).toBe('firstConnect');
    expect(prompt!.host).toBe('127.0.0.1');
    expect(prompt!.port).toBe(port);
    expect(prompt!.fingerprint.startsWith('SHA256:')).toBe(true);
    expect(prompt!.algorithm).toBeTruthy();
    // 首次连接没有"上一个指纹"
    expect(prompt!.previousFingerprint).toBeUndefined();

    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]).toMatchObject({
      host: '127.0.0.1',
      port,
      algorithm: prompt!.algorithm,
      fingerprint: prompt!.fingerprint,
      trustedAt: 1_700_000_000_000,
    });
  });

  it('用户拒绝时握手失败，且不写入信任记录', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();

    const { result } = await handshake(port, harness, false);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Host denied');
    expect(harness.records).toHaveLength(0);
  });

  it('已信任且指纹一致时静默放行，不再打扰用户', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();

    // 第一次：接受并落盘
    const first = await handshake(port, harness, true);
    expect(first.result.ok).toBe(true);
    const promptCountAfterFirst = harness.prompts.length;

    // 第二次：应直接通过
    const second = await handshake(port, harness, 'none');
    expect(second.result.ok).toBe(true);
    expect(harness.prompts.length).toBe(promptCountAfterFirst);
    expect(harness.records).toHaveLength(1);
  });

  it('等待确认超时则握手失败', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness({ promptTimeoutMs: 80 });

    const { result } = await handshake(port, harness, 'none');

    expect(result.ok).toBe(false);
    expect(harness.records).toHaveLength(0);
    expect(harness.trust.pendingCount()).toBe(0);
  });

  it('无人可问（送达 0 个 socket）时立即失败，不等满超时窗口', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness({ promptTimeoutMs: 10000 });
    harness.setDeliver(0);

    const startedAt = Date.now();
    const { result } = await handshake(port, harness, 'none');
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(3000);
    expect(harness.trust.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 密钥变更
// ---------------------------------------------------------------------------

describe('主机密钥变更', () => {
  it('变更时提示 kind=keyChanged 并带上旧指纹', async () => {
    const firstKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(firstKey);

    // 先信任第一把密钥
    const trustedFingerprint = 'SHA256:previously-trusted';
    const harness = createHarness();
    harness.trust.upsertRecord({
      host: '127.0.0.1',
      port,
      algorithm: 'ssh-ed25519',
      fingerprint: trustedFingerprint,
      trustedAt: 1,
    });

    const { result, prompt } = await handshake(port, harness, true);

    expect(result.ok).toBe(true);
    expect(prompt!.kind).toBe('keyChanged');
    expect(prompt!.previousFingerprint).toBe(trustedFingerprint);
    expect(prompt!.previousAlgorithm).toBe('ssh-ed25519');
    expect(prompt!.fingerprint).not.toBe(trustedFingerprint);
    // 接受后记录被新指纹覆盖
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].fingerprint).toBe(prompt!.fingerprint);
  });

  it('变更时拒绝则握手失败，且保留原信任记录不被覆盖', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();
    harness.trust.upsertRecord({
      host: '127.0.0.1',
      port,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:previously-trusted',
      trustedAt: 1,
    });

    const { result, prompt } = await handshake(port, harness, false);

    expect(result.ok).toBe(false);
    expect(prompt!.kind).toBe('keyChanged');
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].fingerprint).toBe('SHA256:previously-trusted');
  });

  it('指纹一致但算法不同时仍要求确认', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({
      host: 'example.com',
      port: 22,
      algorithm: 'ssh-rsa',
      fingerprint: 'SHA256:same',
      trustedAt: 1,
    });

    const verifier = harness.trust.createVerifier({ host: 'example.com', port: 22 });
    let permitted: boolean | null = null;
    verifier(Buffer.from('whatever'), (ok) => {
      permitted = ok;
    });

    // 未直接放行，而是发出了新的确认请求
    expect(permitted).toBeNull();
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0].prompt.kind).toBe('keyChanged');
  });
});

// ---------------------------------------------------------------------------
// 无人值守模式
// ---------------------------------------------------------------------------

describe('WEB_SSH_TRUST_ON_FIRST_USE 无人值守模式', () => {
  it('自动信任未记录过的主机并落盘，不弹提示', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness({ trustOnFirstUse: true });

    const { result } = await handshake(port, harness, 'none');

    expect(result.ok).toBe(true);
    expect(harness.prompts).toHaveLength(0);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0].port).toBe(port);
  });

  it('已记录主机出现密钥变更时不自动放行：有人可问则询问，无人可问立即拒绝', () => {
    // 场景一：有活动页面（送达 1）→ 发提示等待确认，绝不自动接受
    const withUi = createHarness({ trustOnFirstUse: true });
    withUi.trust.upsertRecord({
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:previously-trusted',
      trustedAt: 1,
    });

    let permitted: boolean | null = null;
    withUi.trust.createVerifier({ host: '127.0.0.1', port: 22 })(Buffer.from('changed-key'), (ok) => {
      permitted = ok;
    });

    expect(permitted).toBeNull();
    expect(withUi.prompts).toHaveLength(1);
    expect(withUi.prompts[0].prompt.kind).toBe('keyChanged');

    withUi.trust.respond(withUi.prompts[0].prompt.requestId, false);
    expect(permitted).toBe(false);
    expect(withUi.records[0].fingerprint).toBe('SHA256:previously-trusted');

    // 场景二：无人可问（送达 0，纯自动化）→ 立即拒绝，不空等超时窗口
    const headless = createHarness({ trustOnFirstUse: true, promptTimeoutMs: 10000 });
    headless.trust.upsertRecord({
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:previously-trusted',
      trustedAt: 1,
    });
    headless.setDeliver(0);

    const startedAt = Date.now();
    let headlessPermitted: boolean | null = null;
    headless.trust.createVerifier({ host: '127.0.0.1', port: 22 })(
      Buffer.from('changed-key'),
      (ok) => {
        headlessPermitted = ok;
      },
    );

    expect(headlessPermitted).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(headless.records[0].fingerprint).toBe('SHA256:previously-trusted');
  });
});

// ---------------------------------------------------------------------------
// 记录管理
// ---------------------------------------------------------------------------

describe('信任记录管理', () => {
  it('upsert 覆盖同一 host+port，不产生重复项', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({ host: 'a.com', port: 22, fingerprint: 'SHA256:1' });
    harness.trust.upsertRecord({ host: 'a.com', port: 22, fingerprint: 'SHA256:2' });
    harness.trust.upsertRecord({ host: 'a.com', port: 2222, fingerprint: 'SHA256:3' });

    expect(harness.records).toHaveLength(2);
    expect(harness.trust.getRecord('a.com', 22)?.fingerprint).toBe('SHA256:2');
    expect(harness.trust.getRecord('a.com', 2222)?.fingerprint).toBe('SHA256:3');
  });

  it('port 缺省按 22 归一化', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({ host: 'a.com', fingerprint: 'SHA256:1' });

    expect(harness.records[0].port).toBe(22);
    expect(harness.trust.getRecord('a.com')?.fingerprint).toBe('SHA256:1');
    expect(harness.trust.getRecord('a.com', 22)?.fingerprint).toBe('SHA256:1');
  });

  it('缺少 host 或 fingerprint 时拒绝写入', () => {
    const harness = createHarness();

    expect(() => harness.trust.upsertRecord({ port: 22, fingerprint: 'SHA256:1' })).toThrow(/Host/);
    expect(() => harness.trust.upsertRecord({ host: 'a.com', port: 22 })).toThrow(/Fingerprint/);
    expect(harness.records).toHaveLength(0);
  });

  it('delete 返回是否命中，clear 清空全部', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({ host: 'a.com', port: 22, fingerprint: 'SHA256:1' });
    harness.trust.upsertRecord({ host: 'b.com', port: 22, fingerprint: 'SHA256:2' });

    expect(harness.trust.deleteRecord('a.com', 22)).toBe(true);
    expect(harness.trust.deleteRecord('a.com', 22)).toBe(false);
    expect(harness.trust.listRecords()).toHaveLength(1);

    harness.trust.clearRecords();
    expect(harness.trust.listRecords()).toHaveLength(0);
  });

  it('list 按 trustedAt 倒序（最近信任的在前）', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({ host: 'old.com', port: 22, fingerprint: 'SHA256:1', trustedAt: 100 });
    harness.trust.upsertRecord({ host: 'new.com', port: 22, fingerprint: 'SHA256:2', trustedAt: 900 });
    harness.trust.upsertRecord({ host: 'mid.com', port: 22, fingerprint: 'SHA256:3', trustedAt: 500 });

    expect(harness.trust.listRecords().map((item) => item.host)).toEqual([
      'new.com',
      'mid.com',
      'old.com',
    ]);
  });

  it('algorithm 缺省记为 unknown', () => {
    const harness = createHarness();
    harness.trust.upsertRecord({ host: 'a.com', port: 22, fingerprint: 'SHA256:1' });

    expect(harness.records[0].algorithm).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 确认响应
// ---------------------------------------------------------------------------

describe('respond 语义', () => {
  it('未知 requestId 返回 false，重复响应第二次返回 false', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();

    expect(harness.trust.respond('not-a-request', true)).toBe(false);

    const verifier = harness.trust.createVerifier({ host: '127.0.0.1', port });
    const pending = connectOnce(port, verifier);
    await waitFor(() => harness.prompts.length > 0);

    const { requestId } = harness.prompts[0].prompt;
    expect(harness.trust.pendingCount()).toBe(1);
    expect(harness.trust.respond(requestId, true)).toBe(true);
    // 已结算：再次响应不再命中
    expect(harness.trust.respond(requestId, true)).toBe(false);
    expect(harness.trust.pendingCount()).toBe(0);

    expect((await pending).ok).toBe(true);
  });

  it('把 clientId 透传给 emitPrompt，便于定向推送到发起连接的页面', async () => {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const port = await startSshServer(hostKey);
    const harness = createHarness();

    const verifier = harness.trust.createVerifier({
      host: '127.0.0.1',
      port,
      clientId: 'web-client:abc',
    });
    const pending = connectOnce(port, verifier);
    await waitFor(() => harness.prompts.length > 0);

    expect(harness.prompts[0].clientId).toBe('web-client:abc');
    harness.trust.respond(harness.prompts[0].prompt.requestId, true);
    await pending;
  });

  it('默认超时与桌面端一致（90s）', () => {
    expect(DEFAULT_PROMPT_TIMEOUT_MS).toBe(90_000);
  });
});
