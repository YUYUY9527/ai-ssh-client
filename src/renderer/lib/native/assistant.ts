import type {
  AIProviderConfig,
  AIProviderSummary,
  AgentTask,
  Message,
} from '../../../shared/types';
import type {
  AIChatResult,
  AIProviderSecretStatusResult,
  AIProvidersResult,
  AgentExecAwaitResult,
  AgentTaskHistoryResult,
  IPCResult,
} from '../../../shared/ipc-types';
import { tauriInvoke } from '../native';

export const nativeAssistant = {
  chat: (
    providerId: string,
    messages: Message[],
    options?: { requestId?: string },
  ): Promise<IPCResult<AIChatResult>> => (
    tauriInvoke<AIChatResult>('ai_chat', { providerId, messages, options })
  ),
  cancelChat: (requestId: string): Promise<IPCResult> => (
    tauriInvoke<void>('ai_cancel_chat', { requestId })
  ),
  getProviders: (): Promise<IPCResult<AIProvidersResult<AIProviderSummary>>> => (
    tauriInvoke<AIProvidersResult<AIProviderSummary>>('ai_get_providers')
  ),
  saveProvider: (provider: AIProviderConfig): Promise<IPCResult> => (
    tauriInvoke<void>('ai_save_provider', { provider })
  ),
  setActiveProvider: (providerId: string): Promise<IPCResult> => (
    tauriInvoke<void>('ai_set_active_provider', { providerId })
  ),
  deleteProvider: (providerId: string): Promise<IPCResult> => (
    tauriInvoke<void>('ai_delete_provider', { providerId })
  ),
  testProvider: (config: AIProviderConfig): Promise<IPCResult<AIChatResult>> => (
    tauriInvoke<AIChatResult>('ai_test_provider', { config })
  ),
  getProviderSecretStatus: (
    providerId: string,
  ): Promise<IPCResult<AIProviderSecretStatusResult>> => (
    tauriInvoke<AIProviderSecretStatusResult>('ai_get_provider_secret_status', { providerId })
  ),
  agentExecAwait: (
    connectionId: string,
    command: string,
    options?: { runId?: string; timeoutMs?: number },
  ): Promise<IPCResult<AgentExecAwaitResult>> => (
    tauriInvoke<AgentExecAwaitResult>('agent_exec_await', { connectionId, command, options })
  ),
  getAgentTaskHistory: (): Promise<IPCResult<AgentTaskHistoryResult<AgentTask>>> => (
    tauriInvoke<AgentTaskHistoryResult<AgentTask>>('agent_get_task_history')
  ),
};
