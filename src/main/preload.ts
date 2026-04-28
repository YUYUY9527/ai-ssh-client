import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  SSHConnection,
  AIProviderConfig,
  Message,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  AppSettings,
  SSHSessionState,
} from '../shared/types';
import type {
  IPCResult,
  SSHConnectResult,
  SSessionsResult,
  AIChatResult,
  AIProvidersResult,
  ConnectionsResult,
  CommandHistoryResult,
  QuickCommandsResult,
  QuickCommandGroupsResult,
  SettingsResult,
  FileSelectResult,
  PrivateKeyFileResult,
  DirectoryListResult,
  FileDownloadResult,
  FileUploadResult,
  ExportDataResult,
  ImportDataResult,
  AIProviderSecretStatusResult,
} from '../shared/ipc-types';

interface SystemNotificationOptions {
  onlyWhenAppInBackground?: boolean;
}

const listenerMap = new Map<string, Set<{ handler: (...args: any[]) => void; wrappedHandler: (...args: any[]) => void }>>();

function addListener(
  channel: string,
  callback: (...args: any[]) => void
): () => void {
  if (!listenerMap.has(channel)) {
    listenerMap.set(channel, new Set());
  }

  const wrappedHandler = (_event: Electron.IpcRendererEvent, payload: any) => callback(payload);
  const listenerSet = listenerMap.get(channel)!;
  const entry = { handler: callback, wrappedHandler };

  listenerSet.add(entry);
  ipcRenderer.on(channel, wrappedHandler);

  return () => {
    listenerSet.delete(entry);
    ipcRenderer.removeListener(channel, wrappedHandler);
    if (listenerSet.size === 0) {
      listenerMap.delete(channel);
    }
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  sshConnect: (connection: SSHConnection, cols?: number, rows?: number): Promise<IPCResult<SSHConnectResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_CONNECT, connection, cols, rows),
  sshDisconnect: (connectionId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_DISCONNECT, connectionId),
  sshExecute: (connectionId: string, command: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_EXECUTE, connectionId, command),
  sshExecuteSync: (connectionId: string, command: string): void =>
    ipcRenderer.send(IPC_CHANNELS.SSH_EXECUTE_SYNC, connectionId, command),
  sshReconnect: (connectionId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_RECONNECT, connectionId),
  sshGetSessions: (): Promise<IPCResult<SSessionsResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_GET_SESSIONS),
  sshTestConnection: (connection: SSHConnection): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TEST_CONNECTION, connection),
  sshResize: (connectionId: string, cols: number, rows: number): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_RESIZE, connectionId, cols, rows),

  onSshData: (callback: (data: { connectionId: string; data: string; type?: string; state?: SSHSessionState }) => void) => {
    return addListener(IPC_CHANNELS.SSH_DATA, callback);
  },

  onSshError: (callback: (data: { connectionId: string; error: string }) => void) => {
    return addListener(IPC_CHANNELS.SSH_ERROR, callback);
  },

  onSshClose: (callback: (connectionId: string) => void) => {
    return addListener(IPC_CHANNELS.SSH_CLOSE, callback);
  },

  aiChat: (providerId: string, messages: Message[], options?: { requestId?: string }): Promise<IPCResult<AIChatResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_CHAT, providerId, messages, options),
  cancelAIChat: (requestId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_CANCEL_CHAT, requestId),
  getAIProviders: (): Promise<IPCResult<AIProvidersResult>> => ipcRenderer.invoke(IPC_CHANNELS.AI_GET_PROVIDERS),
  saveAIProvider: (provider: AIProviderConfig): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_SAVE_PROVIDER, provider),
  setActiveAIProvider: (providerId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_SET_ACTIVE_PROVIDER, providerId),
  deleteAIProvider: (providerId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_DELETE_PROVIDER, providerId),
  testAIProvider: (config: AIProviderConfig): Promise<IPCResult<AIChatResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_TEST_PROVIDER, config),
  getAIProviderSecretStatus: (providerId: string): Promise<IPCResult<AIProviderSecretStatusResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_GET_PROVIDER_SECRET_STATUS, providerId),

  getConnections: (): Promise<IPCResult<ConnectionsResult<SSHConnection>>> => ipcRenderer.invoke(IPC_CHANNELS.GET_CONNECTIONS),
  saveConnection: (connection: SSHConnection): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CONNECTION, connection),
  deleteConnection: (connectionId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_CONNECTION, connectionId),

  getSettings: (): Promise<IPCResult<SettingsResult<AppSettings>>> => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),
  saveSettings: (settings: AppSettings): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SAVE_SETTINGS, settings),
  showSystemNotification: (title: string, body?: string, options?: SystemNotificationOptions): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_SYSTEM_NOTIFICATION, { title, body, ...options }),

  getCommandHistory: (): Promise<IPCResult<CommandHistoryResult<CommandHistoryItem>>> => ipcRenderer.invoke(IPC_CHANNELS.GET_COMMAND_HISTORY),
  addCommandHistory: (item: CommandHistoryItem): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.ADD_COMMAND_HISTORY, item),
  clearCommandHistory: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_COMMAND_HISTORY),

  getQuickCommands: (): Promise<IPCResult<QuickCommandsResult<QuickCommand>>> => ipcRenderer.invoke(IPC_CHANNELS.GET_QUICK_COMMANDS),
  saveQuickCommand: (command: QuickCommand): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SAVE_QUICK_COMMAND, command),
  deleteQuickCommand: (commandId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_QUICK_COMMAND, commandId),

  getQuickCommandGroups: (): Promise<IPCResult<QuickCommandGroupsResult<QuickCommandGroup>>> => ipcRenderer.invoke(IPC_CHANNELS.GET_QUICK_COMMAND_GROUPS),
  saveQuickCommandGroup: (group: QuickCommandGroup): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.SAVE_QUICK_COMMAND_GROUP, group),
  deleteQuickCommandGroup: (groupId: string): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_QUICK_COMMAND_GROUP, groupId),

  exportAllData: (): Promise<IPCResult<ExportDataResult<any>>> => ipcRenderer.invoke('export-all-data'),
  importData: (data: unknown, options?: { merge?: boolean }): Promise<IPCResult<ImportDataResult>> => ipcRenderer.invoke('import-data', data, options),

  selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<IPCResult<FileSelectResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE, options || {}),
  readPrivateKeyFile: (filePath: string): Promise<IPCResult<PrivateKeyFileResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.READ_PRIVATE_KEY_FILE, filePath),

  listDirectory: (connectionId: string, remotePath: string): Promise<IPCResult<DirectoryListResult<any>>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SFTP_LIST_DIRECTORY, connectionId, remotePath),
  downloadFile: (connectionId: string, remotePath: string): Promise<IPCResult<FileDownloadResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SFTP_DOWNLOAD_FILE, connectionId, remotePath),
  uploadFile: (connectionId: string, localPath: string, remoteDir: string): Promise<IPCResult<FileUploadResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SFTP_UPLOAD_FILE, connectionId, localPath, remoteDir),

  onSftpUploadProgress: (callback: (data: { connectionId: string; filename: string; progress: number }) => void) => {
    return addListener('sftp-upload-progress', callback);
  },

  agentStartTask: (taskId: string, connectionId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_START_TASK, taskId, connectionId),
  agentStopTask: (connectionId: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP_TASK, connectionId),
  agentPauseTask: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PAUSE_TASK),
  agentResumeTask: (): Promise<IPCResult> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_RESUME_TASK),
  agentExecuteCommand: (connectionId: string, command: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_EXECUTE_COMMAND, connectionId, command),
  agentCommandApproval: (approved: boolean): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_COMMAND_APPROVAL, approved),

  onAgentTerminalOutput: (callback: (data: { connectionId: string; data: string }) => void) => {
    return addListener(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, callback);
  },

  onAgentCommandApproval: (callback: (data: { approved: boolean; command: any }) => void) => {
    return addListener(IPC_CHANNELS.AGENT_COMMAND_APPROVAL, callback);
  },

  onSystemResume: (callback: (data: { timestamp: number }) => void) => {
    return addListener('system-resume', callback);
  },
});
