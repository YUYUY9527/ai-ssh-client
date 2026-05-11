import { useEffect, useMemo, useRef } from 'react';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/agent-runtime';
import { useAgentStore } from '../store/useAgentStore';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';

export function AgentExecutor() {
  const {
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
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
  } = useAgentStore();

  const { providers, activeProviderId } = useAIStore();
  const { activeConnectionId, executeCommand } = useConnectionStore();
  const runtimeRef = useRef<AgentRuntime | null>(null);

  const actions = useMemo(() => ({
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
    cancelAIChat: (requestId: string) => window.electronAPI?.cancelAIChat(requestId),
    executeCommand,
    agentStartTask: window.electronAPI?.agentStartTask,
    agentStopTask: window.electronAPI?.agentStopTask,
    agentExecuteCommand: window.electronAPI?.agentExecuteCommand,
    agentExecAwait: window.electronAPI?.agentExecAwait,
    agentCancelExec: window.electronAPI?.agentCancelExec,
    onAgentTerminalOutput: window.electronAPI?.onAgentTerminalOutput,
    notifyTaskCompletion: async (success: boolean, reason: string) => {
      if (!window.electronAPI) return;

      const settingsResult = await window.electronAPI.getSettings();
      if (!settingsResult.success || !settingsResult.data.settings.commandNotifications) {
        return;
      }

      const title = success ? 'AI 任务执行完成' : 'AI 任务执行失败';
      const body = reason.trim() || (success ? '任务完成' : '任务失败');
      await window.electronAPI.showSystemNotification(title, body, {
        onlyWhenAppInBackground: true,
      });
    },
  }), [executeCommand]);

  const snapshot: AgentRuntimeSnapshot = {
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
    taskHistory,
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
    activeProviderId,
    activeConnectionId,
    providers,
  ]);

  return null;
}
