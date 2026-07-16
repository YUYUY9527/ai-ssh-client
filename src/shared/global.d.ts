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
  AgentTask,
  SSHSessionState,
  HostTrustRecord,
  HostTrustPromptEvent,
} from './types';
import type {
  IPCResult,
  SSHConnectResult,
  SshOutputBufferResult,
  SSessionsResult,
  AIChatResult,
  AIChatStreamOptions,
  AIProvidersResult,
  ConnectionsResult,
  CommandHistoryResult,
  QuickCommandsResult,
  QuickCommandGroupsResult,
  SettingsResult,
  FileSelectResult,
  PrivateKeyFileResult,
  DirectoryListResult,
  SftpBatchDeleteResult,
  SftpDownloadDestinationSelectionResult,
  SftpFilesSelectionResult,
  SftpListTransfersResult,
  SftpResolveConflictRequest,
  SftpStartDownloadRequest,
  SftpStartTransferResult,
  SftpStartUploadRequest,
  SftpTransferEvent,
  SftpTransferTaskRequest,
  SftpTransferTaskSnapshot,
  ExportDataResult,
  ImportDataResult,
  AIProviderSecretStatusResult,
  AgentExecAwaitResult,
  AgentTaskHistoryResult,
} from './ipc-types';

declare global {
  interface Window {
    electronAPI: {
      sshConnect: (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => Promise<IPCResult<SSHConnectResult>>;
      sshDisconnect: (connectionId: string) => Promise<IPCResult>;
      sshExecute: (connectionId: string, command: string) => Promise<IPCResult>;
      sshExecuteSync: (connectionId: string, command: string) => void;
      sshGetSessions: () => Promise<IPCResult<SSessionsResult>>;
      /** 拉取服务端会话输出缓冲（Web 刷新重挂补齐提示符）。 */
      sshGetOutputBuffer?: (connectionId: string) => Promise<IPCResult<SshOutputBufferResult>>;
      sshResize: (connectionId: string, cols: number, rows: number) => Promise<IPCResult>;
      sshTestConnection: (connection: SSHConnection) => Promise<IPCResult>;
      sshGetHostTrustRecord: (host: string, port: number) => Promise<IPCResult<{ record: HostTrustRecord | null }>>;
      sshListHostTrustRecords: () => Promise<IPCResult<{ records: HostTrustRecord[] }>>;
      sshUpsertHostTrustRecord: (record: HostTrustRecord) => Promise<IPCResult>;
      sshDeleteHostTrustRecord: (host: string, port: number) => Promise<IPCResult>;
      sshClearHostTrustRecords: () => Promise<IPCResult>;
      sshRespondHostTrust: (requestId: string, accepted: boolean) => Promise<IPCResult>;

      onSshData: (callback: (data: { connectionId: string; data: string; type?: string; state?: SSHSessionState }) => void) => () => void;
      onSshError: (callback: (data: { connectionId: string; error: string }) => void) => () => void;
      onSshClose: (callback: (connectionId: string) => void) => () => void;
      onSshHostTrustPrompt: (callback: (data: HostTrustPromptEvent) => void) => () => void;

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
      reorderConnections: (connectionIds: string[]) => Promise<IPCResult>;

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

      exportAllData: (options?: { includeSecrets?: boolean }) => Promise<IPCResult<ExportDataResult<any>>>;
      importData: (data: any, options?: { merge?: boolean }) => Promise<IPCResult<ImportDataResult>>;

      selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<IPCResult<FileSelectResult>>;
      readPrivateKeyFile: (filePath: string) => Promise<IPCResult<PrivateKeyFileResult>>;

      listDirectory: (connectionId: string, remotePath: string) => Promise<IPCResult<DirectoryListResult>>;
      selectSftpFiles: () => Promise<IPCResult<SftpFilesSelectionResult>>;
      selectSftpDownloadDestination: () => Promise<IPCResult<SftpDownloadDestinationSelectionResult>>;
      /** 将浏览器/拖放 File 注册为上传引用；桌面端优先提取 path。 */
      prepareSftpLocalFiles?: (files: File[]) => IPCResult<SftpFilesSelectionResult>;
      createSftpDirectory: (connectionId: string, remotePath: string) => Promise<IPCResult>;
      /** 修改远端文件/目录权限（mode 为 0–0o7777）。 */
      setSftpPermissions: (connectionId: string, remotePath: string, mode: number) => Promise<IPCResult>;
      deleteSftpItems: (connectionId: string, remotePaths: string[]) => Promise<IPCResult<SftpBatchDeleteResult>>;
      startSftpUpload: (request: SftpStartUploadRequest) => Promise<IPCResult<SftpStartTransferResult>>;
      startSftpDownload: (request: SftpStartDownloadRequest) => Promise<IPCResult<SftpStartTransferResult>>;
      resolveSftpConflict: (request: SftpResolveConflictRequest) => Promise<IPCResult>;
      cancelSftpTransfer: (request: SftpTransferTaskRequest) => Promise<IPCResult>;
      retrySftpTransfer: (request: SftpTransferTaskRequest) => Promise<IPCResult<SftpTransferTaskSnapshot>>;
      discardSftpTransfer: (request: SftpTransferTaskRequest) => Promise<IPCResult>;
      listSftpTransfers: (connectionId?: string) => Promise<IPCResult<SftpListTransfersResult>>;
      onSftpTransferEvent: (callback: (event: SftpTransferEvent) => void) => () => void;

      renameItem: (connectionId: string, remotePath: string, newName: string) => Promise<IPCResult>;
      deleteItem: (connectionId: string, remotePath: string) => Promise<IPCResult>;
      /** 读取远端文本文件（受 MAX_SFTP_EDIT_BYTES 限制）。 */
      readSftpTextFile: (connectionId: string, remotePath: string) => Promise<IPCResult<import('./ipc-types').SftpTextFileContent>>;
      /** 覆盖写入远端文本文件。 */
      writeSftpTextFile: (connectionId: string, remotePath: string, content: string) => Promise<IPCResult>;

      agentStartTask: (taskId: string, connectionId: string) => Promise<IPCResult>;
      agentStopTask: (connectionId: string) => Promise<IPCResult>;
      agentPauseTask: () => Promise<IPCResult>;
      agentResumeTask: () => Promise<IPCResult>;
      agentExecAwait: (
        connectionId: string,
        command: string,
        options?: { runId?: string; timeoutMs?: number },
      ) => Promise<IPCResult<AgentExecAwaitResult>>;
      agentCancelExec: (connectionId: string) => Promise<IPCResult>;
      getAgentTaskHistory: () => Promise<IPCResult<AgentTaskHistoryResult<AgentTask>>>;
      saveAgentTaskHistory: (task: AgentTask) => Promise<IPCResult>;
      clearAgentTaskHistory: () => Promise<IPCResult>;
      deleteAgentTaskHistory: (taskId: string) => Promise<IPCResult>;
      onAgentTerminalOutput: (callback: (data: { connectionId: string; data: string }) => void) => () => void;

      onSystemResume: (callback: (data: { timestamp: number }) => void) => () => void;

      /** Web 部署专用：查询登录状态（含是否仍为默认密码）。 */
      getAuthStatus?: () => Promise<IPCResult<{ authenticated: boolean; usingDefaultPassword: boolean; passwordManaged: boolean }>>;
      /** Web 部署专用：修改登录密码。 */
      webChangePassword?: (oldPassword: string, newPassword: string) => Promise<IPCResult>;
    };
    /** Web 部署下由 installWebApi 设置，桌面端为 undefined。 */
    __AISSH_WEB__?: boolean;
  }
}

export {};
