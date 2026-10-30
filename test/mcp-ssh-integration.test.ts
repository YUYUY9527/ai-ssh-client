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
 *
 * 另起第二台本地 ssh2 服务，验证 #4：改了 config.json 里的 host/port/凭据后，
 * 同一个 connection id 的下一次 exec 必须落到新主机，而不是继续用旧连接。
 */
describe('mcp ssh integration', () => {
  let dataDir = '';
  let server: any;
  let server2: any;
  let port = 0;
  let port2 = 0;
  let services: any;
  const executed: string[] = [];
  const executed2: string[] = [];
  let connections1 = 0;
  let connections2 = 0;

  /** 起一台最小的本地 ssh2 服务，记录执行过的命令与建连次数。 */
  function makeServer(executedList: string[], passwords: string[], onReady: () => void) {
    const { private: hostKey } = utils.generateKeyPairSync('ed25519');
    return new Server({ hostKeys: [hostKey] }, (client: any) => {
      client.on('authentication', (ctx: any) => {
        if (ctx.method === 'password' && ctx.username === 'test' && passwords.includes(ctx.password)) {
          ctx.accept();
        } else {
          ctx.reject();
        }
      });
      client.on('ready', () => {
        onReady();
        client.on('session', (accept: any) => {
          const session = accept();
          session.on('exec', (acceptExec: any, _reject: any, info: any) => {
            executedList.push(info.command);
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
  }

  /** 用与生产一致的加密 store 重写 config.json，让 MCP 侧读到新的连接配置。 */
  function writeConfig(portValue: number, password = 'secret') {
    const secretStore = createSecretStore({ dataDir });
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify(secretStore.encryptStore({
        connections: [{
          id: 'local',
          name: 'local',
          host: '127.0.0.1',
          port: portValue,
          username: 'test',
          password,
        }],
        hostTrustRecords: [],
      })),
    );
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-int-'));

    server = makeServer(executed, ['secret'], () => { connections1 += 1; });
    server2 = makeServer(executed2, ['secret', 'secret2'], () => { connections2 += 1; });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    port2 = server2.address().port;

    writeConfig(port);

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
    if (server2) {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
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

  it('reuses the pooled connection while the config is unchanged', async () => {
    const connectionsBefore = connections1;
    const executedBefore = executed.length;

    await services.execCommand({ connection_id: 'local', command: 'reuse-a' });
    await services.execCommand({ connection_id: 'local', command: 'reuse-b' });

    expect(executed.length).toBe(executedBefore + 2);
    // 配置没变，不应该重新建连。
    expect(connections1).toBe(connectionsBefore);
  });

  it('reconnects to the new host/port after config changes and lands on the new server', async () => {
    const oldExecutedBefore = executed.length;
    const oldConnectionsBefore = connections1;

    // 同一个 connection id，把 host/port 指到第二台服务器（凭据不变）。
    writeConfig(port2);

    const result = await services.execCommand({ connection_id: 'local', command: 'after-host-change' });
    expect(result.exitCode).toBe(0);
    // 命令必须落在新服务器，而不是旧服务器。
    expect(executed2).toContain('after-host-change');
    expect(executed.length).toBe(oldExecutedBefore);
    expect(connections2).toBe(1);

    // 配置再次不变时应复用新服务器的连接，不再建连，也不会回到旧服务器。
    await services.execCommand({ connection_id: 'local', command: 'second-on-new' });
    expect(executed2).toContain('second-on-new');
    expect(connections2).toBe(1);
    expect(connections1).toBe(oldConnectionsBefore);
  });

  it('reconnects when credentials change even on the same host/port', async () => {
    const connectionsBefore = connections2;
    const executedBefore = executed2.length;

    // 同一主机同一端口，只改密码（第二台服务器同时接受 secret2）。
    writeConfig(port2, 'secret2');

    const result = await services.execCommand({ connection_id: 'local', command: 'after-cred-change' });
    expect(result.exitCode).toBe(0);
    expect(executed2).toContain('after-cred-change');
    expect(executed2.length).toBe(executedBefore + 1);
    // 凭据变了，必须重新建连。
    expect(connections2).toBe(connectionsBefore + 1);
  });
});
