export type IPCResult<T = void> = SuccessResult<T> | ErrorResult;

export type SuccessResult<T = void> = T extends void
  ? {
      success: true;
    }
  : {
      success: true;
      data: T;
    };

export interface ErrorResult {
  success: false;
  error: string;
  code?: string;
}

export function success(): SuccessResult<void>;
export function success<T>(data: T): SuccessResult<T>;
export function success<T = void>(data?: T): SuccessResult<T> {
  if (arguments.length === 0) {
    return { success: true } as SuccessResult<T>;
  }
  return { success: true, data: data as T } as SuccessResult<T>;
}

export function error(err: string, code?: string): ErrorResult {
  return { success: false, error: err, code };
}

export interface SSHConnectResult {
  sessionId: string;
}

export interface SSessionsResult {
  sessions: Array<{
    connectionId: string;
    isConnected: boolean;
    isConnecting: boolean;
    reconnectAttempts: number;
    lastError?: string;
  }>;
}

export interface AIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIChatResponse {
  content: string;
  model?: string;
  finishReason?: string;
  requestId?: string;
  usage?: AIUsage;
}

export interface AIChatResult extends AIChatResponse {}

export type AIChatStreamEvent =
  | { type: 'delta'; requestId: string; delta: string }
  | { type: 'done'; requestId: string; model?: string; finishReason?: string; usage?: AIUsage }
  | { type: 'error'; requestId: string; error: string; code?: string }
  | { type: 'canceled'; requestId: string };

export interface AIChatStreamOptions {
  requestId: string;
  onEvent: (event: AIChatStreamEvent) => void;
}

export interface AIProvidersResult<T = any> {
  providers: T[];
}

export interface ConnectionsResult<T = any> {
  connections: T[];
}

export interface CommandHistoryResult<T = any> {
  history: T[];
}

export interface QuickCommandsResult<T = any> {
  commands: T[];
}

export interface QuickCommandGroupsResult<T = any> {
  groups: T[];
}

export interface SettingsResult<T = any> {
  settings: T;
}

export type SftpItemKind = 'file' | 'directory' | 'symlink' | 'other';

/** 桌面端与 Web 端共享的远端目录条目。 */
export interface SftpItem {
  name: string;
  path: string;
  kind?: SftpItemKind;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;
  mtime: number;
  atime?: number;
  mode?: string;
  /** @deprecated 迁移期兼容旧目录列表。 */
  fileType: string;
}

export interface DirectoryListResult<T = SftpItem> {
  files: T[];
  /** 服务端 realpath 后的当前目录（优先绝对路径） */
  path?: string;
}

/** 本地上传文件引用，ref 用于 Web 端引用暂存文件。 */
export interface SftpLocalFileRef {
  name: string;
  path?: string;
  ref?: string;
  size?: number;
  lastModified?: number;
}

/** 本地下载目录引用，ref 用于 Web 端引用已授权目录。 */
export interface SftpLocalDestinationRef {
  path?: string;
  ref?: string;
  name?: string;
}

export interface SftpFilesSelectionResult {
  canceled: boolean;
  files: SftpLocalFileRef[];
}

export interface SftpDownloadDestinationSelectionResult {
  canceled: boolean;
  destination?: SftpLocalDestinationRef;
}

export type SftpConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';

export type SftpErrorCode =
  | 'connection-unavailable'
  | 'permission-denied'
  | 'not-found'
  | 'already-exists'
  | 'invalid-path'
  | 'io-error'
  | 'conflict'
  | 'canceled'
  | 'source-changed'
  | 'commit-in-progress'
  | 'unsupported'
  | 'unknown';

export type SftpTransferDirection = 'upload' | 'download';

export type SftpTransferStatus =
  | 'queued'
  | 'checking'
  | 'waiting-conflict'
  | 'transferring'
  | 'canceling'
  | 'committing'
  | 'completed'
  | 'skipped'
  | 'canceled'
  | 'interrupted'
  | 'failed'
  | 'handed-off';

export type SftpCommitGuarantee =
  | 'atomic-create'
  | 'atomic-replace'
  | 'best-effort-replace'
  | 'browser-managed'
  | 'none';

export interface SftpTransferError {
  code: SftpErrorCode;
  message: string;
  retryable: boolean;
}

export interface SftpTransferConflict {
  sourcePath: string;
  destinationPath: string;
  existingSize?: number;
  incomingSize?: number;
  suggestedName?: string;
}

/** 跨桌面与 Web 后端共享的传输任务快照。 */
export interface SftpTransferTaskSnapshot {
  taskId: string;
  batchId?: string;
  connectionId: string;
  attempt: number;
  sequence: number;
  direction: SftpTransferDirection;
  status: SftpTransferStatus;
  name: string;
  localPath?: string;
  remotePath?: string;
  totalBytes?: number;
  transferredBytes: number;
  resumedFrom: number;
  progress: number;
  conflictPolicy: SftpConflictPolicy;
  conflict?: SftpTransferConflict;
  error?: SftpTransferError;
  commitGuarantee: SftpCommitGuarantee;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface SftpTransferEventBase {
  taskId: string;
  connectionId: string;
  attempt: number;
  sequence: number;
  timestamp: number;
}

/** 后端推送的有序任务事件。 */
export type SftpTransferEvent =
  | (SftpTransferEventBase & {
      type: 'snapshot';
      snapshot: SftpTransferTaskSnapshot;
    })
  | (SftpTransferEventBase & {
      type: 'progress';
      transferredBytes: number;
      totalBytes?: number;
      progress: number;
    })
  | (SftpTransferEventBase & {
      type: 'conflict';
      conflict: SftpTransferConflict;
    })
  | (SftpTransferEventBase & {
      type: 'terminal';
      status: Extract<SftpTransferStatus, 'completed' | 'skipped' | 'canceled' | 'interrupted' | 'failed' | 'handed-off'>;
      transferredBytes?: number;
      totalBytes?: number;
      progress?: number;
      localPath?: string;
      remotePath?: string;
      error?: SftpTransferError;
      commitGuarantee?: SftpCommitGuarantee;
    });

export interface SftpDeleteItemResult {
  path: string;
  success: boolean;
  error?: string;
  code?: SftpErrorCode;
}

export interface SftpBatchDeleteResult {
  items: SftpDeleteItemResult[];
  deletedCount: number;
  failedCount: number;
}

export interface SftpStartUploadRequest {
  connectionId: string;
  files: SftpLocalFileRef[];
  remoteDirectory: string;
  conflictPolicy?: SftpConflictPolicy;
}

export interface SftpStartDownloadRequest {
  connectionId: string;
  remotePaths: string[];
  destination: SftpLocalDestinationRef;
  conflictPolicy?: SftpConflictPolicy;
}

export interface SftpStartTransferResult {
  tasks: SftpTransferTaskSnapshot[];
}

export interface SftpResolveConflictRequest {
  taskId: string;
  attempt: number;
  policy: Exclude<SftpConflictPolicy, 'ask'>;
  renamedPath?: string;
  /** 将策略应用到同批次尚未提交的剩余任务。 */
  applyToBatch?: boolean;
}

export interface SftpTransferTaskRequest {
  taskId: string;
}

export interface SftpListTransfersResult {
  tasks: SftpTransferTaskSnapshot[];
}

/** @deprecated 旧单文件下载结果，保留至现有界面迁移完成。 */
export interface FileDownloadResult {
  localPath: string;
}

/** @deprecated 旧单文件上传结果，保留至现有界面迁移完成。 */
export interface FileUploadResult {
  remotePath: string;
}

/** @deprecated 旧完成事件，保留至现有桥接迁移完成。 */
export interface SftpTransferCompleteEvent {
  connectionId: string;
  taskId?: string;
  filename: string;
  transferType: 'upload' | 'download';
  success: boolean;
  error?: string;
  localPath?: string;
  remotePath?: string;
}

export interface FileSelectResult {
  canceled: boolean;
  filePath: string;
  fileName: string;
}

export interface PrivateKeyFileResult {
  content: string;
}

export interface importIssue {
  scope: 'root' | 'connection' | 'provider' | 'settings' | 'command-history' | 'quick-command' | 'quick-command-group';
  index?: number;
  id?: string;
  reason: string;
}

export interface importDataResult {
  imported: {
    connections: number;
    aiProviders: number;
    settings: number;
    quickCommands: number;
    quickCommandGroups: number;
    commandHistory?: number;
  };
  skipped: importIssue[];
}

export interface ImportDataResult extends importDataResult {}

export interface ExportDataOptions {
  includeSecrets?: boolean;
}

export interface ImportDataOptions {
  merge?: boolean;
}

/** Full app backup payload (export/import). */
export interface AppBackupData {
  version?: string;
  exportedAt?: number;
  includeSecrets?: boolean;
  encrypted?: boolean;
  salt?: string;
  iv?: string;
  ciphertext?: string;
  connections?: unknown[];
  aiProviders?: unknown[];
  settings?: unknown;
  commandHistory?: unknown[];
  quickCommands?: unknown[];
  quickCommandGroups?: unknown[];
  hostTrustRecords?: unknown[];
}

export interface AIProviderSecretStatusResult {
  providerId: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export interface AgentExecAwaitResult {
  output: string;
  exitCode: number | null;
  reason: 'done' | 'timeout' | 'canceled' | 'closed';
}

export interface AgentTaskHistoryResult<T = any> {
  tasks: T[];
}

export interface ExportDataResult<T = any> {
  data: T;
}
