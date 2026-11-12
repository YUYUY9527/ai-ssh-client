import { describe, expect, it, vi } from 'vitest';

import { runAgentRoundGraph } from '../src/renderer/agent/agent-flow';
import type { Message } from '../src/shared/types';

const FALLBACK = {
  parseRetry: 'retry',
  cannotParse: 'cannot parse',
  invalidResponse: 'invalid',
  completed: 'done',
  analyzing: 'analyzing',
  noCommand: 'no command',
  duplicateCommand: (command: string) => `dup:${command}`,
};

const MESSAGES: Message[] = [{ id: 'm1', role: 'user', content: 'task', timestamp: 1 }];

type RoundInput = Parameters<typeof runAgentRoundGraph>[0];

function makeInput(toolCalls: Array<{ id: string; name: string; arguments: string }>, overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    providerId: 'p1',
    messages: MESSAGES,
    requestId: 'r1',
    parseRetryAvailable: false,
    aiChatStream: vi.fn(async () => ({
      success: true as const,
      data: { content: 'RAW', toolCalls },
    })),
    parseResponse: vi.fn(() => null),
    analyzeCommand: vi.fn(() => ({ riskLevel: 'low' as const })),
    shouldBlockRepeatedCommand: vi.fn(() => false),
    needsApproval: vi.fn(() => false),
    executeTool: vi.fn(async () => 'tool-output'),
    fallbackText: FALLBACK,
    execute: vi.fn(async () => 'cmd-output'),
    summarizeOutput: vi.fn((_command: string, output: string) => `obs:${output}`),
    buildNextDecisionContext: vi.fn((_command: string, output: string) => `ctx:${output}`),
    ...overrides,
  };
}

describe('agent-flow 原生工具调用路由', () => {
  it('run_command 工具调用走 execute 动作', async () => {
    const input = makeInput([{ id: 'c1', name: 'run_command', arguments: '{"command":"ls -la"}' }]);
    const result = await runAgentRoundGraph(input);
    expect(result.nextAction.type).toBe('execute');
    if (result.nextAction.type === 'execute') {
      expect(result.nextAction.command).toBe('ls -la');
    }
    expect(result.execution?.output).toBe('cmd-output');
  });

  it('只读工具（list_dir）走 tool 动作并执行 executeTool', async () => {
    const input = makeInput([{ id: 'c2', name: 'list_dir', arguments: '{"path":"/tmp"}' }]);
    const result = await runAgentRoundGraph(input);
    expect(result.nextAction.type).toBe('tool');
    expect(input.executeTool).toHaveBeenCalledWith({ id: 'c2', name: 'list_dir', arguments: '{"path":"/tmp"}' });
    expect(result.execution?.output).toBe('tool-output');
  });

  it('write_file 需要审批时产出 approval 并携带 toolCall', async () => {
    const input = makeInput(
      [{ id: 'c3', name: 'write_file', arguments: '{"path":"/tmp/a","content":"hi"}' }],
      { needsApproval: vi.fn(() => true) },
    );
    const result = await runAgentRoundGraph(input);
    expect(result.nextAction.type).toBe('approval');
    if (result.nextAction.type === 'approval') {
      expect(result.nextAction.toolCall?.name).toBe('write_file');
      expect(result.nextAction.riskLevel).toBe('medium');
    }
  });

  it('run_command 缺少 command 时失败', async () => {
    const input = makeInput([{ id: 'c4', name: 'run_command', arguments: '{}' }]);
    const result = await runAgentRoundGraph(input);
    expect(result.nextAction.type).toBe('fail');
  });
});
