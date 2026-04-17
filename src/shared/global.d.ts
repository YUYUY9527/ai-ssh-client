import type {
  SSHConnection,
  AIProviderConfig,
  AIProviderSummary,
  Message,
  CommandSuggestion,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  AppSettings,
  SSHSessionState,
} from './types';
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
  DirectoryListResult,
  FileDownloadResult,
  FileUploadResult,
  ExportDataResult,
  ImportDataResult,
  AIProviderSecretStatusResult,
} from './ipc-types';

declare global {
  interface Window {
    electronAPI: {
      sshConnect: (connection: SSHConnection, cols?: number, rows?: number) => Promise<IPCResult<SSHConnectResult>>;
      sshDisconnect: (connectionId: string) => Promise<IPCResult>;
      sshExecute: (connectionId: string, command: string) => Promise<IPCResult>;
      sshExecuteSync: (connectionId: string, command: string) => void;
      sshReconnect: (connectionId: string) => Promise<IPCResult>;
      sshGetSessions: () => Promise<IPCResult<SSessionsResult>>;
      sshResize: (connectionId: string, cols: number, rows: number) => Promise<IPCResult>;
      sshTestConnection: (connection: SSHConnection) => Promise<IPCResult>;

      onSshData: (callback: (data: { connectionId: string; data: string; type?: string; state?: SSHSessionState }) => void) => () => void;
      onSshError: (callback: (data: { connectionId: string; error: string }) => void) => () => void;
      onSshClose: (callback: (connectionId: string) => void) => () => void;

      aiChat: (providerId: string, messages: Message[], options?: { requestId?: string }) => Promise<IPCResult<AIChatResult>>;
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
      showSystemNotification: (title: string, body?: string, options?: { onlyWhenAppInBackground?: boolean }) => Promise<IPCResult>;

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
      importData: (data: any, options?: { merge?: boolean }) => Promise<IPCResult>;

      selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<IPCResult<FileSelectResult>>;

      listDirectory: (connectionId: string, remotePath: string) => Promise<IPCResult<DirectoryListResult<any>>>;
      downloadFile: (connectionId: string, remotePath: string) => Promise<IPCResult<FileDownloadResult>>;
      uploadFile: (connectionId: string, localPath: string, remoteDir: string) => Promise<IPCResult<FileUploadResult>>;
      onSftpUploadProgress: (callback: (data: { connectionId: string; filename: string; progress: number }) => void) => () => void;

      agentStartTask: (taskId: string, connectionId: string) => Promise<IPCResult>;
      agentPauseTask: () => Promise<IPCResult>;
      agentResumeTask: () => Promise<IPCResult>;
      agentExecuteCommand: (connectionId: string, command: string) => Promise<IPCResult>;
      agentCommandApproval: (approved: boolean) => Promise<IPCResult>;
      onAgentTerminalOutput: (callback: (data: { connectionId: string; data: string; fullOutput: string }) => void) => () => void;
      onAgentCommandApproval: (callback: (data: { approved: boolean; command: any }) => void) => () => void;

      onSystemResume: (callback: (data: { timestamp: number }) => void) => () => void;

      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
  }
}

export {};
