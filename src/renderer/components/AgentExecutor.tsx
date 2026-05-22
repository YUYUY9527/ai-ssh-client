import { useEffect, useMemo, useRef } from 'react';
import { AgentRuntime, type AgentRuntimeSnapshot } from '../agent/agent-runtime';
import { useAgentStore } from '../store/useAgentStore';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { t } from '../i18n';

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
  const { activeConnectionId } = useConnectionStore();
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
    cancelAIChat: (requestId: string) => window.electronAPI?.cancelAIChat(requestId),
    agentStartTask: window.electronAPI?.agentStartTask,
    agentStopTask: window.electronAPI?.agentStopTask,
    agentExecAwait: window.electronAPI?.agentExecAwait,
    agentCancelExec: window.electronAPI?.agentCancelExec,
    onAgentTerminalOutput: window.electronAPI?.onAgentTerminalOutput,
    notifyTaskCompletion: async (success: boolean, reason: string) => {
      if (!window.electronAPI) return;

      const settingsResult = await window.electronAPI.getSettings();
      if (!settingsResult.success || !settingsResult.data.settings.commandNotifications) {
        return;
      }

      const title = success ? t('agent.notifications.taskCompleted') : t('agent.notifications.taskFailed');
      const body = reason.trim() || (success ? t('agent.notifications.completed') : t('agent.notifications.failed'));
      await window.electronAPI.showSystemNotification(title, body, {
        onlyWhenAppInBackground: true,
      });
    },
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
