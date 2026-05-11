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
}

// 命令历史记录
export interface CommandHistoryItem {
  id: string;
  command: string;
  timestamp: number;
  connectionId: string;
  connectionName: string;
  executedBy: 'user' | 'ai';
  approved: boolean;
  cwd?: string; // 命令执行时的工作目录
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
  connectionNotifications?: boolean;
  commandNotifications?: boolean;
  showTerminalOutputPrompt?: boolean;
  terminalTheme?: string;
  agentEnabled?: boolean;
  agentAutoExecute?: boolean;
  agentMaxExecutionSteps?: number;
  agentMaxContextMessages?: number;
  agentMaxTerminalOutputLength?: number;
  agentTrimContextEnabled?: boolean;
  agentTaskContextRounds?: number;
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

export type AgentMode = 'agent';

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
}

export interface AgentTask {
  id: string;
  userInput: string;
  state: AgentState;
  thinkingSteps: ThinkingStep[];
  executions: AgentExecution[];
  startTime: number;
  endTime?: number;
  error?: string;
  finishReason?: string;
}

export interface AgentConfig {
  enabled: boolean;
  autoExecute: boolean;
  maxExecutionSteps: number;
  requireApprovalForRisk: boolean;
  approveHighRisk: boolean;
  approveMediumRisk: boolean;
  maxContextMessages: number;
  trimContextEnabled: boolean;
  maxTerminalOutputLength: number;
  taskContextRounds: number;
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
  needsMoreContext?: boolean;
}
