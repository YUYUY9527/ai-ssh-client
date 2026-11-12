import type {
  SSHConnection,
  AIProviderConfig,
  AIProviderSummary,
  Message,
  CommandSuggestion,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  ConnectionGroup,
  AppSettings,
  AgentTask,
  SSHSessionState,
  HostTrustRecord,
  HostTrustPromptEvent,
  McpPolicyConfig,
  McpConfigSnapshot,
  McpConfigSaveResult,
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
  ConnectionGroupsResult,
  ServerMonitorMetrics,
  PortForwardListResult,
  PortForwardRuntimeState,
  DockerContainerListResult,
  DockerContainerDetail,
  DockerLogsResult,
  DockerActionResult,
  SftpSearchMode,
  SftpSearchResult,
  SftpPreviewResult,
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
      /**
       * 探测交互 shell 真实 PWD（非 SFTP 家目录）。
       * Web 端走 /api/ssh/:id/pwd；桌面端暂无实现时可省略。
       */
      sshProbePwd?: (connectionId: string) => Promise<IPCResult<{ cwd: string }>>;
      sshResize: (connectionId: string, cols: number, rows: number) => Promise<IPCResult>;
      sshTestConnection: (connection: SSHConnection) => Promise<IPCResult>;
      listPortForwards?: (connectionId: string) => Promise<IPCResult<PortForwardListResult>>;
      startPortForward?: (connectionId: string, ruleId: string) => Promise<IPCResult<PortForwardRuntimeState>>;
      stopPortForward?: (connectionId: string, ruleId: string) => Promise<IPCResult<{ stopped: boolean }>>;
      listDockerContainers?: (connectionId: string) => Promise<IPCResult<DockerContainerListResult>>;
      inspectDockerContainer?: (connectionId: string, containerId: string) => Promise<IPCResult<DockerContainerDetail>>;
      dockerContainerLogs?: (connectionId: string, containerId: string, tail?: number) => Promise<IPCResult<DockerLogsResult>>;
      dockerContainerAction?: (connectionId: string, containerId: string, action: string) => Promise<IPCResult<DockerActionResult>>;
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

      /** 连接分组（文件夹）。Web 优先；桌面端未实现时 UI 自动隐藏。 */
      getConnectionGroups?: () => Promise<IPCResult<ConnectionGroupsResult<ConnectionGroup>>>;
      saveConnectionGroup?: (group: ConnectionGroup) => Promise<IPCResult>;
      deleteConnectionGroup?: (groupId: string) => Promise<IPCResult>;

      exportAllData: (options?: { includeSecrets?: boolean }) => Promise<IPCResult<ExportDataResult<any>>>;
      importData: (data: any, options?: { merge?: boolean }) => Promise<IPCResult<ImportDataResult>>;

      selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => Promise<IPCResult<FileSelectResult>>;
      readPrivateKeyFile: (filePath: string) => Promise<IPCResult<PrivateKeyFileResult>>;

      listDirectory: (connectionId: string, remotePath: string) => Promise<IPCResult<DirectoryListResult>>;
      /** 递归展开远端文件夹，返回所有文件绝对路径；仅 Web 端提供。 */
      listSftpFolderFiles?: (connectionId: string, rootPath: string) => Promise<IPCResult<{ files: string[]; truncated: boolean }>>;
      selectSftpFiles: () => Promise<IPCResult<SftpFilesSelectionResult>>;
      /** 选择整个文件夹做递归上传（webkitdirectory）；仅 Web 端提供，文件含 relativePath。 */
      selectSftpFolder?: () => Promise<IPCResult<SftpFilesSelectionResult>>;
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
      /** 暂停任务（保留断点，可继续）。Web 优先；桌面端未实现时按钮隐藏。 */
      pauseSftpTransfer?: (request: SftpTransferTaskRequest) => Promise<IPCResult<SftpTransferTaskSnapshot>>;
      /** 继续已暂停任务（从断点续传）。Web 优先；桌面端未实现时按钮隐藏。 */
      resumeSftpTransfer?: (request: SftpTransferTaskRequest) => Promise<IPCResult<SftpTransferTaskSnapshot>>;
      retrySftpTransfer: (request: SftpTransferTaskRequest) => Promise<IPCResult<SftpTransferTaskSnapshot>>;
      discardSftpTransfer: (request: SftpTransferTaskRequest) => Promise<IPCResult>;
      listSftpTransfers: (connectionId?: string) => Promise<IPCResult<SftpListTransfersResult>>;
      onSftpTransferEvent: (callback: (event: SftpTransferEvent) => void) => () => void;

      renameItem: (connectionId: string, remotePath: string, newName: string) => Promise<IPCResult>;
      deleteItem: (connectionId: string, remotePath: string) => Promise<IPCResult>;
      /** 读取远端文本文件（受 MAX_SFTP_EDIT_BYTES 限制）。 */
      readSftpTextFile: (connectionId: string, remotePath: string, sudoPassword?: string) => Promise<IPCResult<import('./ipc-types').SftpTextFileContent>>;
      /** 覆盖写入远端文本文件。 */
      writeSftpTextFile: (connectionId: string, remotePath: string, content: string, sudoPassword?: string) => Promise<IPCResult>;

      /**
       * Agent 结构化文件工具（list_dir / read_file / search_files / write_file）。
       * 仅在 Web 端实现；调用方应优先使用此能力，不可用时回退到执行命令。
       */
      runAgentTool?: (
        connectionId: string,
        tool: 'list_dir' | 'read_file' | 'search_files' | 'write_file',
        args?: Record<string, unknown>,
        root?: string,
      ) => Promise<IPCResult<unknown>>;
      /** Agent 工具调用审计（最近 200 条，只读）。Web 优先。 */
      getAgentAudit?: (
        connectionId: string,
      ) => Promise<IPCResult<{ records: Array<{ at: string; tool: string; root?: string; path?: string; write?: boolean }> }>>;
      /** Agent 会话持久化（按连接）。 */
      listAgentConversations?: () => Promise<IPCResult<{ conversations: Array<{ key: string; connectionId: string; messageCount: number; updatedAt: number }> }>>;
      getAgentConversation?: (connectionId: string) => Promise<IPCResult<{ connectionId: string; messages: import('./types').Message[]; updatedAt: number }>>;
      saveAgentConversation?: (connectionId: string, messages: import('./types').Message[]) => Promise<IPCResult<{ connectionId: string; messages: import('./types').Message[]; updatedAt: number }>>;
      deleteAgentConversation?: (connectionId: string) => Promise<IPCResult<{ removed: boolean }>>;
      /** Agent 附件（仅元数据 + 临时文件）。 */
      uploadAgentAttachment?: (input: { name?: string; type: string; dataBase64: string }) => Promise<IPCResult<{ id: string; name: string; type: string; size: number }>>;
      getAgentAttachment?: (attachmentId: string) => Promise<IPCResult<{ id: string; name: string; type: string; size: number }>>;

      /** 服务器监控仪表盘（SSH 采集 /proc + df）。Web 优先；桌面端未实现时按钮隐藏。 */
      getServerMonitor?: (connectionId: string) => Promise<IPCResult<ServerMonitorMetrics>>;
      /** 远程文件搜索（按名/按内容）。Web 优先。 */
      searchSftpFiles?: (
        connectionId: string,
        request: { path: string; query: string; mode: SftpSearchMode; limit?: number },
      ) => Promise<IPCResult<SftpSearchResult>>;
      /** 远程文件预览（图片/PDF，base64）。Web 优先。 */
      previewSftpFile?: (connectionId: string, remotePath: string) => Promise<IPCResult<SftpPreviewResult>>;
      /** 远程音视频流式预览 URL（inline，浏览器 <video>/<audio> 直接引用）。仅 Web 端提供。 */
      getSftpMediaPreviewUrl?: (connectionId: string, remotePath: string) => string;

      agentStartTask: (taskId: string, connectionId: string) => Promise<IPCResult>;
      agentStopTask: (connectionId: string) => Promise<IPCResult>;
      /** 暂停：只掐断指定连接的在途命令；省略 connectionId 时取消本客户端全部在途执行。 */
      agentPauseTask: (connectionId?: string) => Promise<IPCResult>;
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
      /** Web 部署专用：读取 MCP 服务端策略（data/mcp-policy.json）。 */
      mcpGetConfig?: () => Promise<IPCResult<McpConfigSnapshot>>;
      /** Web 部署专用：保存 MCP 服务端策略。 */
      mcpSaveConfig?: (policy: McpPolicyConfig) => Promise<IPCResult<McpConfigSaveResult>>;
      /** Web 部署专用：FSA 流式下载把进度/终态回报给服务端，供重试与列表状态保持一致。 */
      reportSftpDownloadStatus?: (
        taskId: string,
        update: {
          attempt: number;
          status: 'transferring' | 'completed' | 'failed' | 'canceled' | 'skipped';
          transferredBytes?: number;
          totalBytes?: number;
          error?: { code?: string; message?: string; retryable?: boolean };
        },
      ) => Promise<IPCResult>;
    };
    /** Web 部署下由 installWebApi 设置，桌面端为 undefined。 */
    __AISSH_WEB__?: boolean;
  }
}

export {};
