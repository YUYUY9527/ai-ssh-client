/**
 * 重连后必须开新的 Agent 会话（用户要求「不要加载历史会话」）。
 *
 * 覆盖所有「连上服务器」的入口：手动重连（AppController）、自动重连
 * （useSessionBridge / useSessionRecovery）、后端状态同步，以及首次连接 ——
 * 它们最终都落在 `useSessionStore` 的 connected 状态跃迁上。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useAgentStore } from '../src/renderer/store/useAgentStore';
import { useSessionStore } from '../src/renderer/session/useSessionStore';
import type { AgentTask, Session } from '../src/shared/types';

const OLD_CONVERSATION = 'old-conversation';
const CONNECTION = 'conn-a';

function oldTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-old',
    conversationId: OLD_CONVERSATION,
    connectionId: CONNECTION,
    userInput: '上一次会话的任务',
    state: 'finished',
    thinkingSteps: [],
    executions: [],
    startTime: Date.now(),
    ...overrides,
  };
}

function session(state: Session['state']): Session {
  return {
    id: CONNECTION,
    connectionId: CONNECTION,
    title: CONNECTION,
    state,
    scrollbackKey: CONNECTION,
    reconnectAttempts: 0,
    lastActiveAt: Date.now(),
  };
}

function registerSession(state: Session['state']) {
  useSessionStore.setState({
    sessions: { [CONNECTION]: session(state) },
    outputs: {},
    orderedSessionIds: [CONNECTION],
    activeSessionId: CONNECTION,
  } as never);
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: {},
    outputs: {},
    orderedSessionIds: [],
    activeSessionId: null,
  } as never);
  useAgentStore.setState({
    activeConnectionId: CONNECTION,
    activeConversationId: OLD_CONVERSATION,
    conversationByConnection: { [CONNECTION]: OLD_CONVERSATION },
    currentTask: null,
    agentState: 'idle',
    pendingApproval: null,
    approvalResult: null,
    pendingQuestion: null,
    pendingInput: null,
    pendingTerminalPrompt: null,
    taskHistory: [oldTask()],
  } as never);
});

describe('重连后开新 Agent 会话', () => {
  it('手动重连成功后不再沿用历史会话 id', () => {
    registerSession('reconnecting');

    useSessionStore.getState().setSessionState(CONNECTION, { state: 'connected' });

    const agent = useAgentStore.getState();
    expect(agent.activeConversationId).not.toBe(OLD_CONVERSATION);
    expect(agent.conversationByConnection[CONNECTION]).toBe(agent.activeConversationId);
    // 旧会话仍留在历史里可查阅
    expect(agent.taskHistory.some((task) => task.conversationId === OLD_CONVERSATION)).toBe(true);
  });

  it('自动重连（后端状态同步为已连接）同样开新会话', () => {
    registerSession('closed');

    useSessionStore.getState().syncSessionStateFromSsh(CONNECTION, {
      connectionId: CONNECTION,
      isConnected: true,
      isConnecting: false,
      reconnectAttempts: 0,
    });

    expect(useAgentStore.getState().activeConversationId).not.toBe(OLD_CONVERSATION);
  });

  it('连接建立后再重复上报 connected 不会反复重置会话', () => {
    registerSession('connecting');
    useSessionStore.getState().setSessionState(CONNECTION, { state: 'connected' });
    const first = useAgentStore.getState().activeConversationId;

    useSessionStore.getState().setSessionState(CONNECTION, { state: 'connected' });
    useSessionStore.getState().syncSessionStateFromSsh(CONNECTION, {
      connectionId: CONNECTION,
      isConnected: true,
      isConnecting: false,
      reconnectAttempts: 0,
    });

    expect(useAgentStore.getState().activeConversationId).toBe(first);
  });

  it('连接失败（error）不重置会话', () => {
    registerSession('connecting');

    useSessionStore.getState().setSessionState(CONNECTION, { state: 'error', lastError: 'auth failed' });

    expect(useAgentStore.getState().activeConversationId).toBe(OLD_CONVERSATION);
  });

  it('重连时结束在途任务并落库，不留「思考中」残影', () => {
    useAgentStore.setState({
      currentTask: oldTask({ id: 'task-running', state: 'thinking' }),
      agentState: 'thinking',
    } as never);
    registerSession('closed');

    useSessionStore.getState().setSessionState(CONNECTION, { state: 'connected' });

    const agent = useAgentStore.getState();
    expect(agent.currentTask).toBeNull();
    expect(agent.agentState).toBe('idle');
    expect(agent.taskHistory[0].id).toBe('task-running');
    expect(agent.taskHistory[0].state).toBe('finished');
    expect(agent.taskHistory[0].finishReason).toBeTruthy();
  });

  it('后台标签重连只换该连接的会话，不动当前激活会话', () => {
    const otherConnection = 'conn-b';
    useAgentStore.setState({
      activeConnectionId: otherConnection,
      activeConversationId: 'conversation-b',
      conversationByConnection: {
        [CONNECTION]: OLD_CONVERSATION,
        [otherConnection]: 'conversation-b',
      },
    } as never);
    useSessionStore.setState({
      sessions: { [CONNECTION]: session('closed') },
      orderedSessionIds: [CONNECTION],
      activeSessionId: otherConnection,
    } as never);

    useSessionStore.getState().setSessionState(CONNECTION, { state: 'connected' });

    const agent = useAgentStore.getState();
    expect(agent.activeConversationId).toBe('conversation-b');
    expect(agent.conversationByConnection[CONNECTION]).not.toBe(OLD_CONVERSATION);
  });

  it('切换标签只复用本进程内的会话，不再从历史任务反查', () => {
    // 模拟重启后的状态：内存里没有该连接的会话，但历史里有旧会话
    useAgentStore.setState({
      activeConnectionId: null,
      activeConversationId: 'seed',
      conversationByConnection: {},
      taskHistory: [oldTask()],
    } as never);

    useAgentStore.getState().setActiveConnection(CONNECTION);

    expect(useAgentStore.getState().activeConversationId).not.toBe(OLD_CONVERSATION);
    // 同一进程内再次切回：复用刚才那次建立的会话
    const assigned = useAgentStore.getState().activeConversationId;
    useAgentStore.getState().setActiveConnection('conn-b');
    useAgentStore.getState().setActiveConnection(CONNECTION);
    expect(useAgentStore.getState().activeConversationId).toBe(assigned);
  });
});
