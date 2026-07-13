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

export interface DirectoryListResult<T = any> {
  files: T[];
}

export interface FileDownloadResult {
  localPath: string;
}

export interface FileUploadResult {
  remotePath: string;
}

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
  };
  skipped: importIssue[];
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
