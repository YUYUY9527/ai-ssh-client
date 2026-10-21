import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createServices, joinRemotePath } from '../server/mcp/services.cjs';

const connection = {
  id: 'c1',
  name: 'demo',
  host: '10.0.0.9',
  port: 22,
  username: 'root',
  password: 'pw',
};

function buildServices(overrides: {
  policy?: any;
  pool?: any;
  audit?: any;
} = {}) {
  const policy = overrides.policy || {
    execAllowed: true,
    trustOnFirstUse: false,
    execTimeoutMs: 30_000,
    maxOutputBytes: 1024,
    maxReadBytes: 1024,
    evaluateCommand: vi.fn(() => ({ allowed: true, code: 'ok' })),
    describe: () => ({ execAllowed: true }),
  };
  const pool = overrides.pool || {
    exec: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 7,
      stdout: 'ok\n',
      stderr: '',
      truncated: false,
    })),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({ type: 'file', size: 5, mode: '644' })),
    withSftp: vi.fn(),
    observedFingerprint: () => 'SHA256:observed',
    closeAll: vi.fn(),
  };
  const audit = overrides.audit || { enabled: true, file: '/tmp/audit.log', record: vi.fn() };
  const config = {
    read: () => ({ connections: [connection], hostTrustRecords: [] }),
    trustRecords: () => [],
    saveTrustRecords: vi.fn(),
  };
  const services = createServices({
    env: {},
    deps: { config, policy, pool, audit, hostTrust: {} },
  });
  return { services, policy, pool, audit };
}

describe('mcp services', () => {
  it('lists connections without credentials', () => {
    const { services } = buildServices();
    const result = services.listConnections();
    expect(result.count).toBe(1);
    expect(result.connections[0]).toMatchObject({ id: 'c1', name: 'demo', authType: 'password' });
    expect(JSON.stringify(result)).not.toContain('"pw"');
  });

  it('refuses blocked commands before touching SSH and audits the refusal', async () => {
    const evaluateCommand = vi.fn(() => ({
      allowed: false,
      code: 'blocked',
      rule: 'rm-critical-target',
      reason: '禁止递归删除关键路径',
    }));
    const { services, pool, audit } = buildServices({
      policy: {
        execAllowed: true,
        trustOnFirstUse: false,
        execTimeoutMs: 30_000,
        maxOutputBytes: 1024,
        maxReadBytes: 1024,
        evaluateCommand,
        describe: () => ({}),
      },
    });

    await expect(services.execCommand({ connection_id: 'c1', command: 'rm -rf /' }))
      .rejects.toThrow('禁止递归删除关键路径');
    expect(pool.exec).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'ssh_exec',
      outcome: 'blocked',
      rule: 'rm-critical-target',
    }));
  });

  it('runs allowed commands, clamps timeouts, and audits the result', async () => {
    const { services, pool, audit } = buildServices();
    const result = await services.execCommand({
      connection_id: 'c1',
      command: 'uptime',
      timeout_ms: 999_999,
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok\n', timedOut: false });
    expect(pool.exec).toHaveBeenCalledWith('c1', 'uptime', {
      timeoutMs: 300_000,
      maxOutputBytes: 1024,
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'ssh_exec',
      outcome: 'ok',
      exitCode: 0,
    }));
  });

  it('sorts directories first, joins display paths, and truncates huge listings', async () => {
    const entries = [
      { name: 'z.txt', type: 'file', size: 1, mode: '644' },
      { name: 'alpha', type: 'directory', size: 0, mode: '755' },
    ];
    const huge = Array.from({ length: 1001 }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}`,
      type: 'file',
      size: index,
      mode: '644',
    }));
    const pool = {
      exec: vi.fn(),
      list: vi.fn(async (_id: string, path: string) => (path === '/huge' ? huge : entries)),
      stat: vi.fn(),
      withSftp: vi.fn(),
      observedFingerprint: () => null,
      closeAll: vi.fn(),
    };
    const { services } = buildServices({ pool });

    const listing = await services.listDirectory({ connection_id: 'c1', path: '~/demo' });
    expect(listing.entries.map((entry: any) => entry.name)).toEqual(['alpha', 'z.txt']);
    expect(listing.entries[0].path).toBe('~/demo/alpha');

    const capped = await services.listDirectory({ connection_id: 'c1', path: '/huge' });
    expect(capped.count).toBe(1001);
    expect(capped.truncated).toBe(true);
    expect(capped.entries).toHaveLength(1000);
  });

  it('reads a text file through the shared sftp reader', async () => {
    const sftp = {
      stat: (remotePath: string, callback: Function) => callback(null, {
        isDirectory: () => false,
        size: 5,
      }),
      createReadStream: () => Readable.from([Buffer.from('hello')]),
    };
    const pool = {
      exec: vi.fn(),
      list: vi.fn(),
      stat: vi.fn(),
      withSftp: vi.fn(async (_id: string, task: Function) => task(sftp)),
      observedFingerprint: () => null,
      closeAll: vi.fn(),
    };
    const { services } = buildServices({ pool });

    const file = await services.readFile({ connection_id: 'c1', path: '/tmp/a.txt' });
    expect(file).toMatchObject({ path: '/tmp/a.txt', content: 'hello', size: 5, encoding: 'utf-8' });
  });

  it('reports server policy and joins remote paths safely', async () => {
    const { services } = buildServices();
    expect(services.getServerInfo()).toMatchObject({
      name: 'ai-ssh-client',
      policy: { execAllowed: true },
    });
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
    expect(joinRemotePath('.', 'a.txt')).toBe('./a.txt');
    expect(joinRemotePath('~', 'a.txt')).toBe('~/a.txt');
  });
});