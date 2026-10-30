import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpHandler, createServicesHolder } from '../server/mcp/http.mjs';

/**
 * `/mcp` 端点的端到端测试：真实 HTTP + MCP SDK 客户端。
 * 覆盖鉴权、工具列表、连接摘要、策略热重载；不连真实 SSH。
 */

let dataDir: string;
let server: http.Server;
let endpoint: string;
let handler: ReturnType<typeof createMcpHttpHandler>;

function writeConfig() {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    connections: [{
      id: 'c1',
      name: 'demo',
      host: '10.0.0.9',
      port: 22,
      username: 'root',
      password: 'plain-password',
    }],
    settings: {},
    aiProviders: [],
    commandHistory: [],
    quickCommands: [],
    quickCommandGroups: [],
    agentTasks: [],
    hostTrustRecords: [],
  }));
}

function makeClient() {
  return new Client({ name: 'http-test', version: '0.0.0' }, { capabilities: {} });
}

function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }).then((result) => {
    const text = (result as any)?.content?.[0]?.text;
    return JSON.parse(text);
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-mcp-http-'));
  writeConfig();

  handler = createMcpHttpHandler({
    dataDir,
    env: {},
    authorize: (request) => (request.headers.authorization === 'Bearer secret'
      ? { ok: true }
      : { ok: false, status: 401, message: 'Unauthorized' }),
    logger: { warn() {}, error() {}, log() {} } as any,
  });

  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        (request as any).body = raw ? JSON.parse(raw) : undefined;
      } catch {
        response.statusCode = 400;
        response.end('invalid json');
        return;
      }
      Promise.resolve(handler.handle(request, response)).catch((error) => {
        if (!response.headersSent) {
          response.statusCode = 500;
        }
        response.end(String(error));
      });
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('测试服务器未拿到端口');
  }
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  handler?.close();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('mcp http endpoint', () => {
  it('rejects requests without a token', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe('Unauthorized');
  });

  it('rejects non-POST methods', async () => {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('lists tools and connections over stateless HTTP', async () => {
    const client = makeClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    }));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'get_server_info', 'list_connections', 'sftp_list', 'sftp_read_text', 'sftp_stat', 'ssh_exec', 'test_connection',
      ]);

      const listed = await callTool(client, 'list_connections');
      expect(listed.ok).toBe(true);
      expect(listed.count).toBe(1);
      expect(listed.connections[0].host).toBe('10.0.0.9');
      // 摘要里绝不能出现凭据。
      expect(JSON.stringify(listed)).not.toContain('plain-password');
    } finally {
      await client.close();
    }
  });

  it('reloads the policy file without restarting', async () => {
    const client = makeClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: 'Bearer secret' } },
    }));
    try {
      const before = await callTool(client, 'get_server_info');
      expect(before.policy.execAllowed).toBe(false);
      expect(before.policyFile.exists).toBe(false);

      fs.writeFileSync(path.join(dataDir, 'mcp-policy.json'), JSON.stringify({
        defaultMode: 'exec',
        connections: { c1: 'read-only' },
        commands: { deny: [], exceptions: [] },
        audit: { enabled: true },
      }));

      const after = await callTool(client, 'get_server_info');
      expect(after.policyFile.exists).toBe(true);
      expect(after.policy.execAllowed).toBe(true);
      expect(after.policy.connections).toEqual({ c1: 'read-only' });
    } finally {
      await client.close();
    }
  });

  it('retires a replaced services instance only after its in-flight requests finish', () => {
    const policyPath = path.join(dataDir, 'holder-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ defaultMode: 'read-only' }));

    const made: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const holder = createServicesHolder({
      policyPath,
      createServices: () => {
        const instance = { close: vi.fn() };
        made.push(instance);
        return instance;
      },
      logger: { warn() {} } as any,
    });

    // 第一个请求拿到第一个实例。
    const first = holder.acquire();
    expect(made).toHaveLength(1);
    expect(first.services).toBe(made[0]);

    // 策略文件变化：第二个请求拿到新实例，旧实例被「退休」但仍在途，不能立即关闭。
    fs.writeFileSync(policyPath, JSON.stringify({ defaultMode: 'exec', connections: {} }));
    const second = holder.acquire();
    expect(made).toHaveLength(2);
    expect(second.services).toBe(made[1]);
    expect(made[0].close).not.toHaveBeenCalled();

    // 策略不变时，新请求继续用最新实例，不会又建一个。
    const third = holder.acquire();
    expect(made).toHaveLength(2);
    expect(third.services).toBe(made[1]);
    holder.release(third);

    // 旧实例的最后一个在途请求结束 → 此时才关闭（且只关一次）。
    holder.release(first);
    expect(made[0].close).toHaveBeenCalledTimes(1);
    holder.release(first);
    expect(made[0].close).toHaveBeenCalledTimes(1);

    // 当前实例仍有在途请求，不应被关闭。
    holder.release(second);
    expect(made[1].close).not.toHaveBeenCalled();

    // 进程退出：关闭当前实例，重复 close 不会重复销毁。
    holder.close();
    expect(made[1].close).toHaveBeenCalledTimes(1);
    holder.close();
    expect(made[1].close).toHaveBeenCalledTimes(1);
  });
});