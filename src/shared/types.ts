// SSH 连接配置
export interface SSHConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface HostTrustRecord {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  trustedAt: number;
}

export type HostTrustPromptKind = 'firstConnect' | 'keyChanged';

export interface HostTrustPromptEvent {
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  kind: HostTrustPromptKind;
  previousAlgorithm?: string;
  previousFingerprint?: string;
}

export type AIProviderType = 'openai' | 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';

// AI 供应商配置
export interface AIProviderConfig {
  id: string;
  name: string;
  type: AIProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  isActive: boolean;
}

export interface AIProviderSecretInput {
  providerId: string;
  apiKey: string;
}

export interface AIProviderSummary extends Omit<AIProviderConfig, 'apiKey'> {
  hasApiKey: boolean;
  maskedApiKey?: string;
}

// 聊天消息
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// 命令建议
export interface CommandSuggestion {
  command: string;
  description: string;
  isDangerous: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskDescription?: string;
  /** 是否只读命令（不修改远端状态）；只读模式下只有这类命令可执行。 */
  readOnly?: boolean;
}

// 命令历史记录
export interface CommandHistoryItem {
  id: string;
  command: string;
  timestamp: number;
  connectionId: string;
  connectionName: string;
  host?: string;
  username?: string;
  executedBy: 'user' | 'ai';
  approved: boolean;
  cwd?: string; // 命令执行时的工作目录
}

export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface Session {
  id: string;
  connectionId: string;
  title: string;
  state: SessionStatus;
  isPinned?: boolean;
  scrollbackKey?: string;
  reconnectAttempts: number;
  lastActiveAt: number;
  lastError?: string;
  cwd?: string;
  restoredFromScrollback?: boolean;
}

export interface SessionScrollbackSnapshot {
  sessionId: string;
  connectionId: string;
  updatedAt: number;
  cwd?: string;
  content: string;
  title?: string;
}

export interface SessionPersistenceSettings {
  maxPersistedSessions: number;
  maxScrollbackBytesPerSession: number;
}

export interface CommandHistoryIndex {
  host: string;
  username: string;
  cwd: string;
  commands: CommandHistoryItem[];
}

// 快速命令分组
export interface QuickCommandGroup {
  id: string;
  name: string;
  color?: string;
}

// 快速命令
export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
  groupId?: string;
}

// IPC 消息
export interface IPCMessage {
  type: string;
  payload?: any;
}

// SSH 会话状态
export interface SSHSessionState {
  connectionId: string;
  isConnected: boolean;
  isConnecting: boolean;
  reconnectAttempts: number;
  lastError?: string;
}

// 应用设置
export interface AppSettings {
  language: string;
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  fontFamily: string;
  keepaliveInterval: number;
  keepaliveCountMax: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  approveHighRisk?: boolean;
  approveMediumRisk?: boolean;
  rememberChoice?: boolean;
  showTerminalOutputPrompt?: boolean;
  terminalTheme?: string;
  /** xterm scrollback 行数 */
  terminalScrollback?: number;
  /** 光标样式：block / underline / bar */
  terminalCursorStyle?: 'block' | 'underline' | 'bar';
  /** 光标是否闪烁 */
  terminalCursorBlink?: boolean;
  /** 选中即复制 */
  terminalCopyOnSelect?: boolean;
  /** 客户端识别 Shell Integration OSC 序列 */
  terminalShellIntegration?: boolean;
  agentEnabled?: boolean;
  agentSemanticSummaryContextLength?: number;
  /** 只读模式：Agent 只允许执行不改动远端状态的命令。 */
  agentReadOnlyMode?: boolean;
  maxPersistedSessions?: number;
  maxScrollbackBytesPerSession?: number;
}

// SFTP 文件信息
export interface SFTPFileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: string;
  mtime: number;
  atime: number;
}

export type AgentState = 'idle' | 'thinking' | 'planning' | 'executing' | 'observing' | 'paused' | 'finished' | 'error';

export type ThinkingStepType = 'understanding' | 'planning' | 'command_generation' | 'execution' | 'observation' | 'decision' | 'complete';

export interface ThinkingStep {
  id: string;
  type: ThinkingStepType;
  title: string;
  content: string;
  timestamp: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface AgentExecution {
  id: string;
  stepId: string;
  command: string;
  output: string;
  timestamp: number;
  success: boolean;
  /** 哨兵捕获到的远端退出码；null 表示未捕获（超时/断线/仅按提示符判定结束）。 */
  exitCode?: number | null;
  /** 命令下发时刻（本地时间），用于计算真实执行耗时。 */
  startedAt?: number;
  /** 命令结束时刻（本地时间）。 */
  completedAt?: number;
}

export interface AgentTask {
  id: string;
  conversationId?: string;
  /** 发起任务时绑定的 SSH 会话；终端内对话输出只投影到该会话。 */
  connectionId?: string;
  userInput: string;
  state: AgentState;
  thinkingSteps: ThinkingStep[];
  executions: AgentExecution[];
  startTime: number;
  endTime?: number;
  error?: string;
  finishReason?: string;
  /** 本任务累计消耗的 token（provider 返回 usage 时才统计）。 */
  tokenUsage?: number;
}

export interface AgentConfig {
  enabled: boolean;
  semanticSummaryContextLength: number;
  approveHighRisk: boolean;
  approveMediumRisk: boolean;
  /** 只读模式：非只读命令一律不执行，并把原因回给模型换方案。 */
  readOnlyMode: boolean;
}

export interface PendingApproval {
  command: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export type AgentDecision = 'execute' | 'finish' | 'ask';

export interface AgentThought {
  reasoning: string;
  observation?: string;
}

export interface AgentResponse {
  thought: AgentThought;
  decision: AgentDecision;
  command?: string;
  finishReason?: string;
  question?: string;
}
