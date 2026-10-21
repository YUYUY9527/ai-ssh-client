import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2') as {
  Server: any;
  utils: { generateKeyPairSync: (type: string) => { private: string; public: string } };
};
const { createSecretStore } = require('../server/secret-store.cjs');
const { createServices } = require('../server/mcp/services.cjs');
const { writePolicyFile } = require('../server/mcp/policy-file.cjs');

/**
 * 真连一次本地 ssh2 服务：验证 ssh2 连接、主机指纹 TOFU、exec 通道、
 * 退出码/超时结算，以及被策略拦截的命令不会到达远端。
 * 不依赖任何外部主机。
 */
describe('mcp ssh integration', () => {
  let dataDir = '';
  let server: any;
  let port = 0;
  let services: any;
  const executed: string[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-int-'));
    const { private: hostKey } = utils.generateKeyPairSync('ed25519');

    server = new Server({ hostKeys: [hostKey] }, (client: any) => {
      client.on('authentication', (ctx: any) => {
        if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'secret') {
          ctx.accept();
        } else {
          ctx.reject();
        }
      });
      client.on('ready', () => {
        client.on('session', (accept: any) => {
          const session = accept();
          session.on('exec', (acceptExec: any, _reject: any, info: any) => {
            executed.push(info.command);
            const stream = acceptExec();
            if (info.command === 'fail') {
              stream.stderr.write('boom\n');
              stream.exit(3);
            } else {
              stream.write(`ran:${info.command}\n`);
              stream.exit(0);
            }
            stream.end();
          });
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;

    const secretStore = createSecretStore({ dataDir });
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify(secretStore.encryptStore({
        connections: [{
          id: 'local',
          name: 'local',
          host: '127.0.0.1',
          port,
          username: 'test',
          password: 'secret',
        }],
        hostTrustRecords: [],
      })),
    );

    // 通过策略文件开启执行（不设 MCP_ALLOW_EXEC），验证页面/文件这条链路。
    writePolicyFile({
      dataDir,
      env: {},
      policy: { defaultMode: 'exec', trustOnFirstUse: true },
    });

    services = createServices({
      env: {
        AI_SSH_DATA_DIR: dataDir,
        MCP_AUDIT: '0',
      },
    });
  });

  afterAll(async () => {
    services?.close();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('connects, trusts the host on first use, and reports the fingerprint', async () => {
    const result = await services.testConnection({ connection_id: 'local' });
    expect(result).toMatchObject({
      ok: true,
      connection: { id: 'local', host: '127.0.0.1', port, username: 'test' },
    });
    expect(result.hostKeyFingerprint).toMatch(/^SHA256:.+/);
    expect(services.getServerInfo()).toMatchObject({
      policyFile: { exists: true },
      policy: { defaultMode: 'exec' },
    });
  });

  it('runs commands through the ssh exec channel and returns stdout/exitCode', async () => {
    const result = await services.execCommand({ connection_id: 'local', command: 'echo hi' });
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: 'ran:echo hi\n',
      stderr: '',
    });
    expect(executed).toContain('echo hi');

    const failed = await services.execCommand({ connection_id: 'local', command: 'fail' });
    expect(failed).toMatchObject({ exitCode: 3, stderr: 'boom\n' });
  });

  it('never sends a blocked command to the remote host', async () => {
    const before = executed.length;
    await expect(services.execCommand({ connection_id: 'local', command: 'rm -rf /' }))
      .rejects.toThrow(/禁止递归删除关键路径/);
    expect(executed.length).toBe(before);
  });

  it('fails fast on unknown connections without opening an SSH connection', async () => {
    await expect(services.execCommand({ connection_id: 'nope', command: 'echo hi' }))
      .rejects.toThrow(/未知连接/);
  });
});