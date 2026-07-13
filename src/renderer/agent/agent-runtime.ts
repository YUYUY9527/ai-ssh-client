import { AGENT_SYSTEM_PROMPT } from '../../shared/constants';
import { t } from '../i18n';
import type {
  AgentGraphAction,
  AgentRoundGraphResult,
} from './langgraph-agent-flow';
import type {
  AgentConfig,
  AgentResponse,
  AgentState,
  AgentTask,
  CommandSuggestion,
  Message,
  PendingApproval,
  ThinkingStep,
} from '../../shared/types';
import type {
  IPCResult,
  AIChatResult,
  AIChatStreamEvent,
  AIChatStreamOptions,
  AgentExecAwaitResult,
} from '../../shared/ipc-types';

// ==========================================================================
// Types
// ==========================================================================

export interface AgentRuntimeSnapshot {
  currentTask: AgentTask | null;
  agentState: AgentState;
  config: AgentConfig;
  pendingApproval: PendingApproval | null;
  approvalResult: 'approved' | 'rejected' | null;
  pendingQuestion: string | null;
  pendingInput: string | null;
  taskHistory: AgentTask[];
  activeConversationId: string;
  activeProviderId: string | null;
  activeConnectionId: string | null;
  providers: Array<{ id: string }>;
}

export interface AgentRuntimeActions {
  setAgentState: (state: AgentState) => void;
  addThinkingStep: (step: ThinkingStep) => void;
  updateThinkingStep: (stepId: string, updates: Partial<ThinkingStep>) => void;
  completeTask: (success: boolean, error?: string, finishReason?: string) => void;
  setPendingApproval: (approval: PendingApproval | null, resetResult?: boolean) => void;
  setApprovalResult: (result: 'approved' | 'rejected' | null) => void;
  setPendingQuestion: (question: string | null) => void;
  setPendingInput: (input: string | null) => void;
  setPendingTerminalPrompt: (prompt: string | null) => void;
  trimAgentContext: () => void;
}

export interface AgentRuntimeServices {
  analyzeCommand: (command: string) => CommandSuggestion;
  aiChat: (
    providerId: string,
    messages: Message[],
    options?: { requestId?: string },
  ) => Promise<IPCResult<AIChatResult>>;
  aiChatStream: (
    providerId: string,
    messages: Message[],
    options: AIChatStreamOptions,
  ) => Promise<IPCResult<AIChatResult>>;
  cancelAIChat?: (requestId: string) => Promise<IPCResult> | void;
  agentStartTask?: (taskId: string, connectionId: string) => Promise<IPCResult>;
  agentStopTask?: (connectionId: string) => Promise<IPCResult>;
  agentExecAwait?: (
    connectionId: string,
    command: string,
    options?: { runId?: string; timeoutMs?: number },
  ) => Promise<IPCResult<AgentExecAwaitResult>>;
  agentCancelExec?: (connectionId: string) => Promise<IPCResult> | void;
  onAgentTerminalOutput?: (callback: (data: { connectionId: string; data: string }) => void) => () => void;
  notifyTaskCompletion?: (success: boolean, reason: string) => Promise<void>;
}

type RuntimeStatus =
  | 'idle'
  | 'initializing'
  | 'thinking'
  | 'awaitingApproval'
  | 'awaitingQuestion'
  | 'executing'
  | 'waitingForUnblock'
  | 'paused'
  | 'completed'
  | 'failed';

type RuntimeRiskLevel = 'low' | 'medium' | 'high' | 'critical';

type AgentRoundExecutionHooks = {
  beforeExecute: (action: Extract<AgentGraphAction, { type: 'execute' }>) => void;
  execute: (command: string) => Promise<string>;
  summarizeOutput: (command: string, output: string) => string;
  buildNextDecisionContext: (command: string, output: string) => string;
};

// ==========================================================================
// Tunables
// ==========================================================================

const DUPLICATE_COMMAND_COOLDOWN_MS = 8000;
const MAX_LOCAL_AGENT_OUTPUT_SIZE = 256 * 1024;
const UNBLOCK_POLL_INTERVAL_MS = 500;

// ==========================================================================
// Pure helpers
// ==========================================================================

export const extractKeyOutput = (output: string, maxLength: number): string => {
  if (output.length <= maxLength) return output;

  const lines = output.split('\n');
  const keyLines: string[] = [];
  let currentLength = 0;

  const errorPatterns = [
    /error/i, /failed/i, /exception/i, /warning/i, /fatal/i,
    /denied/i, /permission/i, /not found/i, /cannot/i, /unable/i,
  ];
  const importantPatterns = [/\[.*\]/, /^-{3,}/, /^={3,}/, /^\s*\d+/];

  for (const line of lines) {
    if (currentLength + line.length > maxLength * 0.7) break;
    const isError = errorPatterns.some(p => p.test(line));
    const isImportant = importantPatterns.some(p => p.test(line));
    if (isError || isImportant) {
      keyLines.push(line);
      currentLength += line.length + 1;
    }
  }

  const lastLines = lines.slice(-20);
  const result = [...new Set([...keyLines, ...lastLines])].join('\n');

  return result.length > maxLength ? '...\n' + result.slice(-maxLength + 10) : result;
};

const stripAnsi = (text: string): string => text
  .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
  .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

const normalizeTerminalText = (text: string): string => stripAnsi(text)
  .replace(/\r/g, '\n')
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n');

export const parseAgentResponse = (content: string): AgentResponse | null => {
  let cleanContent = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if ((cleanContent.startsWith('"') && cleanContent.endsWith('"')) ||
      (cleanContent.startsWith("'") && cleanContent.endsWith("'"))) {
    cleanContent = cleanContent.slice(1, -1);
  }

  // 1. 直接 JSON 解析
  try {
    const parsed = JSON.parse(cleanContent);
    if (typeof parsed === 'string') {
      return parseAgentResponse(parsed);
    }
    const response = normalizeAgentResponse(parsed);
    if (response) return response;
  } catch (e) {}

  // 2. 从 markdown 代码块中提取
  const patterns = [/```(?:json)?\s*([\s\S]*?)\s*```/, /`([\s\S]*?)`/];
  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const response = normalizeAgentResponse(parsed);
        if (response) return response;
      } catch (e) {}
    }
  }

  // 3. 提取第一个 { 到最后一个 } 之间的内容
  const firstBrace = cleanContent.indexOf('{');
  const lastBrace = cleanContent.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    const jsonCandidate = cleanContent.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      const response = normalizeAgentResponse(parsed);
      if (response) return response;
    } catch (e) {}

    // 4. 尝试修复常见的 JSON 格式问题
    const fixed = fixMalformedJson(jsonCandidate);
    if (fixed) {
      try {
        const parsed = JSON.parse(fixed);
        const response = normalizeAgentResponse(parsed);
        if (response) return response;
      } catch (e) {}
    }
  }

  // 5. 尝试从纯文本中推断意图（最后的兜底）
  return inferResponseFromText(cleanContent);
};

function normalizeAgentResponse(value: unknown): AgentResponse | null {
  if (!value || typeof value !== 'object') return null;

  const parsed = value as Partial<AgentResponse> & {
    thought?: AgentResponse['thought'] | string;
    reasoning?: string;
    observation?: string;
  };
  if (!parsed.decision || !['execute', 'finish', 'ask'].includes(parsed.decision)) {
    return null;
  }

  const fallbackReason = parsed.finishReason
    || parsed.question
    || parsed.command
    || parsed.reasoning
    || '';
  const thought = typeof parsed.thought === 'string'
    ? { reasoning: parsed.thought, observation: parsed.observation || '' }
    : {
      reasoning: parsed.thought?.reasoning || fallbackReason,
      observation: parsed.thought?.observation || parsed.observation || '',
    };

  return {
    ...parsed,
    thought,
    decision: parsed.decision,
  };
}

/**
 * 修复常见的 JSON 格式问题
 */
function fixMalformedJson(json: string): string | null {
  let fixed = json;

  // 移除尾部逗号 (如 `"key": "value",}`)
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // 修复未转义的换行符在字符串值中
  fixed = fixed.replace(/"([^"]*?)(?<!\\)\n([^"]*?)"/g, (_, before, after) => {
    return `"${before}\\n${after}"`;
  });

  // 修复单引号 → 双引号 (仅在 key 位置)
  fixed = fixed.replace(/'/g, '"');

  // 如果修复后和原始一样，返回 null 避免重复尝试
  if (fixed === json) return null;
  return fixed;
}

/**
 * 从纯文本中推断 AI 的意图（兜底策略）
 * 当 AI 没有返回有效 JSON 时，尝试从文本中提取有用信息
 */
function inferResponseFromText(text: string): AgentResponse | null {
  const directCommandPatterns = [
    /(?:执行|运行|使用|先执行|需要执行)(?:命令)?[：:]\s*[`"]?([^`"\n]+)[`"]?/,
    /(?:command|execute|run)[：:]\s*[`"]?([^`"\n]+)[`"]?/i,
  ];
  for (const pattern of directCommandPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return {
        thought: { reasoning: text.slice(0, 200), observation: '' },
        decision: 'execute',
        command: match[1].trim(),
      };
    }
  }

  // 如果文本看起来像截断的 JSON，不要推断 — 返回 null 让上层处理
  if (text.includes('"thought"') || text.includes('"decision"') || text.includes('"reasoning"')) {
    return null;
  }

  const lower = text.toLowerCase();

  // 检测是否包含命令执行意图
  const cmdPatterns = [
    /(?:执行|运行|使用)(?:命令)?[：:]\s*[`"]?([^`"\n]+)[`"]?/,
    /(?:command|execute|run)[：:]\s*[`"]?([^`"\n]+)[`"]?/i,
    /^[`]([^`\n]+)[`]\s*$/m,
  ];
  for (const pattern of cmdPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return {
        thought: { reasoning: text.slice(0, 200), observation: '' },
        decision: 'execute',
        command: match[1].trim(),
      };
    }
  }

  // 检测是否是完成意图 — 要求更明确的表述
  if (/^(?:任务完成|已完成|done|completed|finished)[。.!]?\s*$/im.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 200), observation: '' },
      decision: 'finish',
      finishReason: text.slice(0, 100),
    };
  }

  const looksLikeConclusion = /(当前|系统|cpu|内存|负载|load average|memory|usage|状态|结果)[\s\S]{0,120}(正常|较低|良好|健康|无异常|没有异常|未发现异常|完成|达成)/i
    .test(text);
  if (looksLikeConclusion || /(no further action|nothing else is needed|looks normal)/i.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 300), observation: text.slice(0, 300) },
      decision: 'finish',
      finishReason: text.slice(0, 300),
    };
  }

  const looksLikeCollectedResult = (
    /(?:已|已经|成功)?(?:查看|看到|获取|获得|采集|检查|确认|分析)(?:到|了)?/i.test(text)
    && /(cpu|利用率|负载|load average|内存|memory|mem|swap|tasks|进程|状态)/i.test(text)
  );
  if (looksLikeCollectedResult || /(i have|i've|successfully).*(checked|collected|found|observed)/i.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 300), observation: text.slice(0, 300) },
      decision: 'finish',
      finishReason: text.slice(0, 300),
    };
  }

  // 检测是否是提问意图
  if (/(?:请问|请确认|需要.*确认|你想|是否)[^。]*[?？]\s*$/m.test(text)) {
    return {
      thought: { reasoning: '需要用户确认', observation: '' },
      decision: 'ask',
      question: text.slice(0, 300),
    };
  }

  return null;
}

const detectTerminalBlocking = (output: string): { isBlocking: boolean; prompt: string } => {
  const normalizedOutput = normalizeTerminalText(output);
  const lastLines = normalizedOutput.split('\n').slice(-5).join('\n').toLowerCase();
  const blockingPatterns: Array<{ pattern: RegExp; prompt: string }> = [
    { pattern: /\[y\/n\]/i, prompt: 'Y/N 确认' },
    { pattern: /\[y\]/i, prompt: 'Y 确认' },
    { pattern: /yes\/no/i, prompt: 'Yes/No 确认' },
    { pattern: /\(yes\/no\)/i, prompt: 'Yes/No 确认' },
    { pattern: /\(y\/n\)/i, prompt: 'Y/N 确认' },
    { pattern: /remove regular file.*[?？]/i, prompt: 'rm 删除确认' },
    { pattern: /remove directory.*[?？]/i, prompt: 'rm 目录删除确认' },
    { pattern: /overwrite .*[\?:：]?\s*$/i, prompt: '覆盖确认' },
    { pattern: /是否删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否删除(?:普通|常规)?文件.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /确认删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /确认覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /是否继续.*[?？]/i, prompt: '继续确认' },
    { pattern: /password:\s*$/i, prompt: '密码输入' },
    { pattern: /passphrase\s*(for|:)/i, prompt: '密钥密码' },
    { pattern: /enter passphrase/i, prompt: '密钥密码' },
    { pattern: /sudo.*password/i, prompt: 'sudo 密码' },
    { pattern: /continue\?/i, prompt: '继续确认' },
    { pattern: /proceed\?/i, prompt: '继续确认' },
    { pattern: /do you want/i, prompt: '操作确认' },
    { pattern: /are you sure/i, prompt: '操作确认' },
    { pattern: /confirm\s*\??/i, prompt: '操作确认' },
    { pattern: /apt.*\[y\/i\/n\]/i, prompt: 'apt 交互确认' },
    { pattern: /yum.*\[y\/n\]/i, prompt: 'yum 交互确认' },
    { pattern: /dnf.*\[y\/n\]/i, prompt: 'dnf 交互确认' },
    { pattern: /do you want to continue\?/i, prompt: '包管理器确认' },
    { pattern: /are you sure you want to continue connecting/i, prompt: 'SSH 首次连接确认' },
    { pattern: /fingerprint.*yes\/no/i, prompt: 'SSH 指纹确认' },
    { pattern: /:\s*$/m, prompt: '分页器等待' },
    { pattern: /--more--/i, prompt: '分页器等待' },
    { pattern: /\(end\)/i, prompt: '分页器结束' },
    { pattern: /vim.*\:$/m, prompt: 'Vim 编辑器等待' },
    { pattern: /nano.*\^G/i, prompt: 'Nano 编辑器等待' },
  ];

  for (const { pattern, prompt } of blockingPatterns) {
    if (pattern.test(lastLines)) {
      return { isBlocking: true, prompt };
    }
  }

  return { isBlocking: false, prompt: '' };
};

const hasShellPrompt = (output: string): boolean => {
  const normalizedTail = normalizeTerminalText(output).slice(-4096);
  const tail = normalizedTail.split('\n').slice(-8).join('\n').trimEnd();
  const promptPatterns = [
    /\]\s*#\s*$/m,
    /\]\s*\$\s*$/m,
    /\w+@[\w.-]+:\S+#\s*$/m,
    /\w+@[\w.-]+:\S+\$\s*$/m,
    /\[[^\]]+@[^\]]+\][#$]\s*$/m,
    /\[[^\]\n]{1,120}@[^\]\n]{1,120}\][#$]/m,
    /\[[^\]\n]{1,120}@[^\]\n]{1,120}\s+[^\]\n]{0,120}\][#$]/m,
    /(?:^|\n)[^\n]{0,80}[#$]\s*$/m,
  ];

  return promptPatterns.some((pattern) => pattern.test(tail))
    || promptPatterns.some((pattern) => pattern.test(normalizedTail.trimEnd()));
};

const isLikelyLongRunningCommand = (command: string): boolean => {
  const normalized = command.toLowerCase();
  const patterns = [
    /\bgit\s+clone\b/,
    /\bnpm\s+(install|ci|update)\b/,
    /\byarn\s+(install|add|upgrade)\b/,
    /\bpnpm\s+(install|add|update)\b/,
    /\bbun\s+install\b/,
    /\bpip(?:3)?\s+install\b/,
    /\buv\s+(pip\s+install|sync)\b/,
    /\bpoetry\s+install\b/,
    /\bcomposer\s+install\b/,
    /\bcargo\s+(build|install|check|test)\b/,
    /\bgo\s+(build|test|get|install)\b/,
    /\bapt(-get)?\s+(install|upgrade|update)\b/,
    /\byum\s+(install|update)\b/,
    /\bdnf\s+(install|update|upgrade)\b/,
    /\bpacman\s+-S\b/,
    /\bbrew\s+(install|upgrade|update)\b/,
    /\b(make|cmake|gradle|mvn|docker\s+build)\b/,
    /\b(wget|curl)\b/,
    /\bscp\b/,
    /\brsync\b/,
    /\bfind\s+\/\b/,
    /\bfind\s+\S+\s+.*(-name|-type|-exec|-size|-mtime|-ctime|-atime)\b/,
    /\bgrep\s+.*\s+\/\b/,
    /\bgrep\s+.*\s+(-r|-R|--recursive)\b/,
    /\bdu\s+.*\s+\/\b/,
    /\bjournalctl\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

const shouldWaitForShellPrompt = (command: string): boolean => {
  const normalized = command.toLowerCase();
  const patterns = [
    /\bfind\s+\/\b/,
    /\bfind\s+\S+\s+.*(-name|-type|-exec|-size|-mtime|-ctime|-atime)\b/,
    /\bgrep\s+.*\s+\/\b/,
    /\bgrep\s+.*\s+(-r|-R|--recursive)\b/,
    /\bdu\s+.*\s+\/\b/,
    /\bjournalctl\b/,
    /\btail\s+-f\b/,
    /\btop\b/,
    /\bhtop\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, ' ');

const isSafeRepeatableCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command).toLowerCase();
  const patterns = [
    /^(ls|ll)\b/, /^pwd$/, /^whoami$/, /^id$/, /^stat\b/, /^test\b/,
    /^find\b/, /^cat\b/, /^head\b/, /^tail\b/, /^grep\b/, /^du\b/, /^df\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
};

const appendTail = (current: string, chunk: string, maxSize: number): string => {
  if (!chunk) return current;
  const next = current + chunk;
  if (next.length <= maxSize) return next;
  return next.slice(-Math.floor(maxSize * 0.75));
};

type JsonObjectContext = {
  path: string[];
  key: string | null;
  mode: 'key' | 'colon' | 'value' | 'comma';
};

function decodePartialJsonString(source: string, start: number): {
  value: string;
  end: number;
  complete: boolean;
} {
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      return { value, end: index + 1, complete: true };
    }
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) break;
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped === 'u') {
      const digits = source.slice(index + 2, index + 6);
      if (digits.length < 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) break;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 6;
      continue;
    }
    value += escapes[escaped] ?? escaped;
    index += 2;
  }

  return { value, end: source.length, complete: false };
}

function formatAgentResponseProjection(response: AgentResponse): string {
  return [
    response.thought.reasoning,
    response.thought.observation
      ? `观察：${response.thought.observation}`
      : '',
    response.finishReason
      ? `结论：${response.finishReason}`
      : '',
  ].filter(Boolean).join('\n\n');
}

export function extractAgentStreamProjection(source: string): string {
  const firstObject = source.indexOf('{');
  if (firstObject < 0) return '';

  const stack: JsonObjectContext[] = [];
  const values = new Map<string, string>();
  let index = firstObject;

  while (index < source.length) {
    const context = stack[stack.length - 1];
    const char = source[index];

    if (char === '{') {
      const path = context?.mode === 'value' && context.key
        ? [...context.path, context.key]
        : [];
      if (context?.mode === 'value') context.mode = 'comma';
      stack.push({ path, key: null, mode: 'key' });
      index += 1;
      continue;
    }
    if (char === '}') {
      stack.pop();
      index += 1;
      continue;
    }
    if (!context) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const token = decodePartialJsonString(source, index);
      if (context.mode === 'key') {
        if (token.complete) {
          context.key = token.value;
          context.mode = 'colon';
        }
      } else if (context.mode === 'value' && context.key) {
        const fieldPath = [...context.path, context.key].join('.');
        if (
          fieldPath === 'thought.reasoning'
          || fieldPath === 'thought.observation'
          || fieldPath === 'finishReason'
        ) {
          values.set(fieldPath, token.value);
        }
        if (token.complete) context.mode = 'comma';
      }
      index = token.end;
      continue;
    }
    if (char === ':' && context.mode === 'colon') {
      context.mode = 'value';
    } else if (char === ',' && context.mode === 'comma') {
      context.key = null;
      context.mode = 'key';
    } else if (context.mode === 'value' && !/\s/.test(char)) {
      context.mode = 'comma';
    }
    index += 1;
  }

  return [
    values.get('thought.reasoning'),
    values.get('thought.observation')
      ? `观察：${values.get('thought.observation')}`
      : '',
    values.get('finishReason')
      ? `结论：${values.get('finishReason')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

// ==========================================================================
// Cancellable sleep helper
// ==========================================================================

interface CancelToken {
  cancelled: boolean;
  reason?: string;
  onCancel: Array<() => void>;
}

function createCancelToken(): CancelToken {
  return { cancelled: false, onCancel: [] };
}

function triggerCancel(token: CancelToken, reason: string) {
  if (token.cancelled) return;
  token.cancelled = true;
  token.reason = reason;
  for (const cb of token.onCancel.splice(0)) {
    try { cb(); } catch { /* ignore */ }
  }
}

class AbortedByRuntimeError extends Error {
  constructor(readonly reason: string) {
    super(`agent aborted: ${reason}`);
    this.name = 'AbortedByRuntimeError';
  }
}

type ActiveStreamDisplay = {
  requestId: string;
  taskVersion: number;
  stepId: string;
  content: string;
  projectedContent: string;
  frameId: number | null;
};

// ==========================================================================
// Runtime
// ==========================================================================

export class AgentRuntime {
  private snapshot: AgentRuntimeSnapshot;
  private status: RuntimeStatus = 'idle';

  // Terminal output buffers
  private cleanupTerminalOutput?: () => void;
  private terminalOutput = '';
  private localFullOutput = '';

  // Task-scoped state
  private taskVersion = 0;
  private initializedTaskId: string | null = null;
  private taskConnectionId: string | null = null;
  private stepCount = 0;
  private stepIdCounter = 0;
  private lastCommandOutput = '';
  private lastParseRetried = false;
  private agentMessages: Message[] = [];
  private commandExecutionHistory = new Map<string, number>();

  // In-flight async work
  private currentAiRequestId: string | null = null;
  private activeStreamDisplay: ActiveStreamDisplay | null = null;
  private currentCancelToken: CancelToken | null = null;
  private processScheduled = false;
  private isProcessingStep = false;

  // Edge-detection memory for store-driven events
  private seenApprovalResult: 'approved' | 'rejected' | null = null;
  private seenPendingInput: string | null = null;

  constructor(
    snapshot: AgentRuntimeSnapshot,
    private readonly actions: AgentRuntimeActions,
    private readonly services: AgentRuntimeServices,
  ) {
    this.snapshot = snapshot;
  }

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  start() {
    this.cleanupTerminalOutput = this.services.onAgentTerminalOutput?.((data) => {
      if (data.connectionId === this.taskConnectionId) {
        this.localFullOutput = appendTail(this.localFullOutput, data.data, MAX_LOCAL_AGENT_OUTPUT_SIZE);
        this.terminalOutput = this.localFullOutput;
      }
    });
  }

  dispose() {
    this.cleanupTerminalOutput?.();
    this.cleanupTerminalOutput = undefined;
    this.abortActiveWork('dispose');
    this.stopAgentTaskBridge();
    this.taskConnectionId = null;
    this.status = 'idle';
  }

  sync(snapshot: AgentRuntimeSnapshot) {
    const prev = this.snapshot;
    this.snapshot = snapshot;

    // 1. 新任务检测
    const task = snapshot.currentTask;
    if (task && this.initializedTaskId !== task.id && snapshot.agentState === 'thinking') {
      this.beginNewTask(task.id, snapshot.activeConnectionId);
    }

    // 2. 外部取消/完成检测(cancelTask 直接把 state 改成 finished)
    const externallyDone = snapshot.agentState === 'finished' || snapshot.agentState === 'error';
    const runtimeActive = this.status !== 'idle'
      && this.status !== 'completed'
      && this.status !== 'failed';
    if (externallyDone && runtimeActive && this.initializedTaskId === task?.id) {
      this.abortActiveWork('external cancel');
      this.status = snapshot.agentState === 'finished' ? 'completed' : 'failed';
      this.stopAgentTaskBridge();
    }

    // 3. 暂停 / 继续
    if (snapshot.agentState === 'paused' && this.status !== 'paused' && runtimeActive) {
      this.applyPause();
    } else if (
      prev.agentState === 'paused'
      && snapshot.agentState !== 'paused'
      && this.status === 'paused'
    ) {
      this.applyResume();
    }

    // 4. 审批结果(只在"从无到有"的那一刻响应一次)
    if (snapshot.approvalResult && snapshot.pendingApproval && this.seenApprovalResult !== snapshot.approvalResult) {
      this.seenApprovalResult = snapshot.approvalResult;
      this.applyApprovalDecision(snapshot.pendingApproval, snapshot.approvalResult);
    } else if (!snapshot.approvalResult) {
      this.seenApprovalResult = null;
    }

    // 5. 用户回答 pendingQuestion
    if (snapshot.pendingQuestion && snapshot.pendingInput && this.seenPendingInput !== snapshot.pendingInput) {
      this.seenPendingInput = snapshot.pendingInput;
      this.applyUserAnswer(snapshot.pendingInput);
    } else if (!snapshot.pendingInput) {
      this.seenPendingInput = null;
    }

    this.scheduleProcess();
  }

  // --------------------------------------------------------------------
  // State machine driver
  // --------------------------------------------------------------------

  private scheduleProcess() {
    if (this.processScheduled) return;
    this.processScheduled = true;
    window.setTimeout(() => {
      this.processScheduled = false;
      void this.process();
    }, 0);
  }

  private async process() {
    if (this.isProcessingStep) {
      return;
    }
    if (this.status !== 'idle') return;
    const task = this.snapshot.currentTask;
    if (!task || this.initializedTaskId !== task.id) return;
    if (this.snapshot.agentState !== 'thinking') return;

    this.isProcessingStep = true;
    try {
      await this.runStepGraph();
    } finally {
      this.isProcessingStep = false;
    }
  }

  // --------------------------------------------------------------------
  // Task bootstrap
  // --------------------------------------------------------------------

  private beginNewTask(taskId: string, connectionId: string | null) {
    this.abortActiveWork('new task');
    this.stopAgentTaskBridge();

    this.initializedTaskId = taskId;
    this.taskConnectionId = connectionId;
    this.taskVersion += 1;
    this.stepCount = 0;
    this.lastCommandOutput = '';
    this.terminalOutput = '';
    this.localFullOutput = '';
    this.agentMessages = [];
    this.commandExecutionHistory.clear();
    this.seenApprovalResult = null;
    this.seenPendingInput = null;
    this.status = 'initializing';

    const capturedVersion = this.taskVersion;
    const bridgeStart = this.services.agentStartTask && connectionId
      ? this.services.agentStartTask(taskId, connectionId).catch(() => undefined)
      : Promise.resolve();

    void bridgeStart.then(() => {
      if (!this.isCurrent(capturedVersion)) return;
      this.status = 'idle';
      this.scheduleProcess();
    });
  }

  // --------------------------------------------------------------------
  // Thinking loop
  // --------------------------------------------------------------------

  private async runStepGraph() {
    const task = this.snapshot.currentTask;
    if (!task) return;
    const capturedVersion = this.taskVersion;

    if (this.stepCount >= (this.snapshot.config.maxExecutionSteps || 20)) {
      this.finishTask(false, t('agent.finishReasons.maxSteps'));
      return;
    }

    this.status = 'thinking';
    this.actions.setAgentState('thinking');
    this.stepCount += 1;
    const thinkStepId = this.generateStepId();
    this.actions.addThinkingStep({
      id: thinkStepId,
      type: 'understanding',
      title: t('agent.thinking.stepAnalysis', { step: this.stepCount }),
      content: t('agent.thinking.analyzing'),
      timestamp: Date.now(),
      status: 'in_progress',
    });

    let execStepId: string | null = null;
    let graphResult: AgentRoundGraphResult;
    try {
      const executionHooks = this.createRoundExecutionHooks({
        capturedVersion,
        thinkStepId,
        setExecStepId: (stepId) => {
          execStepId = stepId;
        },
      });
      graphResult = await this.callAgentRound(
        task.userInput,
        this.lastCommandOutput,
        capturedVersion,
        thinkStepId,
        executionHooks,
      );
    } catch (error) {
      if (error instanceof AbortedByRuntimeError) {
        return;
      }
      const message = error instanceof Error ? error.message : t('aiErrors.defaultError');
      this.actions.updateThinkingStep(thinkStepId, {
        status: 'failed',
        content: t('agent.thinking.aiRequestFailed', { error: message }),
      });
      if (!this.isCurrent(capturedVersion)) return;
      this.finishTask(false, t('agent.finishReasons.aiFailed'));
      return;
    }

    if (!this.isCurrent(capturedVersion)) return;

    if (graphResult.nextAction.type === 'retryParse') {
      if (!this.lastParseRetried) {
        this.lastParseRetried = true;
        this.actions.updateThinkingStep(thinkStepId, {
          status: 'in_progress',
          content: t('agent.thinking.analyzing'),
        });
        this.agentMessages.push({
          id: Date.now().toString(),
          role: 'user',
          content: '你的上一次回复格式不正确，无法解析。请严格按照纯 JSON 格式回复：{"thought":{"reasoning":"...","observation":"..."},"decision":"execute|finish|ask","command":"..."}',
          timestamp: Date.now(),
        });
        this.status = 'idle';
        this.actions.setAgentState('thinking');
        this.scheduleProcess();
        return;
      }

      this.lastParseRetried = false;
      this.actions.updateThinkingStep(thinkStepId, {
        status: 'failed',
        content: t('agent.thinking.cannotParse'),
      });
      this.finishTask(false, t('agent.finishReasons.aiInvalid'));
      return;
    }

    if (graphResult.nextAction.type === 'fail') {
      this.lastParseRetried = false;
      this.actions.updateThinkingStep(thinkStepId, {
        status: graphResult.response ? 'completed' : 'failed',
        content: graphResult.response
          ? formatAgentResponseProjection(graphResult.response)
          : graphResult.nextAction.reason,
      });
      this.finishTask(false, graphResult.nextAction.reason);
      return;
    }

    this.lastParseRetried = false;
    this.actions.updateThinkingStep(thinkStepId, {
      status: 'completed',
      content: graphResult.response
        ? formatAgentResponseProjection(graphResult.response)
        : '',
    });

    if (graphResult.execution) {
      if (graphResult.execution.error) {
        if (!this.isCurrent(capturedVersion)) return;
        const message = graphResult.execution.error;
        if (execStepId) {
          this.actions.updateThinkingStep(execStepId, {
            status: 'failed',
            content: message,
          });
        }
        this.finishTask(false, message);
        return;
      }

      this.lastCommandOutput = graphResult.execution.nextDecisionContext
        || graphResult.execution.output;
      if (execStepId) {
        this.actions.updateThinkingStep(execStepId, {
          status: 'completed',
          content: graphResult.execution.observation
            || `${graphResult.execution.command}\n\n${extractKeyOutput(graphResult.execution.output, 1500)}`,
        });
      }
      this.status = 'idle';
      this.actions.setAgentState('thinking');
      this.scheduleProcess();
      return;
    }

    await this.applyGraphAction(graphResult, capturedVersion);
  }

  private async applyGraphAction(
    graphResult: AgentRoundGraphResult,
    capturedVersion: number,
  ) {
    const { nextAction } = graphResult;

    if (nextAction.type === 'finish') {
      this.finishTask(true, nextAction.reason);
      return;
    }

    if (nextAction.type === 'ask') {
      this.status = 'awaitingQuestion';
      this.actions.setAgentState('observing');
      this.actions.setPendingQuestion(nextAction.question);
      return;
    }

    if (nextAction.type === 'approval') {
      this.status = 'awaitingApproval';
      this.actions.setAgentState('observing');
      this.actions.setPendingApproval({
        command: nextAction.command,
        riskLevel: nextAction.riskLevel,
      });
      return;
    }

    if (nextAction.type === 'execute') {
      await this.runCommand(nextAction.command, capturedVersion);
      return;
    }

    this.finishTask(false, t('agent.finishReasons.aiInvalid'));
  }

  private async runCommand(command: string, capturedVersion: number) {
    if (!this.isCurrent(capturedVersion)) return;

    this.status = 'executing';
    this.actions.setAgentState('executing');
    const execStepId = this.generateStepId();
    this.actions.addThinkingStep({
      id: execStepId,
      type: 'execution',
      title: `执行命令:${command}`,
      content: command,
      timestamp: Date.now(),
      status: 'in_progress',
    });

    this.markCommandExecuted(command);

    let output = '';
    let observation = '';
    try {
      const { runAgentExecutionGraph } = await import('./langgraph-agent-flow');
      const result = await runAgentExecutionGraph({
        command,
        execute: (graphCommand) => this.executeCommandAndWait(
          graphCommand,
          execStepId,
          capturedVersion,
        ),
        summarizeOutput: (graphOutput) => `${command}\n\n${extractKeyOutput(graphOutput, 1500)}`,
        buildNextDecisionContext: (graphCommand, graphOutput) => (
          `命令:${graphCommand}\n\n输出:\n${extractKeyOutput(graphOutput, 8000)}`
        ),
      });
      if (result.error) {
        throw new Error(result.error);
      }
      output = result.output;
      observation = result.observation;
      this.lastCommandOutput = result.nextDecisionContext || result.output;
    } catch (error) {
      if (error instanceof AbortedByRuntimeError) {
        return;
      }
      if (!this.isCurrent(capturedVersion)) return;
      const msg = error instanceof Error ? error.message : t('agent.finishReasons.aiFailed');
      this.actions.updateThinkingStep(execStepId, { status: 'failed', content: msg });
      this.finishTask(false, msg);
      return;
    }

    if (!this.isCurrent(capturedVersion)) return;

    this.actions.updateThinkingStep(execStepId, {
      status: 'completed',
      content: observation || `${command}\n\n${extractKeyOutput(output, 1500)}`,
    });

    this.status = 'idle';
    this.actions.setAgentState('thinking');
    this.scheduleProcess();
  }

  // --------------------------------------------------------------------
  // External events → state transitions
  // --------------------------------------------------------------------

  private applyApprovalDecision(pending: PendingApproval, result: 'approved' | 'rejected') {
    if (this.status !== 'awaitingApproval') {
      // 可能是 stale 事件,忽略
      return;
    }
    const capturedVersion = this.taskVersion;

    this.actions.setPendingApproval(null);
    this.actions.setApprovalResult(null);
    this.seenApprovalResult = null;
    this.snapshot = {
      ...this.snapshot,
      pendingApproval: null,
      approvalResult: null,
    };

    if (result === 'rejected') {
      this.finishTask(false, t('agent.finishReasons.userRejected'));
      return;
    }

    void this.runCommand(pending.command, capturedVersion);
  }

  private applyUserAnswer(input: string) {
    if (this.status !== 'awaitingQuestion') return;

    this.agentMessages.push({
      id: Date.now().toString(),
      role: 'user',
      content: `用户补充信息:${input}`,
      timestamp: Date.now(),
    });

    this.actions.setAgentState('thinking');
    this.actions.setPendingInput('');
    this.actions.setPendingQuestion(null);
    this.seenPendingInput = null;

    this.status = 'idle';
    this.snapshot = {
      ...this.snapshot,
      agentState: 'thinking',
      pendingInput: '',
      pendingQuestion: null,
    };
    this.scheduleProcess();
  }

  private applyPause() {
    this.abortActiveWork('paused');
    this.status = 'paused';
    this.actions.setAgentState('paused');
  }

  private applyResume() {
    if (this.status !== 'paused') return;
    this.status = 'idle';
    this.actions.setAgentState('thinking');
    this.scheduleProcess();
  }

  // --------------------------------------------------------------------
  // AI call
  // --------------------------------------------------------------------

  private createRoundExecutionHooks(input: {
    capturedVersion: number;
    thinkStepId: string;
    setExecStepId: (stepId: string) => void;
  }): AgentRoundExecutionHooks {
    let activeExecStepId = '';

    return {
      beforeExecute: (action) => {
        if (!this.isCurrent(input.capturedVersion)) {
          throw new AbortedByRuntimeError('task version changed');
        }

        this.status = 'executing';
        this.actions.setAgentState('executing');
        this.actions.updateThinkingStep(input.thinkStepId, {
          status: 'completed',
          content: formatAgentResponseProjection(action.response),
        });
        const execStepId = this.generateStepId();
        activeExecStepId = execStepId;
        input.setExecStepId(execStepId);
        this.actions.addThinkingStep({
          id: execStepId,
          type: 'execution',
          title: `执行命令:${action.command}`,
          content: action.command,
          timestamp: Date.now(),
          status: 'in_progress',
        });
        this.markCommandExecuted(action.command);
      },
      execute: (command) => this.executeCommandAndWait(
        command,
        activeExecStepId,
        input.capturedVersion,
      ),
      summarizeOutput: (command, output) => `${command}\n\n${extractKeyOutput(output, 1500)}`,
      buildNextDecisionContext: (command, output) => (
        `命令:${command}\n\n输出:\n${extractKeyOutput(output, 8000)}`
      ),
    };
  }

  private async callAgentRound(
    userInput: string,
    lastOutput: string,
    capturedVersion: number,
    thinkStepId: string,
    executionHooks: AgentRoundExecutionHooks,
  ): Promise<AgentRoundGraphResult> {
    return this.callAgentAI(
      userInput,
      lastOutput,
      capturedVersion,
      thinkStepId,
      executionHooks,
    );
  }

  private async callAgentAI(
    userInput: string,
    lastOutput: string,
    capturedVersion: number,
    thinkStepId: string,
    executionHooks: AgentRoundExecutionHooks,
  ): Promise<AgentRoundGraphResult> {
    const { activeProviderId, providers, config, taskHistory, activeConversationId } = this.snapshot;
    if (!activeProviderId) {
      throw new Error('AI provider not found');
    }
    const provider = providers.find((p) => p.id === activeProviderId);
    if (!provider) {
      throw new Error('AI provider not found');
    }

    const executedCommands: string[] = [];
    for (const msg of this.agentMessages) {
      if (msg.role === 'assistant') {
        try {
          const parsed = parseAgentResponse(msg.content);
          if (parsed?.command) executedCommands.push(parsed.command);
        } catch (e) {}
      }
    }

    const messages: Message[] = [
      { id: 'system', role: 'system', content: AGENT_SYSTEM_PROMPT, timestamp: Date.now() },
      ...this.agentMessages,
    ];

    const taskContextRounds = 3;
    if (taskContextRounds > 0 && taskHistory.length > 0) {
      const recentTasks = taskHistory
        .filter((t) => (
          (t.state === 'finished' || t.state === 'error')
          && (t.conversationId || t.id) === activeConversationId
        ))
        .slice(0, taskContextRounds);

      if (recentTasks.length > 0) {
        const taskContext = recentTasks.map((t, index) => {
          const executedCmds = t.executions.filter((e) => e.success).map((e) => e.command).join(', ');
          return `**任务 ${index + 1}**:${t.userInput}
状态:${t.state === 'finished' ? '已完成' : '失败'}
${executedCmds ? `执行命令:${executedCmds}` : ''}
${t.finishReason ? `结果:${t.finishReason}` : ''}`;
        }).join('\n\n');

        messages.push({
          id: `task-context-${Date.now()}`,
          role: 'system',
          content: `**历史任务上下文**(最近 ${recentTasks.length} 轮):\n\n${taskContext}`,
          timestamp: Date.now(),
        });
      }
    }

    let userMessageContent = `用户任务:${userInput}`;
    if (executedCommands.length > 0) {
      userMessageContent += `\n\n已执行(${executedCommands.length}/${this.snapshot.config.maxExecutionSteps || 20}步):${executedCommands.map(cmd => `\n- ${cmd}`).join('')}`;
    }
    if (lastOutput) {
      const extractedOutput = extractKeyOutput(lastOutput, 8000);
      userMessageContent += `\n\n上一次命令输出:\n\`\`\`\n${extractedOutput}\n\`\`\``;
    }
    userMessageContent += '\n\n请基于当前任务和命令输出决定下一步。只能回复纯 JSON：如果任务已完成，返回 {"thought":{"reasoning":"...","observation":"..."},"decision":"finish","finishReason":"..."}；如果还需执行命令，返回 decision=execute 和 command；如果需要用户确认，返回 decision=ask 和 question。';

    messages.push({
      id: Date.now().toString(),
      role: 'user',
      content: userMessageContent,
      timestamp: Date.now(),
    });

    const requestId = `agent-${activeProviderId}-${this.taskVersion}-${Date.now()}`;
    this.currentAiRequestId = requestId;
    this.activeStreamDisplay = {
      requestId,
      taskVersion: capturedVersion,
      stepId: thinkStepId,
      content: '',
      projectedContent: '',
      frameId: null,
    };

    try {
      const graphInput = {
        providerId: activeProviderId,
        messages,
        requestId,
        parseRetryAvailable: !this.lastParseRetried,
        aiChatStream: this.services.aiChatStream,
        onStreamEvent: (event: AIChatStreamEvent) => {
          this.handleAgentStreamEvent(event, requestId, capturedVersion);
        },
        parseResponse: parseAgentResponse,
        analyzeCommand: this.services.analyzeCommand,
        shouldBlockRepeatedCommand: (command: string) => this.shouldBlockRepeatedCommand(command),
        needsApproval: (riskLevel: RuntimeRiskLevel) => {
          const { config } = this.snapshot;
          return riskLevel === 'critical'
            || (riskLevel === 'high' && config.approveHighRisk !== false)
            || (riskLevel === 'medium' && config.approveMediumRisk !== false);
        },
        fallbackText: {
          parseRetry: 'AI 响应格式异常，正在重试...',
          cannotParse: t('agent.thinking.cannotParse'),
          invalidResponse: t('agent.finishReasons.aiInvalid'),
          completed: t('agent.notifications.completed'),
          analyzing: t('agent.thinking.analyzing'),
          noCommand: t('agent.finishReasons.noCommand'),
          duplicateCommand: (command: string) => t('agent.finishReasons.duplicateCommand', { command }),
        },
      };
      const { runAgentRoundGraph } = await import('./langgraph-agent-flow');
      const result = await runAgentRoundGraph({
        ...graphInput,
        ...executionHooks,
      });
      if (!this.isCurrent(capturedVersion)) {
        throw new AbortedByRuntimeError('task version changed');
      }

      if (result.rawContent) {
        this.agentMessages.push(
          { id: (Date.now() - 1).toString(), role: 'user', content: userMessageContent, timestamp: Date.now() - 1 },
          { id: Date.now().toString(), role: 'assistant', content: result.rawContent, timestamp: Date.now() },
        );
      }

      return result;
    } catch (error) {
      if (
        this.currentAiRequestId !== requestId
        || this.taskVersion !== capturedVersion
        || this.status === 'paused'
        || this.status === 'completed'
        || this.status === 'failed'
      ) {
        throw new AbortedByRuntimeError('AI stream canceled');
      }
      throw error;
    } finally {
      this.releaseStreamDisplay(requestId);
      if (this.currentAiRequestId === requestId) {
        this.currentAiRequestId = null;
      }
    }
  }

  private handleAgentStreamEvent(
    event: AIChatStreamEvent,
    requestId: string,
    capturedVersion: number,
  ) {
    const display = this.activeStreamDisplay;
    if (
      !display
      || event.requestId !== requestId
      || display.requestId !== requestId
      || display.taskVersion !== capturedVersion
      || this.currentAiRequestId !== requestId
      || !this.isCurrent(capturedVersion)
    ) {
      return;
    }

    if (event.type === 'delta') {
      display.content += event.delta;
      if (display.frameId === null) {
        display.frameId = window.requestAnimationFrame(() => {
          if (this.activeStreamDisplay !== display) return;
          display.frameId = null;
          display.projectedContent = extractAgentStreamProjection(display.content);
          if (!display.projectedContent) return;
          this.actions.updateThinkingStep(display.stepId, {
            content: display.projectedContent,
          });
        });
      }
      return;
    }

    if (event.type === 'canceled') {
      this.actions.updateThinkingStep(display.stepId, {
        status: 'failed',
        content: 'AI 请求已取消',
      });
    }
  }

  private releaseStreamDisplay(requestId: string) {
    const display = this.activeStreamDisplay;
    if (!display || display.requestId !== requestId) return;
    if (display.frameId !== null) {
      window.cancelAnimationFrame(display.frameId);
    }
    this.activeStreamDisplay = null;
  }

  // --------------------------------------------------------------------
  // Command execution + wait
  // --------------------------------------------------------------------

  private async executeCommandAndWait(
    command: string,
    execStepId: string,
    capturedVersion: number,
  ): Promise<string> {
    this.terminalOutput = '';
    this.localFullOutput = '';
    const targetConnectionId = this.taskConnectionId;

    if (!targetConnectionId) {
      throw new Error('Agent task connection not found');
    }

    if (!this.services.agentExecAwait) {
      throw new Error('Agent sentinel execution is unavailable');
    }

    return await this.runWithSentinel(command, execStepId, capturedVersion, targetConnectionId);
  }

  private async runWithSentinel(
    command: string,
    execStepId: string,
    capturedVersion: number,
    connectionId: string,
  ): Promise<string> {
    const isLongRunningCommand = isLikelyLongRunningCommand(command);
    const mustWaitForPrompt = shouldWaitForShellPrompt(command);
    const execTimeoutMs = mustWaitForPrompt ? 900_000 : (isLongRunningCommand ? 300_000 : 45_000);
    const runId = `v${capturedVersion}-s${this.stepIdCounter}-${Date.now().toString(36)}`;

    let awaitPromise: Promise<IPCResult<AgentExecAwaitResult>>;
    try {
      awaitPromise = this.services.agentExecAwait!(connectionId, command, { runId, timeoutMs: execTimeoutMs });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Agent exec failed');
    }

    // 登记可取消:pause / cancel 时调用 agentCancelExec,让主进程立刻 resolve 当前等待。
    const execToken = this.registerExecCancellation(connectionId);
    // 监视 token 用于 UI 侧的 blocking watcher,和 execToken 分离,
    // 这样"命令已完成"和"用户要取消"两条路径不会互相误触发。
    const monitorToken = createCancelToken();
    try {
      // 并行跑一个 blocking watcher,只负责弹 UI 提示
      void this.monitorBlockingWhileExecuting(execStepId, capturedVersion, monitorToken);

      const result = await Promise.race([
        awaitPromise,
        this.waitForPromptFallback(command, capturedVersion, connectionId, monitorToken),
      ]);
      if (!this.isCurrent(capturedVersion)) {
        throw new AbortedByRuntimeError('task version changed');
      }
      if (execToken.cancelled) {
        throw new AbortedByRuntimeError(execToken.reason || 'aborted');
      }

      if (!result.success) {
        throw new Error(result.error || '命令执行失败');
      }

      const { output, reason } = result.data;
      const finalOutput = output || this.terminalOutput;
      this.lastCommandOutput = finalOutput;

      if (reason === 'timeout') {
        // 告知用户这次只是超时拉回,不直接算失败
        this.actions.updateThinkingStep(execStepId, {
          content: t('agent.finishReasons.commandTimeout', { command }),
        });
      }
      if (reason === 'closed') {
        throw new Error(t('agent.finishReasons.connectionLost'));
      }

      return finalOutput;
    } finally {
      triggerCancel(monitorToken, 'exec finished');
      this.releaseExecCancellation(execToken);
    }
  }

  private async waitForPromptFallback(
    command: string,
    capturedVersion: number,
    connectionId: string,
    token: CancelToken,
  ): Promise<IPCResult<AgentExecAwaitResult>> {
    let lastOutput = '';
    let stableSince = 0;
    const startedAt = Date.now();

    while (!token.cancelled && this.isCurrent(capturedVersion)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        token.onCancel.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });

      const output = this.terminalOutput;
      if (!output || Date.now() - startedAt < 1500) {
        continue;
      }

      if (output !== lastOutput) {
        lastOutput = output;
        stableSince = Date.now();
        continue;
      }

      const hasStableOutput = stableSince > 0 && Date.now() - stableSince >= 1200;
      if (!hasStableOutput || !hasShellPrompt(output)) {
        continue;
      }

      try { void this.services.agentCancelExec?.(connectionId); } catch { /* ignore */ }
      return {
        success: true,
        data: {
          output,
          exitCode: null,
          reason: 'done',
        },
      };
    }

    throw new AbortedByRuntimeError(token.reason || 'aborted');
  }

  /**
   * Sentinel 等待期间并发跑一个 blocking watcher:只负责弹 UI 提示,
   * 真正的命令完成信号仍由 sentinel 保证。
   * 
   * 判据简化为:tail 上有 blocking pattern → 显示提示;tail 上没有了 → 隐藏提示。
   * 不再用 output 长度阈值,避免用户只按了一个 `y` 就误判为"已解除阻塞"。
   */
  private async monitorBlockingWhileExecuting(
    execStepId: string,
    capturedVersion: number,
    execToken: CancelToken,
  ): Promise<void> {
    let announcedPrompt: string | null = null;
    let blockStepId: string | null = null;

    while (!execToken.cancelled && this.isCurrent(capturedVersion)) {
      const currentOutput = this.terminalOutput;
      const { isBlocking, prompt } = detectTerminalBlocking(currentOutput);

      if (isBlocking && announcedPrompt === null) {
        // 新出现阻塞
        announcedPrompt = prompt;
        this.actions.setPendingTerminalPrompt(prompt);
        blockStepId = this.generateStepId();
        this.actions.addThinkingStep({
          id: blockStepId,
          type: 'observation',
          title: t('agent.thinking.terminalWaiting'),
          content: t('agent.thinking.terminalWaitingContent', { prompt }),
          timestamp: Date.now(),
          status: 'in_progress',
        });
      } else if (isBlocking && announcedPrompt !== null && announcedPrompt !== prompt) {
        // 阻塞类型变了(比如从 password 变成 y/n)
        announcedPrompt = prompt;
        this.actions.setPendingTerminalPrompt(prompt);
      } else if (!isBlocking && announcedPrompt !== null) {
        // 阻塞消失
        this.actions.setPendingTerminalPrompt(null);
        if (blockStepId) {
          this.actions.updateThinkingStep(blockStepId, { status: 'completed' });
        }
        announcedPrompt = null;
        blockStepId = null;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, UNBLOCK_POLL_INTERVAL_MS);
        execToken.onCancel.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (announcedPrompt !== null) {
      this.actions.setPendingTerminalPrompt(null);
      if (blockStepId) {
        this.actions.updateThinkingStep(blockStepId, { status: 'completed' });
      }
    }
  }

  private registerExecCancellation(connectionId: string): CancelToken {
    const token = createCancelToken();
    token.onCancel.push(() => {
      try { void this.services.agentCancelExec?.(connectionId); } catch { /* ignore */ }
    });
    this.currentCancelToken = token;
    return token;
  }

  private releaseExecCancellation(token: CancelToken) {
    if (this.currentCancelToken === token) {
      this.currentCancelToken = null;
    }
  }

  // --------------------------------------------------------------------
  // Cancellation / cleanup
  // --------------------------------------------------------------------

  private abortActiveWork(reason: string) {
    if (this.currentAiRequestId) {
      const requestId = this.currentAiRequestId;
      const display = this.activeStreamDisplay;
      if (display?.requestId === requestId && reason !== 'completed') {
        this.actions.updateThinkingStep(display.stepId, {
          status: 'failed',
          content: reason === 'paused' ? 'AI 请求已暂停' : 'AI 请求已取消',
        });
      }
      try { this.services.cancelAIChat?.(requestId); } catch { /* ignore */ }
      this.releaseStreamDisplay(requestId);
      this.currentAiRequestId = null;
    }
    if (this.currentCancelToken) {
      triggerCancel(this.currentCancelToken, reason);
      this.currentCancelToken = null;
    }
  }

  private stopAgentTaskBridge() {
    if (!this.taskConnectionId) return;
    try { void this.services.agentStopTask?.(this.taskConnectionId); } catch { /* ignore */ }
  }

  private finishTask(success: boolean, reason: string) {
    this.abortActiveWork(success ? 'completed' : 'failed');
    this.status = success ? 'completed' : 'failed';
    this.stopAgentTaskBridge();
    void this.services.notifyTaskCompletion?.(success, reason);
    this.actions.completeTask(success, success ? undefined : reason, success ? reason : undefined);
  }

  // --------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------

  private generateStepId() {
    return `${Date.now()}-${++this.stepIdCounter}`;
  }

  private isCurrent(capturedVersion: number): boolean {
    return this.taskVersion === capturedVersion
      && this.status !== 'completed'
      && this.status !== 'failed';
  }

  private shouldBlockRepeatedCommand(command: string): boolean {
    const normalized = normalizeCommand(command);
    if (!normalized || isSafeRepeatableCommand(normalized)) return false;

    const lastExecutedAt = this.commandExecutionHistory.get(normalized);
    if (!lastExecutedAt) return false;

    return Date.now() - lastExecutedAt < DUPLICATE_COMMAND_COOLDOWN_MS;
  }

  private markCommandExecuted(command: string) {
    const normalized = normalizeCommand(command);
    if (!normalized) return;

    this.commandExecutionHistory.set(normalized, Date.now());

    if (this.commandExecutionHistory.size > 100) {
      const now = Date.now();
      for (const [key, executedAt] of this.commandExecutionHistory.entries()) {
        if (now - executedAt > DUPLICATE_COMMAND_COOLDOWN_MS * 10) {
          this.commandExecutionHistory.delete(key);
        }
      }
    }
  }
}
