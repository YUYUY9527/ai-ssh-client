import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAcpClient, buildSafeEnv } from '../server/agent-acp.cjs';

const fixture = path.join(process.cwd(), 'test', 'fixtures', 'mock-acp-agent.cjs');

describe('agent-acp', () => {
  it('buildSafeEnv 剥离 SSH_AUTH_SOCK 等敏感变量', () => {
    const env = buildSafeEnv({ PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', OPENAI_API_KEY: 'secret', LANG: 'zh_CN' });
    expect(env.PATH).toBe('/bin');
    expect(env.LANG).toBe('zh_CN');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('握手并按 gate 允许工具调用', async () => {
    const decisions: Array<{ tool: string; args: unknown }> = [];
    const client = createAcpClient({
      command: process.execPath,
      args: [fixture],
      gate: (request) => {
        decisions.push({ tool: request.tool, args: request.args });
        return { allow: true };
      },
    });
    try {
      const init = await client.initialize();
      expect(init.protocolVersion).toBe(1);
      await client.newSession({ cwd: process.cwd() });
      const result = await client.prompt({ sessionId: 's1', content: 'write a file' });
      expect(result.stopReason).toBe('end_turn');
      expect(decisions).toEqual([{ tool: 'write_file', args: { path: '/tmp/x' } }]);
    } finally {
      client.close();
    }
  });

  it('gate 拒绝时授权请求被取消', async () => {
    const client = createAcpClient({
      command: process.execPath,
      args: [fixture],
      gate: () => ({ allow: false, reason: 'blocked by policy' }),
    });
    try {
      await client.initialize();
      await client.newSession({ cwd: process.cwd() });
      const result = await client.prompt({ sessionId: 's1', content: 'write a file' });
      expect(result.stopReason).toBe('cancelled');
    } finally {
      client.close();
    }
  });

  it('未配置 gate 时默认拒绝', async () => {
    const client = createAcpClient({ command: process.execPath, args: [fixture] });
    try {
      await client.initialize();
      await client.newSession({ cwd: process.cwd() });
      const result = await client.prompt({ sessionId: 's1', content: 'x' });
      expect(result.stopReason).toBe('cancelled');
    } finally {
      client.close();
    }
  });
});
