import { useEffect, useMemo, useRef } from 'react';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/agent-runtime';
import { useAgentStore } from '../store/useAgentStore';
import { useAIStore } from '../store/useAIStore';
import { useSessionStore } from '../session/useSessionStore';

export function AgentExecutor() {
  const {
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
    setAgentState,
    addThinkingStep,
    updateThinkingStep,
    completeTask,
    setPendingApproval,
    setApprovalResult,
    setPendingQuestion,
    setPendingInput,
    setPendingTerminalPrompt,
    trimAgentContext,
    taskHistory,
    activeConversationId,
  } = useAgentStore();

  const { providers, activeProviderId } = useAIStore();
  const activeConnectionId = useSessionStore((state) => state.activeSessionId);
  const runtimeRef = useRef<AgentRuntime | null>(null);

  const actions = useMemo(() => ({
    setAgentState,
    addThinkingStep,
    updateThinkingStep,
    completeTask,
    setPendingApproval,
    setApprovalResult,
    setPendingQuestion,
    setPendingInput,
    setPendingTerminalPrompt,
    trimAgentContext,
  }), [
    setAgentState,
    addThinkingStep,
    updateThinkingStep,
    completeTask,
    setPendingApproval,
    setApprovalResult,
    setPendingQuestion,
    setPendingInput,
    setPendingTerminalPrompt,
    trimAgentContext,
  ]);

  const services = useMemo(() => ({
    analyzeCommand: (command: string) => useAIStore.getState().analyzeCommand(command),
    aiChat: (
      providerId: string,
      messages: Parameters<NonNullable<typeof window.electronAPI>['aiChat']>[1],
      options?: { requestId?: string },
    ) => {
      if (!window.electronAPI) {
        throw new Error('Electron API unavailable');
      }
      return window.electronAPI.aiChat(providerId, messages, options);
    },
    aiChatStream: (
      providerId: string,
      messages: Parameters<NonNullable<typeof window.electronAPI>['aiChatStream']>[1],
      options: Parameters<NonNullable<typeof window.electronAPI>['aiChatStream']>[2],
    ) => {
      if (!window.electronAPI) {
        throw new Error('Electron API unavailable');
      }
      return window.electronAPI.aiChatStream(providerId, messages, options);
    },
    cancelAIChat: (requestId: string) => window.electronAPI?.cancelAIChat(requestId),
    agentStartTask: window.electronAPI?.agentStartTask,
    agentStopTask: window.electronAPI?.agentStopTask,
    agentExecAwait: window.electronAPI?.agentExecAwait,
    agentCancelExec: window.electronAPI?.agentCancelExec,
    onAgentTerminalOutput: window.electronAPI?.onAgentTerminalOutput,
    notifyTaskCompletion: async () => {},
  }), []);

  const snapshot: AgentRuntimeSnapshot = {
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
    taskHistory,
    activeConversationId,
    activeProviderId,
    activeConnectionId,
    providers,
  };

  useEffect(() => {
    const runtime = new AgentRuntime(snapshot, actions, services);
    runtime.start();
    runtimeRef.current = runtime;

    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [actions, services]);

  useEffect(() => {
    runtimeRef.current?.sync(snapshot);
  }, [
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
    taskHistory,
    activeConversationId,
    activeProviderId,
    activeConnectionId,
    providers,
  ]);

  return null;
}
