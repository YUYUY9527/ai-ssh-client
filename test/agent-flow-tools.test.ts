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

  it('同一响应的多个工具调用：先执行第一个，其余通过 pendingToolCalls 排队', async () => {
    const input = makeInput([
      { id: 'c5', name: 'list_dir', arguments: '{"path":"/tmp"}' },
      { id: 'c6', name: 'read_file', arguments: '{"path":"/tmp/a"}' },
      { id: 'c7', name: 'search_files', arguments: '{"path":"/tmp","query":"x"}' },
    ]);
    const first = await runAgentRoundGraph(input);
    expect(first.execution?.output).toBe('tool-output');
    expect(input.executeTool).toHaveBeenCalledTimes(1);
    expect(first.pendingToolCalls).toHaveLength(2);
    expect(first.pendingToolCalls?.[0].id).toBe('c6');

    // runtime 下一轮把排队的调用作为 presetToolCalls 传回（跳过模型调用）
    const executeToolRound2 = vi.fn(async () => 'tool-output-2');
    const second = await runAgentRoundGraph(makeInput([], {
      presetToolCalls: first.pendingToolCalls,
      executeTool: executeToolRound2,
      aiChatStream: vi.fn(async () => {
        throw new Error('preset 路径不应调用模型');
      }),
    }));
    expect(second.pendingToolCalls).toHaveLength(1);
    expect(second.pendingToolCalls?.[0].id).toBe('c7');
    expect(second.execution?.output).toBe('tool-output-2');
    expect(executeToolRound2).toHaveBeenCalledTimes(1);
    expect(executeToolRound2).toHaveBeenCalledWith(expect.objectContaining({ id: 'c6' }));
  });

  it('审批动作携带剩余工具调用队列（approval.remainingToolCalls）', async () => {
    const input = makeInput(
      [
        { id: 'c8', name: 'write_file', arguments: '{"path":"/tmp/a","content":"hi"}' },
        { id: 'c9', name: 'list_dir', arguments: '{"path":"/tmp"}' },
      ],
      { needsApproval: vi.fn(() => true) },
    );
    const result = await runAgentRoundGraph(input);
    expect(result.nextAction.type).toBe('approval');
    if (result.nextAction.type === 'approval') {
      expect(result.nextAction.remainingToolCalls).toHaveLength(1);
      expect(result.nextAction.remainingToolCalls?.[0].id).toBe('c9');
    }
  });
});
