import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  AIProviderConfig,
  AIProviderSummary,
  AppSettings,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  SSHConnection,
  SSHSessionState,
  Message,
  AgentTask,
  HostTrustRecord,
} from '../../shared/types';
import type {
  AIChatResult,
  AIChatStreamEvent,
  AIChatStreamOptions,
  AIProviderSecretStatusResult,
  AIProvidersResult,
  AgentExecAwaitResult,
  AgentTaskHistoryResult,
  CommandHistoryResult,
  ConnectionsResult,
  DirectoryListResult,
  ExportDataResult,
  FileDownloadResult,
  FileSelectResult,
  FileUploadResult,
  ImportDataResult,
  IPCResult,
  PrivateKeyFileResult,
  QuickCommandGroupsResult,
  QuickCommandsResult,
  SettingsResult,
  SftpTransferCompleteEvent,
  SSessionsResult,
  SSHConnectResult,
} from '../../shared/ipc-types';

export type ListenerCleanup = () => void;

type ElectronApiLike = {
  sshConnect: (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => Promise<IPCResult<SSHConnectResult>>;
  sshDisconnect: (connectionId: string) => Promise<IPCResult>;
  sshExecute: (connectionId: string, command: string) => Promise<IPCResult>;
  sshExecuteSync: (connectionId: string, command: string) => void;
  sshGetSessions: () => Promise<IPCResult<SSessionsResult>>;
  sshResize: (connectionId: string, cols: number, rows: number) => Promise<IPCResult>;
  sshTestConnection: (connection: SSHConnection) => Promise<IPCResult>;
  sshGetHostTrustRecord: (host: string, port: number) => Promise<IPCResult<{ record: HostTrustRecord | null }>>;
  onSshData: (callback: (data: { connectionId: string; data: string; type?: string; state?: SSHSessionState }) => void) => ListenerCleanup;
  onSshError: (callback: (data: { connectionId: string; error: string }) => void) => ListenerCleanup;
  onSshClose: (callback: (connectionId: string) => void) => ListenerCleanup;
  aiChat: (providerId: string, messages: Message[], options?: { requestId?: string }) => Promise<IPCResult<AIChatResult>>;
  aiChatStream: (providerId: string, messages: Message[], options: AIChatStreamOptions) => Promise<IPCResult<AIChatResult>>;
  cancelAIChat: (requestId: string) => Promise<IPCResult>;
  getAIProviders: () => Promise<IPCResult<AIProvidersResult<AIProviderSummary>>>;
  saveAIProvider: (provider: AIProviderConfig) => Promise<IPCResult>;
  setActiveAIProvider: (providerId: string) => Promise<IPCResult>;
  deleteAIProvider: (providerId: string) => Promise<IPCResult>;
  testAIProvider: (config: AIProviderConfig) => Promise<IPCResult<AIChatResult>>;
  getAIProviderSecretStatus: (providerId: string) => Promise<IPCResult<AIProviderSecretStatusResult>>;
  getConnections: () => Promise<IPCResult<ConnectionsResult<SSHConnection>>>;
  saveConnection: (connection: SSHConnection) => Promise<IPCResult>;
  deleteConnection: (connectionId: string) => Promise<IPCResult>;
  getSettings: () => Promise<IPCResult<SettingsResult<AppSettings>>>;
  saveSettings: (settings: AppSettings) => Promise<IPCResult>;
  getCommandHistory: () => Promise<IPCResult<CommandHistoryResult<CommandHistoryItem>>>;
  addCommandHistory: (item: CommandHistoryItem) => Promise<IPCResult>;
  clearCommandHistory: () => Promise<IPCResult>;
  getQuickCommands: () => Promise<IPCResult<QuickCommandsResult<QuickCommand>>>;
  saveQuickCommand: (command: QuickCommand) => Promise<IPCResult>;
  deleteQuickCommand: (commandId: string) => Promise<IPCResult>;
  getQuickCommandGroups: () => Promise<IPCResult<QuickCommandGroupsResult<QuickCommandGroup>>>;
  saveQuickCommandGroup: (group: QuickCommandGroup) => Promise<IPCResult>;
  deleteQuickCommandGroup: (groupId: string) => Promise<IPCResult>;
  exportAllData: () => Promise<IPCResult<ExportDataResult<any>>>;
  importData: (data: unknown, options?: { merge?: boolean }) => Promise<IPCResult<ImportDataResult>>;
  selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<IPCResult<FileSelectResult>>;
  readPrivateKeyFile: (filePath: string) => Promise<IPCResult<PrivateKeyFileResult>>;
  listDirectory: (connectionId: string, remotePath: string) => Promise<IPCResult<DirectoryListResult<any>>>;
  downloadFile: (connectionId: string, remotePath: string, taskId?: string) => Promise<IPCResult<FileDownloadResult>>;
  uploadFile: (connectionId: string, localPath: string, remoteDir: string, taskId?: string) => Promise<IPCResult<FileUploadResult>>;
  onSftpUploadProgress: (callback: (data: { connectionId: string; taskId?: string; filename: string; progress: number }) => void) => ListenerCleanup;
  onSftpDownloadProgress: (callback: (data: { connectionId: string; taskId?: string; filename: string; progress: number }) => void) => ListenerCleanup;
  onSftpTransferComplete: (callback: (data: SftpTransferCompleteEvent) => void) => ListenerCleanup;
  agentStartTask: (taskId: string, connectionId: string) => Promise<IPCResult>;
  agentStopTask: (connectionId: string) => Promise<IPCResult>;
  agentPauseTask: () => Promise<IPCResult>;
  agentResumeTask: () => Promise<IPCResult>;
  agentExecAwait: (connectionId: string, command: string, options?: { runId?: string; timeoutMs?: number }) => Promise<IPCResult<AgentExecAwaitResult>>;
  agentCancelExec: (connectionId: string) => Promise<IPCResult>;
  getAgentTaskHistory: () => Promise<IPCResult<AgentTaskHistoryResult<AgentTask>>>;
  saveAgentTaskHistory: (task: AgentTask) => Promise<IPCResult>;
  clearAgentTaskHistory: () => Promise<IPCResult>;
  deleteAgentTaskHistory: (taskId: string) => Promise<IPCResult>;
  onAgentTerminalOutput: (callback: (data: { connectionId: string; data: string }) => void) => ListenerCleanup;
  onSystemResume: (callback: (data: { timestamp: number }) => void) => ListenerCleanup;
};

type MessageHandler<T> = (payload: T) => void;

function makeError<T = void>(message: string): IPCResult<T> {
  return { success: false, error: message };
}

function createTauriListener<T>(eventName: string, handler: MessageHandler<T>): ListenerCleanup {
  let disposed = false;
  let cleanup: ListenerCleanup | null = null;

  listen<T>(eventName, (event) => {
    handler(event.payload);
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
      return;
    }
    cleanup = unlisten;
  }).catch((error) => {
    console.error(`[native] Failed to listen for ${eventName}:`, error);
    cleanup = null;
  });

  return () => {
    disposed = true;
    cleanup?.();
  };
}

export async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<IPCResult<T>> {
  try {
    const result = await invoke<IPCResult<T>>(command, args);
    return result;
  } catch (error) {
    return makeError<T>(error instanceof Error ? error.message : String(error));
  }
}

async function streamNativeChat(
  providerId: string,
  messages: Message[],
  options: AIChatStreamOptions,
): Promise<IPCResult<AIChatResult>> {
  let content = '';
  let settled = false;
  let resolveStream: (result: IPCResult<AIChatResult>) => void = () => {};
  const resultPromise = new Promise<IPCResult<AIChatResult>>((resolve) => {
    resolveStream = resolve;
  });
  let unlisten: ListenerCleanup = () => {};
  unlisten = await listen<AIChatStreamEvent>('ai-chat-stream', (event) => {
    const payload = event.payload;
    if (settled || payload.requestId !== options.requestId) return;

    options.onEvent(payload);
    if (payload.type === 'delta') {
      content += payload.delta;
      return;
    }

    settled = true;
    unlisten();
    if (payload.type === 'done') {
      resolveStream({
        success: true,
        data: {
          content,
          requestId: payload.requestId,
          model: payload.model,
          finishReason: payload.finishReason,
          usage: payload.usage,
        },
      });
    } else if (payload.type === 'canceled') {
      resolveStream({ success: false, error: 'AI request canceled', code: 'canceled' });
    } else {
      resolveStream({ success: false, error: payload.error, code: payload.code });
    }
  });

  const started = await tauriInvoke<{ requestId: string }>('ai_chat_stream', {
    providerId,
    messages,
    options: { requestId: options.requestId },
  });
  if (!started.success) {
    settled = true;
    unlisten();
    return started;
  }

  return resultPromise;
}

const nativeApi: ElectronApiLike = {
  sshConnect: (connection, cols, rows, settings) => tauriInvoke<SSHConnectResult>('ssh_connect', { connection, cols, rows, settings }),
  sshDisconnect: (connectionId) => tauriInvoke<void>('ssh_disconnect', { connectionId }),
  sshExecute: (connectionId, command) => tauriInvoke<void>('ssh_execute', { connectionId, command }),
  sshExecuteSync: (connectionId, command) => {
    void tauriInvoke<void>('ssh_execute_sync', { connectionId, command });
  },
  sshGetSessions: () => tauriInvoke<SSessionsResult>('ssh_get_sessions'),
  sshResize: (connectionId, cols, rows) => tauriInvoke<void>('ssh_resize', { connectionId, cols, rows }),
  sshTestConnection: (connection) => tauriInvoke<void>('ssh_test_connection', { connection }),
  sshGetHostTrustRecord: (host, port) => tauriInvoke<{ record: HostTrustRecord | null }>('ssh_get_host_trust_record', { host, port }),
  onSshData: (callback) => createTauriListener('ssh-data', callback),
  onSshError: (callback) => createTauriListener('ssh-error', callback),
  onSshClose: (callback) => createTauriListener('ssh-close', callback),
  aiChat: (providerId, messages, options) => tauriInvoke<AIChatResult>('ai_chat', { providerId, messages, options }),
  aiChatStream: streamNativeChat,
  cancelAIChat: (requestId) => tauriInvoke<void>('ai_cancel_chat', { requestId }),
  getAIProviders: () => tauriInvoke<AIProvidersResult<AIProviderSummary>>('ai_get_providers'),
  saveAIProvider: (provider) => tauriInvoke<void>('ai_save_provider', { provider }),
  setActiveAIProvider: (providerId) => tauriInvoke<void>('ai_set_active_provider', { providerId }),
  deleteAIProvider: (providerId) => tauriInvoke<void>('ai_delete_provider', { providerId }),
  testAIProvider: (config) => tauriInvoke<AIChatResult>('ai_test_provider', { config }),
  getAIProviderSecretStatus: (providerId) => tauriInvoke<AIProviderSecretStatusResult>('ai_get_provider_secret_status', { providerId }),
  getConnections: () => tauriInvoke<ConnectionsResult<SSHConnection>>('get_connections'),
  saveConnection: (connection) => tauriInvoke<void>('save_connection', { connection }),
  deleteConnection: (connectionId) => tauriInvoke<void>('delete_connection', { connectionId }),
  getSettings: () => tauriInvoke<SettingsResult<AppSettings>>('get_settings'),
  saveSettings: (settings) => tauriInvoke<void>('save_settings', { settings }),
  getCommandHistory: () => tauriInvoke<CommandHistoryResult<CommandHistoryItem>>('get_command_history'),
  addCommandHistory: (item) => tauriInvoke<void>('add_command_history', { item }),
  clearCommandHistory: () => tauriInvoke<void>('clear_command_history'),
  getQuickCommands: () => tauriInvoke<QuickCommandsResult<QuickCommand>>('get_quick_commands'),
  saveQuickCommand: (command) => tauriInvoke<void>('save_quick_command', { command }),
  deleteQuickCommand: (commandId) => tauriInvoke<void>('delete_quick_command', { commandId }),
  getQuickCommandGroups: () => tauriInvoke<QuickCommandGroupsResult<QuickCommandGroup>>('get_quick_command_groups'),
  saveQuickCommandGroup: (group) => tauriInvoke<void>('save_quick_command_group', { group }),
  deleteQuickCommandGroup: (groupId) => tauriInvoke<void>('delete_quick_command_group', { groupId }),
  exportAllData: () => tauriInvoke<ExportDataResult<any>>('export_all_data'),
  importData: (data, options) => tauriInvoke<ImportDataResult>('import_data', { data, options }),
  selectFile: (options) => tauriInvoke<FileSelectResult>('select_file', { options }),
  readPrivateKeyFile: (filePath) => tauriInvoke<PrivateKeyFileResult>('read_private_key_file', { filePath }),
  listDirectory: (connectionId, remotePath) => tauriInvoke<DirectoryListResult<any>>('sftp_list_directory', { connectionId, remotePath }),
  downloadFile: (connectionId, remotePath, taskId) => tauriInvoke<FileDownloadResult>('sftp_download_file', { connectionId, remotePath, taskId }),
  uploadFile: (connectionId, localPath, remoteDir, taskId) => tauriInvoke<FileUploadResult>('sftp_upload_file', { connectionId, localPath, remoteDir, taskId }),
  onSftpUploadProgress: (callback) => createTauriListener('sftp-upload-progress', callback),
  onSftpDownloadProgress: (callback) => createTauriListener('sftp-download-progress', callback),
  onSftpTransferComplete: (callback) => createTauriListener('sftp-transfer-complete', callback),
  agentStartTask: (taskId, connectionId) => tauriInvoke<void>('agent_start_task', { taskId, connectionId }),
  agentStopTask: (connectionId) => tauriInvoke<void>('agent_stop_task', { connectionId }),
  agentPauseTask: () => tauriInvoke<void>('agent_pause_task'),
  agentResumeTask: () => tauriInvoke<void>('agent_resume_task'),
  agentExecAwait: (connectionId, command, options) => tauriInvoke<AgentExecAwaitResult>('agent_exec_await', { connectionId, command, options }),
  agentCancelExec: (connectionId) => tauriInvoke<void>('agent_cancel_exec', { connectionId }),
  getAgentTaskHistory: () => tauriInvoke<AgentTaskHistoryResult<AgentTask>>('agent_get_task_history'),
  saveAgentTaskHistory: (task) => tauriInvoke<void>('agent_save_task_history', { task }),
  clearAgentTaskHistory: () => tauriInvoke<void>('agent_clear_task_history'),
  deleteAgentTaskHistory: (taskId) => tauriInvoke<void>('agent_delete_task_history', { taskId }),
  onAgentTerminalOutput: (callback) => createTauriListener('agent-terminal-output', callback),
  onSystemResume: (callback) => createTauriListener('system-resume', callback),
};

export function installNativeApi(): void {
  (window as Window & { electronAPI?: ElectronApiLike }).electronAPI = nativeApi;
}
