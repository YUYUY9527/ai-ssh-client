/**
 * @vitest-environment jsdom
 *
 * AgentRuntime 主循环的行为测试。
 *
 * 背景：`agent-runtime.ts` 有 2000+ 行、九个职责，此前**零直接测试** ——
 * 已有的 34 个 `agent-flow` 用例只覆盖纯流水线，属于虚假信心。
 *
 * 这里搭最小可用的测试台：
 * - jsdom 提供 window/document（运行时用 window.setTimeout / requestAnimationFrame）；
 * - `vi.useFakeTimers()` 驱动 `scheduleProcess` 的 setTimeout(0) 循环，测试里用 `drain()` 推进；
 * - 三个 store（session / connection / command history）用真实的 zustand store 直接 setState；
 * - 模型调用与命令执行都是可断言的假实现，并记录调用参数。
 *
 * 覆盖：轮数预算、只读模式闸门、桌面策略拒绝的可恢复处理、审批记忆（含 critical 不记忆）、
 * 暂停/继续、token 用量统计、会话环境注入与 cwd 前缀跟踪。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AgentRuntime,
  type AgentRuntimeActions,
  type AgentRuntimeServices,
  type AgentRuntimeSnapshot,
} from '../src/renderer/agent/agent-runtime';
import { analyzeCommandRisk } from '../src/renderer/ai/analyze-command-risk';
import {
  clearRememberedRiskDecisions,
  rememberCommandDecision,
} from '../src/renderer/assistant/risk-approval-memory';
import { useSessionStore } from '../src/renderer/session/useSessionStore';
import { useConnectionStore } from '../src/renderer/store/useConnectionStore';
import type { AgentResponse, AgentTask, Message } from '../src/shared/types';
import type { AIChatStreamOptions, AgentExecAwaitResult } from '../src/shared/ipc-types';

// AgentRuntime 内部通过 `await import()` 做代码分割（agent-flow、store、历史模块）。
// 在 jsdom + 假定时器下，「首次」动态加载模块会依赖被 fake 掉的宏任务而卡住，
// 因此这里用静态副作用导入把模块预热进模块缓存 —— 产品代码的懒加载形态保持不变。
import '../src/renderer/agent/agent-flow';
import '../src/renderer/session/resolve-session-connection';
import '../src/renderer/history/useCommandHistoryStore';

// ==========================================================================
// 测试台
// ==========================================================================

type Harness = {
  runtime: AgentRuntime;
  actions: Record<keyof AgentRuntimeActions, ReturnType<typeof vi.fn>>;
  aiChatStream: ReturnType<typeof vi.fn>;
  aiChat: ReturnType<typeof vi.fn>;
  agentExecAwait: ReturnType<typeof vi.fn>;
  baseSnapshot: AgentRuntimeSnapshot;
  /** 模拟一次 zustand store 变更（生产里由 AgentExecutor 的 useEffect 触发 runtime.sync）。 */
  syncStore: (patch: Partial<AgentRuntimeSnapshot>) => void;
  /** 推进 setTimeout(0) 主循环，直到没有新的调用或达到上限。 */
  drain: (steps?: number) => Promise<void>;
  /** 启动任务（新任务检测 + 主循环）。 */
  start: (steps?: number) => Promise<void>;
  /** 第 index 次模型调用收到的消息（0 起）。 */
  streamMessages: (index: number) => Message[];
  completeCalls: () => Array<{ success: boolean; error?: string; finishReason?: string }>;
};

function agentDecision(partial: Partial<AgentResponse> = {}): AgentResponse {
  return { thought: { reasoning: '分析' }, decision: 'execute', ...partial };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    userInput: '检查磁盘使用情况',
    state: 'thinking',
    thinkingSteps: [],
    executions: [],
    startTime: Date.now(),
    ...overrides,
  };
}

function createHarness(options: {
  responses: AgentResponse[];
  exec?: (command: string) => Promise<{ success: boolean; error?: string; data?: AgentExecAwaitResult }>;
  task?: Partial<AgentTask>;
  config?: Partial<AgentRuntimeSnapshot['config']>;
  activeConnectionId?: string | null;
} ): Harness {
  const calls: AIChatStreamOptions[] = [];
  let responseIndex = 0;

  // 模拟 zustand store：runtime 通过 actions 写 store，AgentExecutor 再把新快照 sync 回来。
  // 测试台把这个闭环接上，行为才与生产一致（例如 setAgentState('thinking') 之后主循环才会继续）。
  let storeSnapshot: AgentRuntimeSnapshot;
  let runtimeRef: AgentRuntime | null = null;

  const syncStore = (patch: Partial<AgentRuntimeSnapshot>) => {
    storeSnapshot = { ...storeSnapshot, ...patch };
    runtimeRef?.sync(storeSnapshot);
  };

  const patchTask = (patch: Partial<AgentTask>) => {
    const current = storeSnapshot.currentTask;
    if (!current) return;
    syncStore({ currentTask: { ...current, ...patch } });
  };

  const actions = {
    setAgentState: vi.fn((state: AgentRuntimeSnapshot['agentState']) => {
      syncStore({ agentState: state });
    }),
    addThinkingStep: vi.fn((step: AgentTask['thinkingSteps'][number]) => {
      const current = storeSnapshot.currentTask;
      if (!current) return;
      syncStore({ currentTask: { ...current, thinkingSteps: [...current.thinkingSteps, step] } });
    }),
    updateThinkingStep: vi.fn((stepId: string, updates: Record<string, unknown>) => {
      const current = storeSnapshot.currentTask;
      if (!current) return;
      syncStore({
        currentTask: {
          ...current,
          thinkingSteps: current.thinkingSteps.map((step) => (
            step.id === stepId ? { ...step, ...updates } : step
          )),
        },
      });
    }),
    addExecution: vi.fn((execution: AgentTask['executions'][number]) => {
      const current = storeSnapshot.currentTask;
      if (!current) return;
      syncStore({ currentTask: { ...current, executions: [...current.executions, execution] } });
    }),
    addTaskTokenUsage: vi.fn((usage: number) => {
      const current = storeSnapshot.currentTask;
      if (!current) return;
      syncStore({ currentTask: { ...current, tokenUsage: (current.tokenUsage ?? 0) + usage } });
    }),
    completeTask: vi.fn((success: boolean, error?: string, finishReason?: string) => {
      const current = storeSnapshot.currentTask;
      syncStore({
        agentState: success ? 'finished' : 'error',
        currentTask: current
          ? { ...current, state: success ? 'finished' : 'error', endTime: Date.now(), error, finishReason }
          : current,
      });
    }),
    setPendingApproval: vi.fn((approval: AgentRuntimeSnapshot['pendingApproval']) => {
      syncStore({ pendingApproval: approval });
    }),
    setApprovalResult: vi.fn((result: AgentRuntimeSnapshot['approvalResult']) => {
      syncStore({ approvalResult: result });
    }),
    setPendingQuestion: vi.fn((question: string | null) => {
      syncStore({ pendingQuestion: question });
    }),
    setPendingInput: vi.fn((input: string | null) => {
      syncStore({ pendingInput: input });
    }),
    setPendingTerminalPrompt: vi.fn(),
  } satisfies Record<keyof AgentRuntimeActions, ReturnType<typeof vi.fn>>;

  const aiChatStream = vi.fn(async (_providerId: string, _messages: Message[], streamOptions: AIChatStreamOptions) => {
    calls.push(streamOptions);
    const response = options.responses[Math.min(responseIndex, options.responses.length - 1)];
    responseIndex += 1;
    return { success: true as const, data: { content: JSON.stringify(response) } };
  });

  const aiChat = vi.fn(async () => ({ success: true as const, data: { content: '摘要' } }));

  const agentExecAwait = vi.fn(async (_connectionId: string, command: string, execOptions?: { runId?: string }) => {
    if (options.exec) {
      return options.exec(command);
    }
    return {
      success: true as const,
      data: { output: `output:${command}`, exitCode: 0, reason: 'done' as const, runId: execOptions?.runId },
    };
  });

  const services: AgentRuntimeServices = {
    analyzeCommand: (command: string) => analyzeCommandRisk(command),
    aiChat: aiChat as unknown as AgentRuntimeServices['aiChat'],
    aiChatStream: aiChatStream as unknown as AgentRuntimeServices['aiChatStream'],
    cancelAIChat: vi.fn(),
    agentStartTask: vi.fn(async () => ({ success: true as const })),
    agentStopTask: vi.fn(async () => ({ success: true as const })),
    agentExecAwait: agentExecAwait as unknown as AgentRuntimeServices['agentExecAwait'],
    agentCancelExec: vi.fn(),
    onAgentTerminalOutput: vi.fn(() => () => {}),
    notifyTaskCompletion: vi.fn(async () => {}),
  };

  const activeConnectionId = options.activeConnectionId === undefined ? 'conn-1' : options.activeConnectionId;

  // 生产环境里 Agent 任务一定绑定一个 SSH 会话；默认给测试台一个最小可用会话，
  // 否则 runWithSentinel 会在「没有连接」时提前失败（那属于另一条用例）。
  if (options.activeConnectionId === undefined) {
    useConnectionStore.setState({
      connections: [{
        id: 'conn-1', name: 'test-host', host: '127.0.0.1', port: 22, username: 'tester',
      }],
    });
    useSessionStore.setState({
      sessions: {
        'conn-1': {
          id: 'conn-1', connectionId: 'conn-1', title: 'test-host', state: 'connected',
          reconnectAttempts: 0, lastActiveAt: Date.now(),
        },
      },
      activeSessionId: 'conn-1',
    });
  }

  const baseSnapshot: AgentRuntimeSnapshot = {
    currentTask: null,
    agentState: 'idle',
    config: {
      enabled: true,
      semanticSummaryContextLength: 12000,
      approveHighRisk: true,
      approveMediumRisk: true,
      readOnlyMode: false,
      ...options.config,
    },
    pendingApproval: null,
    approvalResult: null,
    pendingQuestion: null,
    pendingInput: null,
    taskHistory: [],
    activeConversationId: 'conversation-1',
    activeProviderId: 'provider-1',
    activeConnectionId,
    providers: [{ id: 'provider-1' }],
  };

  storeSnapshot = baseSnapshot;
  const runtime = new AgentRuntime(baseSnapshot, actions, services);
  runtimeRef = runtime;

  const drain = async (steps = 200) => {
    for (let index = 0; index < steps; index += 1) {
      await vi.advanceTimersByTimeAsync(5);
    }
  };

  const start = async (steps = 200) => {
    syncStore({ currentTask: task(options.task), agentState: 'thinking' });
    await drain(steps);
  };

  return {
    runtime,
    actions,
    syncStore,
    aiChatStream,
    aiChat,
    agentExecAwait,
    baseSnapshot,
    drain,
    start,
    streamMessages: (index: number) => aiChatStream.mock.calls[index]?.[1] ?? [],
    completeCalls: () => actions.completeTask.mock.calls.map((call) => ({
      success: call[0] as boolean,
      error: call[1] as string | undefined,
      finishReason: call[2] as string | undefined,
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearRememberedRiskDecisions();
  useSessionStore.setState({ sessions: {}, activeSessionId: null });
  useConnectionStore.setState({ connections: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ==========================================================================
// 预算
// ==========================================================================

describe('AgentRuntime — 任务预算', () => {
  it('达到最大决策轮数后停止任务并说明原因', async () => {
    const harness = createHarness({
      // 每轮都返回一条低风险只读命令，模拟「模型永远不收尾」
      responses: [agentDecision({ command: 'df -h' })],
      exec: async () => ({ success: true, data: { output: 'ok', exitCode: 0, reason: 'done' } }),
    });
    await harness.start();

    const completions = harness.completeCalls();
    expect(completions).toHaveLength(1);
    expect(completions[0].success).toBe(false);
    expect(completions[0].error).toContain('最大决策轮数');
    // 24 轮上限：模型被调用 24 次，不再是无限循环
    expect(harness.aiChatStream).toHaveBeenCalledTimes(24);
  });
});

// ==========================================================================
// 只读模式
// ==========================================================================

describe('AgentRuntime — 只读模式', () => {
  it('拒绝写操作，并把原因回给模型（不判任务失败）', async () => {
    const harness = createHarness({
      config: { readOnlyMode: true },
      responses: [
        agentDecision({ command: 'touch /tmp/agent-probe' }),
        agentDecision({ decision: 'finish', finishReason: '改为只读排查' }),
      ],
    });
    await harness.start();

    // 命令没有下发到远端
    expect(harness.agentExecAwait).not.toHaveBeenCalled();
    // 第二轮模型调用收到了只读模式的拒绝原因
    const secondMessages = harness.streamMessages(1).map((message) => message.content).join('\n');
    expect(secondMessages).toContain('只读模式');
    // 任务正常完成，而不是失败
    expect(harness.completeCalls()).toEqual([
      { success: true, error: undefined, finishReason: '改为只读排查' },
    ]);
  });

  it('放行只读命令', async () => {
    const harness = createHarness({
      config: { readOnlyMode: true },
      responses: [
        agentDecision({ command: 'df -h' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
    });
    await harness.start();

    expect(harness.agentExecAwait).toHaveBeenCalledTimes(1);
    expect(harness.agentExecAwait.mock.calls[0][1]).toBe('df -h');
  });

  it('需要审批的写命令在只读模式下不再弹审批，直接拒绝并说明', async () => {
    const harness = createHarness({
      config: { readOnlyMode: true },
      responses: [
        agentDecision({ command: 'rm -rf /tmp/demo' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
    });
    await harness.start();

    expect(harness.actions.setPendingApproval).not.toHaveBeenCalled();
    expect(harness.agentExecAwait).not.toHaveBeenCalled();
    expect(harness.actions.addThinkingStep).toHaveBeenCalledWith(
      expect.objectContaining({ title: '只读模式已拒绝该命令' }),
    );
  });
});

// ==========================================================================
// 本地策略拒绝
// ==========================================================================

describe('AgentRuntime — 本地安全策略拒绝可恢复', () => {
  it('桌面端哨兵拒绝时不判任务失败，而是让模型换方案', async () => {
    // 真实场景：用户审批通过了一条 critical 命令，但桌面端硬闸门仍然拒绝执行
    // （纵深防御）。此时必须把拒绝原因回给模型换方案，而不是把任务判死。
    const harness = createHarness({
      responses: [
        agentDecision({ command: 'rm -rf /etc/nginx' }),
        agentDecision({ decision: 'finish', finishReason: '改用更安全的方式' }),
      ],
      exec: async () => ({
        success: false,
        error: 'AGENT_POLICY_BLOCKED: 递归删除关键路径',
      }),
    });
    await harness.start();

    // 第一轮先进入审批，命令尚未下发
    expect(harness.actions.setPendingApproval).toHaveBeenCalledTimes(1);
    expect(harness.agentExecAwait).not.toHaveBeenCalled();

    // 用户批准 → 执行被桌面端拒绝 → 任务继续而不是失败
    harness.syncStore({ approvalResult: 'approved' });
    await harness.drain();

    expect(harness.agentExecAwait).toHaveBeenCalledTimes(1);
    expect(harness.completeCalls()).toEqual([
      { success: true, error: undefined, finishReason: '改用更安全的方式' },
    ]);
    const secondMessages = harness.streamMessages(1).map((message) => message.content).join('\n');
    expect(secondMessages).toContain('递归删除关键路径');
    // 机器可读前缀不应泄露给用户
    const stepContents = harness.actions.addThinkingStep.mock.calls
      .map((call) => call[0].content)
      .join('\n');
    expect(stepContents).not.toContain('AGENT_POLICY_BLOCKED');
  });
});

// ==========================================================================
// 审批记忆
// ==========================================================================

describe('AgentRuntime — 审批与记忆', () => {
  it('记住批准的同一条命令自动执行，不再弹审批', async () => {
    rememberCommandDecision('systemctl restart nginx', 'medium', 'approved');
    const harness = createHarness({
      responses: [
        agentDecision({ command: 'systemctl restart nginx' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
    });
    await harness.start();

    expect(harness.actions.setPendingApproval).not.toHaveBeenCalled();
    expect(harness.agentExecAwait).toHaveBeenCalledTimes(1);
  });

  it('critical 命令永远需要审批（不会被记忆放行）', async () => {
    rememberCommandDecision('rm -rf /var/lib', 'critical', 'approved');
    const harness = createHarness({
      responses: [agentDecision({ command: 'rm -rf /var/lib' })],
    });
    await harness.start();

    expect(harness.actions.setPendingApproval).toHaveBeenCalledWith({
      command: 'rm -rf /var/lib',
      riskLevel: 'critical',
    });
    expect(harness.agentExecAwait).not.toHaveBeenCalled();
  });

  it('用户批准后执行的是审批时给出的命令', async () => {
    const harness = createHarness({ responses: [agentDecision({ command: 'systemctl restart nginx' })] });
    await harness.start();
    expect(harness.actions.setPendingApproval).toHaveBeenCalledTimes(1);
    expect(harness.agentExecAwait).not.toHaveBeenCalled();

    harness.syncStore({ approvalResult: 'approved' });
    await harness.drain();

    expect(harness.agentExecAwait).toHaveBeenCalledTimes(1);
    expect(harness.agentExecAwait.mock.calls[0][1]).toBe('systemctl restart nginx');
  });

  it('审批命令可以改成别的命令再执行', async () => {
    const harness = createHarness({ responses: [agentDecision({ command: 'rm -rf /etc/nginx' })] });
    await harness.start();
    expect(harness.actions.setPendingApproval).toHaveBeenCalledWith({
      command: 'rm -rf /etc/nginx',
      riskLevel: 'critical',
    });

    // 面板里把命令改成只读的安全命令（审批时改命令的等价 store 变化）
    harness.syncStore({ pendingApproval: { command: 'nginx -t', riskLevel: 'low' } });
    harness.syncStore({ approvalResult: 'approved' });
    await harness.drain();

    expect(harness.agentExecAwait).toHaveBeenCalledTimes(1);
    expect(harness.agentExecAwait.mock.calls[0][1]).toBe('nginx -t');
  });
});

// ==========================================================================
// 暂停 / 继续
// ==========================================================================

describe('AgentRuntime — 暂停与继续', () => {
  it('暂停中止在途工作且不判失败，继续后开启新的一轮', async () => {
    let resolveStream: (() => void) | null = null;
    const harness = createHarness({ responses: [agentDecision({ command: 'df -h' })] });
    harness.aiChatStream.mockImplementation(async () => {
      await new Promise<void>((resolve) => { resolveStream = resolve; });
      return { success: true as const, data: { content: JSON.stringify(agentDecision({ command: 'df -h' })) } };
    });

    await harness.start();
    expect(harness.aiChatStream).toHaveBeenCalledTimes(1);

    harness.runtime.sync({
      ...harness.baseSnapshot,
      currentTask: task({ state: 'paused' }),
      agentState: 'paused',
    });
    await harness.drain();
    expect(harness.completeCalls()).toHaveLength(0);
    expect(harness.actions.setAgentState).toHaveBeenCalledWith('paused');

    // 放行被暂停的 AI 请求，并恢复任务
    resolveStream?.();
    await harness.drain();
    harness.runtime.sync({
      ...harness.baseSnapshot,
      currentTask: task({ state: 'thinking' }),
      agentState: 'thinking',
    });
    await harness.drain();

    expect(harness.aiChatStream).toHaveBeenCalledTimes(2);
    expect(harness.completeCalls()).toHaveLength(0);
  });
});

// ==========================================================================
// 上下文与 cwd
// ==========================================================================

describe('AgentRuntime — 会话环境与 cwd 跟踪', () => {
  it('注入主机/用户/当前目录，并给单行命令加 cd 前缀', async () => {
    useConnectionStore.setState({
      connections: [{
        id: 'c1', name: 'prod-web', host: '10.0.0.9', port: 22, username: 'deploy',
      }],
    });
    useSessionStore.setState({
      sessions: {
        c1: {
          id: 'c1', connectionId: 'c1', title: 'prod-web', state: 'connected',
          reconnectAttempts: 0, lastActiveAt: Date.now(), cwd: '/srv/app',
        },
      },
      activeSessionId: 'c1',
    });

    const harness = createHarness({
      activeConnectionId: 'c1',
      task: { connectionId: 'c1' },
      responses: [
        agentDecision({ command: 'ls -la' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
    });
    await harness.start();

    const firstMessages = harness.streamMessages(0).map((message) => message.content).join('\n');
    expect(firstMessages).toContain('deploy@10.0.0.9');
    expect(firstMessages).toContain('/srv/app');
    expect(harness.agentExecAwait.mock.calls[0][1]).toBe("cd '/srv/app' && ls -la");
  });

  it('模型显式 cd 后，后续命令跟随新目录', async () => {
    useSessionStore.setState({
      sessions: {
        c1: {
          id: 'c1', connectionId: 'c1', title: 'prod-web', state: 'connected',
          reconnectAttempts: 0, lastActiveAt: Date.now(), cwd: '/srv/app',
        },
      },
      activeSessionId: 'c1',
    });

    const harness = createHarness({
      activeConnectionId: 'c1',
      task: { connectionId: 'c1' },
      responses: [
        agentDecision({ command: 'cd /var/log' }),
        agentDecision({ command: 'tail -n 5 nginx.log' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
    });
    await harness.start();

    expect(harness.agentExecAwait.mock.calls[0][1]).toBe('cd /var/log');
    expect(harness.agentExecAwait.mock.calls[1][1]).toBe("cd '/var/log' && tail -n 5 nginx.log");
  });
});

// ==========================================================================
// 观测：退出码与 token
// ==========================================================================

describe('AgentRuntime — 观测信息', () => {
  it('把退出码写进下一轮决策上下文', async () => {
    const harness = createHarness({
      responses: [
        agentDecision({ command: 'systemctl is-active nginx' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
      exec: async () => ({ success: true, data: { output: 'inactive', exitCode: 3, reason: 'done' } }),
    });
    await harness.start();

    const secondMessages = harness.streamMessages(1).map((message) => message.content).join('\n');
    expect(secondMessages).toContain('退出码：3（失败）');
    // 命令退出码非 0 时执行记录标记为失败
    expect(harness.actions.addExecution).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, exitCode: 3 }),
    );
  });

  it('超时会在上下文里标注输出可能不完整', async () => {
    const harness = createHarness({
      responses: [
        agentDecision({ command: 'tail -f /var/log/syslog' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
      exec: async () => ({ success: true, data: { output: 'partial', exitCode: null, reason: 'timeout' } }),
    });
    await harness.start();

    const secondMessages = harness.streamMessages(1).map((message) => message.content).join('\n');
    expect(secondMessages).toContain('等待超时');
  });

  it('执行记录带上 startedAt / completedAt（真实耗时来源）', async () => {
    const harness = createHarness({
      responses: [
        agentDecision({ command: 'uptime' }),
        agentDecision({ decision: 'finish', finishReason: '完成' }),
      ],
      exec: async () => ({ success: true, data: { output: 'load average: 0.1', exitCode: 0, reason: 'done' } }),
    });
    await harness.start();

    const recorded = harness.actions.addExecution.mock.calls[0]?.[0];
    expect(recorded.startedAt).toEqual(expect.any(Number));
    expect(recorded.completedAt).toEqual(expect.any(Number));
    expect(recorded.completedAt as number).toBeGreaterThanOrEqual(recorded.startedAt as number);
  });

  it('累计 provider 返回的 usage', async () => {
    const harness = createHarness({ responses: [agentDecision({ decision: 'finish', finishReason: '完成' })] });
    harness.aiChatStream.mockImplementation(async (_providerId, _messages, streamOptions) => {
      streamOptions.onEvent({
        type: 'done',
        requestId: streamOptions.requestId,
        usage: { promptTokens: 100, completionTokens: 20 },
      });
      return { success: true as const, data: { content: JSON.stringify(agentDecision({ decision: 'finish', finishReason: '完成' })) } };
    });

    await harness.start();

    expect(harness.actions.addTaskTokenUsage).toHaveBeenCalledWith(120);
  });
});

// ==========================================================================
// 卸载：已结束的运行时不得被陈旧的 sync 复活
// ==========================================================================

describe('AgentRuntime — 结束后不得被陈旧 sync 复活', () => {
  /**
   * 真实回归：任务在终端里已经打印完结束摘要，最下方却还留着一行「Agent · 思考中」。
   *
   * 链路：AgentPet 只在任务未结束时挂载 AgentExecutor。任务 finish 的那一次提交里，
   * AgentExecutor 的 useEffect 同步回调可能带着**上一帧的快照**（agentState 仍是
   * thinking）先跑（此时排入了一个 setTimeout(0) 的 scheduleProcess），紧接着组件卸载
   * 触发 dispose()。旧实现的 dispose() 把 status 打回 'idle'，于是那个定时器随后
   * 通过 process() 的全部守卫 —— 已结束的运行时又跑了一整轮：store 从 finished 翻回
   * thinking（终端因此多打一行「思考中」），第二轮结束时 completedTaskId 已记录，
   * 摘要不再打印，终端就永久停留在那行「思考中」。
   */
  it('finish 后先跑陈旧 sync 再 dispose，不会再跑一轮', async () => {
    const harness = createHarness({
      responses: [agentDecision({ decision: 'finish', finishReason: '问候已回复' })],
    });
    await harness.start();

    expect(harness.aiChatStream).toHaveBeenCalledTimes(1);
    expect(harness.completeCalls()).toHaveLength(1);

    // 卸载时序：陈旧快照先入队 scheduleProcess，随后组件卸载 dispose()
    harness.syncStore({ agentState: 'thinking' });
    harness.runtime.dispose();
    await harness.drain();

    expect(harness.aiChatStream).toHaveBeenCalledTimes(1);
    expect(harness.completeCalls()).toHaveLength(1);
  });

  it('dispose 之后再来的陈旧 sync 也不生效', async () => {
    const harness = createHarness({
      responses: [agentDecision({ decision: 'finish', finishReason: '问候已回复' })],
    });
    await harness.start();

    harness.runtime.dispose();
    harness.syncStore({ agentState: 'thinking' });
    await harness.drain();

    expect(harness.aiChatStream).toHaveBeenCalledTimes(1);
    expect(harness.completeCalls()).toHaveLength(1);
  });
});
