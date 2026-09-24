import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '../src/renderer/store/useAgentStore';

describe('Agent conversation isolation by SSH session', () => {
  beforeEach(() => {
    useAgentStore.setState({
      activeConnectionId: null,
      activeConversationId: 'initial-conversation',
      conversationByConnection: {},
      currentTask: null,
      agentState: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
      pendingInput: null,
      pendingTerminalPrompt: null,
      approvalResult: null,
      taskHistory: [],
    });
  });

  it('keeps a separate conversation id for each SSH tab', () => {
    const store = useAgentStore.getState();
    store.setActiveConnection('connection-a');
    store.startTask('检查 A', 'connection-a');
    const conversationA = useAgentStore.getState().activeConversationId;

    useAgentStore.getState().completeTask(true, undefined, 'A 完成');
    useAgentStore.getState().setActiveConnection('connection-b');
    useAgentStore.getState().startTask('检查 B', 'connection-b');
    const conversationB = useAgentStore.getState().activeConversationId;

    expect(conversationA).not.toBe(conversationB);
    expect(useAgentStore.getState().currentTask?.connectionId).toBe('connection-b');

    useAgentStore.getState().setActiveConnection('connection-a');
    expect(useAgentStore.getState().activeConversationId).toBe(conversationA);
    expect(useAgentStore.getState().currentTask).toBeNull();
  });
});
