import { describe, it, expect, vi } from 'vitest';

import {
  runAgentExecutionGraph,
  runAgentRoundGraph,
} from '../src/renderer/agent/agent-flow';
import type { AgentResponse, Message } from '../src/shared/types';

/**
 * Agent 主路径行为测试 —— LangGraph 拆除的安全网。
 *
 * 覆盖面：本轮决策的全部出口（execute / approval / ask / finish / retryParse /
 * fail）与中止语义。测试直接针对 `runAgentRoundGraph` / `runAgentExecutionGraph`
 * 的**公开契约**，因为这两个函数在拆除 LangGraph 后保持不变，而内部实现会被替换。
 *
 * 注意：这些测试通过注入的假依赖驱动，不触碰 i18n store 或 Zustand。
 */

const FALLBACK = {
  parseRetry: '响应格式异常，正在重试',
  cannotParse: '无法解析响应',
  invalidResponse: 'AI 响应无效',
  completed: '任务已完成',
  analyzing: '正在分析',
  noCommand: '未给出命令',
  duplicateCommand: (command: string) => `重复命令:${command}`,
};

const MESSAGES: Message[] = [
  { id: 'm1', role: 'user', content: '列出当前目录', timestamp: 1 },
];

/** 构造一条 Agent 决策响应。 */
function agentResponse(partial: Partial<AgentResponse> = {}): AgentResponse {
  return {
    thought: { reasoning: '先看看目录内容' },
    decision: 'execute',
    ...partial,
  };
}

type RoundInput = Parameters<typeof runAgentRoundGraph>[0];

/** 构造一轮 graph 输入；所有外部依赖都是可断言的假实现。 */
function makeRoundInput(overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    providerId: 'provider-1',
    messages: MESSAGES,
    requestId: 'req-1',
    parseRetryAvailable: false,
    aiChatStream: vi.fn(async () => ({ success: true as const, data: { content: 'RAW' } })),
    parseResponse: vi.fn(() => agentResponse({ command: 'ls -la' })),
    analyzeCommand: vi.fn(() => ({ riskLevel: 'low' as const })),
    shouldBlockRepeatedCommand: vi.fn(() => false),
    needsApproval: vi.fn(() => false),
    fallbackText: FALLBACK,
    execute: vi.fn(async () => 'file1\nfile2'),
    summarizeOutput: vi.fn((_command: string, output: string) => `obs:${output}`),
    buildNextDecisionContext: vi.fn((_command: string, output: string) => `ctx:${output}`),
    ...overrides,
  };
}

type ExecutionInput = Parameters<typeof runAgentExecutionGraph>[0];

function makeExecutionInput(overrides: Partial<ExecutionInput> = {}): ExecutionInput {
  return {
    command: 'ls -la',
    execute: vi.fn(async () => 'file1\nfile2'),
    summarizeOutput: vi.fn((output: string) => `obs:${output}`),
    buildNextDecisionContext: vi.fn((command: string, output: string) => `ctx:${command}:${output}`),
    ...overrides,
  };
}

/** 复刻 agent-runtime.ts 的 AbortedByRuntimeError：上层只按 `name` 识别。 */
function abortError(reason = 'paused'): Error {
  const error = new Error(`agent aborted: ${reason}`);
  error.name = 'AbortedByRuntimeError';
  return error;
}

// ==========================================================================
// runAgentRoundGraph
// ==========================================================================

describe('runAgentRoundGraph — 模型调用与上下文准备', () => {
  it('把 providerId / messages / requestId 透传给流式对话', async () => {
    const input = makeRoundInput();

    await runAgentRoundGraph(input);

    expect(input.aiChatStream).toHaveBeenCalledTimes(1);
    expect(input.aiChatStream).toHaveBeenCalledWith(
      'provider-1',
      MESSAGES,
      expect.objectContaining({ requestId: 'req-1' }),
    );
  });

  it('把模型流事件转发给 onStreamEvent', async () => {
    const events: unknown[] = [];
    const delta = { type: 'delta' as const, requestId: 'req-1', delta: '片段' };
    const input = makeRoundInput({
      onStreamEvent: (event) => events.push(event),
      aiChatStream: vi.fn(async (_providerId, _messages, options) => {
        options.onEvent(delta);
        return { success: true as const, data: { content: 'RAW' } };
      }),
    });

    await runAgentRoundGraph(input);

    expect(events).toEqual([delta]);
  });

  it('透传模型返回的原始内容', async () => {
    const input = makeRoundInput();

    const result = await runAgentRoundGraph(input);

    expect(result.rawContent).toBe('RAW');
    expect(input.parseResponse).toHaveBeenCalledWith('RAW');
  });

  it('模型调用失败时向上抛出', async () => {
    const input = makeRoundInput({
      aiChatStream: vi.fn(async () => ({ success: false as const, error: '上游 500' })),
    });

    await expect(runAgentRoundGraph(input)).rejects.toThrow('上游 500');
  });

  it('模型成功但返回空 data 时向上抛出', async () => {
    const input = makeRoundInput({
      // 模拟后端 success:true 却没有 data 的畸形响应
      aiChatStream: vi.fn(async () => ({ success: true as const }) as never),
    });

    await expect(runAgentRoundGraph(input)).rejects.toThrow('AI response is empty');
  });
});

describe('runAgentRoundGraph — execute 出口', () => {
  it('把命令决策路由为 execute 并回填 execution', async () => {
    const input = makeRoundInput();

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction.type).toBe('execute');
    expect(result.execution).toEqual({
      command: 'ls -la',
      output: 'file1\nfile2',
      observation: 'obs:file1\nfile2',
      nextDecisionContext: 'ctx:file1\nfile2',
    });
  });

  it('执行前回调 beforeExecute 收到该 execute 动作', async () => {
    const beforeExecute = vi.fn();
    const input = makeRoundInput({ beforeExecute });

    const result = await runAgentRoundGraph(input);

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(beforeExecute).toHaveBeenCalledWith(result.nextAction);
  });

  it('命令两侧空白被裁剪后再执行', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => agentResponse({ command: '  ls -la  ' })),
    });

    await runAgentRoundGraph(input);

    expect(input.execute).toHaveBeenCalledWith('ls -la');
  });

  it('普通执行失败被就地捕获为 execution.error，不抛出', async () => {
    const input = makeRoundInput({
      execute: vi.fn(async () => {
        throw new Error('命令返回非零');
      }),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.execution).toEqual({
      command: 'ls -la',
      output: '',
      observation: '命令返回非零',
      nextDecisionContext: '命令返回非零',
      error: '命令返回非零',
    });
  });

  it('中止类错误从 execute 向上抛出，不被记为执行失败', async () => {
    const input = makeRoundInput({
      execute: vi.fn(async () => {
        throw abortError('paused');
      }),
    });

    await expect(runAgentRoundGraph(input)).rejects.toThrow('agent aborted: paused');
  });
});

describe('runAgentRoundGraph — approval 出口', () => {
  it('高风险命令转为 approval 且不执行', async () => {
    const input = makeRoundInput({
      analyzeCommand: vi.fn(() => ({ riskLevel: 'critical' as const })),
      needsApproval: vi.fn(() => true),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({
      type: 'approval',
      command: 'ls -la',
      riskLevel: 'critical',
    });
    expect(input.execute).not.toHaveBeenCalled();
    expect(result.execution).toBeUndefined();
  });

  it('审批分支不触发 beforeExecute', async () => {
    const beforeExecute = vi.fn();
    const input = makeRoundInput({
      beforeExecute,
      analyzeCommand: vi.fn(() => ({ riskLevel: 'high' as const })),
      needsApproval: vi.fn(() => true),
    });

    await runAgentRoundGraph(input);

    expect(beforeExecute).not.toHaveBeenCalled();
  });

  it('风险等级由 analyzeCommand 的结果决定', async () => {
    const analyzeCommand = vi.fn(() => ({ riskLevel: 'medium' as const }));
    const input = makeRoundInput({ analyzeCommand, needsApproval: vi.fn(() => true) });

    await runAgentRoundGraph(input);

    expect(analyzeCommand).toHaveBeenCalledWith('ls -la');
  });
});

describe('runAgentRoundGraph — ask 出口', () => {
  it('反问决策转为 ask 且不执行', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => agentResponse({ decision: 'ask', question: '要操作哪个目录？' })),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({ type: 'ask', question: '要操作哪个目录？' });
    expect(input.execute).not.toHaveBeenCalled();
  });

  it('反问缺少 question 时回退到 analyzing 文案', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => agentResponse({ decision: 'ask' })),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({ type: 'ask', question: FALLBACK.analyzing });
  });
});

describe('runAgentRoundGraph — finish 出口', () => {
  it('完成决策带上 finishReason', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => agentResponse({ decision: 'finish', finishReason: '目录已列出' })),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({ type: 'finish', reason: '目录已列出' });
    expect(input.execute).not.toHaveBeenCalled();
  });

  it('完成决策缺少 finishReason 时回退到 completed 文案', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => agentResponse({ decision: 'finish' })),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({ type: 'finish', reason: FALLBACK.completed });
  });
});

describe('runAgentRoundGraph — 失败与重试出口', () => {
  it('解析失败且允许重试时转 retryParse', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => null),
      parseRetryAvailable: true,
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toEqual({ type: 'retryParse', message: FALLBACK.parseRetry });
  });

  it('解析失败且不可重试时转 fail', async () => {
    const input = makeRoundInput({
      parseResponse: vi.fn(() => null),
      parseRetryAvailable: false,
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toEqual({ type: 'fail', reason: FALLBACK.invalidResponse });
    expect(result.response).toBeNull();
  });

  it('模型返回空内容时视为解析失败', async () => {
    const input = makeRoundInput({
      aiChatStream: vi.fn(async () => ({ success: true as const, data: { content: '' } })),
    });

    const result = await runAgentRoundGraph(input);

    expect(result.response).toBeNull();
    expect(input.parseResponse).not.toHaveBeenCalled();
    expect(result.nextAction).toEqual({ type: 'fail', reason: FALLBACK.invalidResponse });
  });

  it('执行决策缺少命令时转 fail 并附带原始响应', async () => {
    const response = agentResponse({ command: '   ' });
    const input = makeRoundInput({ parseResponse: vi.fn(() => response) });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction).toMatchObject({ type: 'fail', reason: FALLBACK.noCommand });
    expect(result.nextAction.response).toBe(response);
    expect(input.execute).not.toHaveBeenCalled();
  });

  it('重复命令被拦截并给出命令名', async () => {
    const input = makeRoundInput({ shouldBlockRepeatedCommand: vi.fn(() => true) });

    const result = await runAgentRoundGraph(input);

    expect(input.shouldBlockRepeatedCommand).toHaveBeenCalledWith('ls -la');
    expect(result.nextAction).toMatchObject({
      type: 'fail',
      reason: FALLBACK.duplicateCommand('ls -la'),
    });
    expect(input.execute).not.toHaveBeenCalled();
  });

  it('重复命令的判定先于风险审批', async () => {
    const needsApproval = vi.fn(() => true);
    const input = makeRoundInput({
      shouldBlockRepeatedCommand: vi.fn(() => true),
      needsApproval,
    });

    const result = await runAgentRoundGraph(input);

    expect(result.nextAction.type).toBe('fail');
    expect(needsApproval).not.toHaveBeenCalled();
  });
});

describe('runAgentRoundGraph — 图实例复用与并发隔离', () => {
  it('连续两轮不同输入互不串状态', async () => {
    const first = await runAgentRoundGraph(makeRoundInput());
    const second = await runAgentRoundGraph(
      makeRoundInput({
        parseResponse: vi.fn(() => agentResponse({ decision: 'finish', finishReason: 'ok' })),
      }),
    );

    expect(first.nextAction.type).toBe('execute');
    expect(first.execution?.command).toBe('ls -la');
    expect(second.nextAction.type).toBe('finish');
    expect(second.execution).toBeUndefined();
  });

  it('并发轮次各自拿到自己的结果', async () => {
    const [a, b] = await Promise.all([
      runAgentRoundGraph(
        makeRoundInput({ parseResponse: vi.fn(() => agentResponse({ command: 'cmd-a' })) }),
      ),
      runAgentRoundGraph(
        makeRoundInput({ parseResponse: vi.fn(() => agentResponse({ command: 'cmd-b' })) }),
      ),
    ]);

    expect(a.execution?.command).toBe('cmd-a');
    expect(b.execution?.command).toBe('cmd-b');
  });
});

// ==========================================================================
// runAgentExecutionGraph
// ==========================================================================

describe('runAgentExecutionGraph', () => {
  it('顺序跑完流水线并回填全部字段', async () => {
    const input = makeExecutionInput();

    const result = await runAgentExecutionGraph(input);

    expect(result).toEqual({
      command: 'ls -la',
      output: 'file1\nfile2',
      observation: 'obs:file1\nfile2',
      nextDecisionContext: 'ctx:ls -la:file1\nfile2',
    });
    expect(input.execute).toHaveBeenCalledWith('ls -la');
  });

  it('执行失败时用错误信息填充 observation 与 nextDecisionContext', async () => {
    const input = makeExecutionInput({
      execute: vi.fn(async () => {
        throw new Error('连接已断开');
      }),
    });

    const result = await runAgentExecutionGraph(input);

    expect(result).toEqual({
      command: 'ls -la',
      output: '',
      observation: '连接已断开',
      nextDecisionContext: '连接已断开',
      error: '连接已断开',
    });
  });

  it('执行失败时不再调用输出摘要与上下文构建', async () => {
    const input = makeExecutionInput({
      execute: vi.fn(async () => {
        throw new Error('连接已断开');
      }),
    });

    await runAgentExecutionGraph(input);

    expect(input.summarizeOutput).not.toHaveBeenCalled();
    expect(input.buildNextDecisionContext).not.toHaveBeenCalled();
  });

  /**
   * 中止必须与 runAgentRoundGraph 的 executeAction 语义一致：向上抛出，而非降级成
   * error 字段。
   *
   * 回归背景（2026-09-10 修复）：execution 图的 executeCommand 节点曾用裸 `catch`
   * 捕获**所有**错误，包括 AbortedByRuntimeError，把它降级成 `{ error }` 并正常
   * resolve。于是 agent-runtime.ts 第 1076 行 `throw new Error(result.error)` 重新
   * 包出的是**普通 Error**（`name` 变成 'Error'），第 1084 行的
   * `instanceof AbortedByRuntimeError` 不命中；又因 `applyPause()` 不递增
   * taskVersion，第 1087 行的 `isCurrent()` 兜底同样不生效，最终落到 1088-1092 行
   * 把思考步骤标记失败、记录失败执行、并 `finishTask(false, ...)`。
   *
   * 用户可见后果：**Agent 正在执行命令时点击「暂停」，任务会被判定为失败。**
   *
   * 本用例是该缺陷的回归防线：若有人重新引入裸 catch，此处立即失败。
   */
  it('中止类错误向上抛出，不被降级为 error 字段', async () => {
    const input = makeExecutionInput({
      execute: vi.fn(async () => {
        throw abortError('paused');
      }),
    });

    await expect(runAgentExecutionGraph(input)).rejects.toThrow('agent aborted: paused');
  });

  it('中止类错误同样不再触发输出摘要与上下文构建', async () => {
    const input = makeExecutionInput({
      execute: vi.fn(async () => {
        throw abortError('paused');
      }),
    });

    await expect(runAgentExecutionGraph(input)).rejects.toThrow();
    expect(input.summarizeOutput).not.toHaveBeenCalled();
    expect(input.buildNextDecisionContext).not.toHaveBeenCalled();
  });

  it('中止类错误按 name 识别，不依赖具体错误类', async () => {
    // AgentRuntime 与图的错误类不同（图内不 import runtime），只按 name 匹配。
    const foreignAbort = new Error('agent aborted: dispose');
    foreignAbort.name = 'AbortedByRuntimeError';
    const input = makeExecutionInput({
      execute: vi.fn(async () => {
        throw foreignAbort;
      }),
    });

    await expect(runAgentExecutionGraph(input)).rejects.toBe(foreignAbort);
  });
});
