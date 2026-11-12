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
  /** 所属分组（文件夹）id；缺省表示未分组。 */
  groupId?: string;
  /** 自由标签，用于跨分组的筛选与归类。 */
  tags?: string[];
  /** 代理：先经由该代理连到第一跳（有跳板机时是第一台，否则是目标主机）。 */
  proxy?: SshProxyConfig;
  /** 多级跳板机，按顺序逐跳建连；最后一跳之后连到目标主机。 */
  jumpHosts?: SshJumpHost[];
  /** 端口转发规则（本地转发 / 动态 SOCKS5）。 */
  portForwards?: PortForwardRule[];
}

export interface SshProxyConfig {
  type: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface SshJumpHost {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export type PortForwardType = 'local' | 'dynamic';

export interface PortForwardRule {
  id: string;
  type: PortForwardType;
  /** 备注名，便于区分多条规则。 */
  label?: string;
  /** 本地监听地址，默认 127.0.0.1（只监听本机更安全）。 */
  bindHost?: string;
  /** 本地监听端口。 */
  bindPort: number;
  /** local 转发的目标地址（从 SSH 服务器一侧发起连接）。 */
  targetHost?: string;
  /** local 转发的目标端口。 */
  targetPort?: number;
}

// 连接分组（文件夹）。parentId 预留嵌套能力，当前 UI 按平铺分组渲染。
export interface ConnectionGroup {
  id: string;
  name: string;
  parentId?: string;
  order?: number;
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
export interface MessageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 用户消息携带的附件（仅元数据，真实字节在服务端临时文件）。 */
  attachments?: MessageAttachment[];
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
  /**
   * Agent 权限模式（批次四）：ask=全部询问 / auto=自动放行低中风险、高危仍询问 /
   * full=全自动 / readonly=只读。设置后优先生效，未设置时回退旧的三个开关。
   */
  agentPermissionMode?: 'ask' | 'auto' | 'full' | 'readonly';
  /** 每轮拼给模型的上下文预算（字符数），超出部分折叠为摘要。 */
  agentContextBudgetChars?: number;
  maxPersistedSessions?: number;
  maxScrollbackBytesPerSession?: number;
  /** 文件管理面板是否常驻左侧显示（默认关闭，按需从顶栏切换）。 */
  fileManagerPersistent?: boolean;
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
  /** 随本次任务一起提交的附件（元数据）。 */
  attachments?: MessageAttachment[];
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
  /** 上下文预算（字符），超出折叠为摘要；默认 120000。 */
  contextBudgetChars: number;
}

export interface PendingApproval {
  command: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** write_file 等结构化工具审批时携带的原始工具调用。 */
  toolCall?: { id: string; name: string; arguments: string };
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

// ---------------------------------------------------------------------------
// MCP 服务端策略（data/mcp-policy.json）
// ---------------------------------------------------------------------------

/** read-only：只允许列目录/读文件；exec：额外允许 ssh_exec。 */
export type McpPolicyMode = 'read-only' | 'exec';

export interface McpPolicyLimits {
  maxOutputBytes: number;
  execTimeoutMs: number;
  maxCommandChars: number;
  maxReadBytes: number;
}

export interface McpPolicyConfig {
  defaultMode: McpPolicyMode;
  trustOnFirstUse: boolean;
  /** 按连接 id（或唯一名称）覆盖默认模式。 */
  connections: Record<string, McpPolicyMode>;
  commands: {
    /** 追加到内置黑名单的正则（只收紧，不放松）。 */
    deny: string[];
    /** 精确匹配整条命令的例外，用于放行被内置规则拦下但确实需要的命令。 */
    exceptions: string[];
  };
  limits: McpPolicyLimits;
  audit: { enabled: boolean };
}

export interface McpPolicyConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
}

export interface McpConfigSnapshot {
  policy: McpPolicyConfig;
  defaults: McpPolicyConfig;
  /** data/mcp-policy.json 的绝对路径。 */
  path: string;
  exists: boolean;
  connections: McpPolicyConnection[];
  /** 已设置、会覆盖策略文件的环境变量名。 */
  envOverrides: string[];
}

export interface McpConfigSaveResult {
  policy: McpPolicyConfig;
  path: string;
  exists: boolean;
}
