import { AGENT_SYSTEM_PROMPT } from '../../shared/constants';
import { t } from '../i18n';
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
import type { IPCResult, AIChatResult, AgentExecAwaitResult } from '../../shared/ipc-types';

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
  activeProviderId: string | null;
  activeConnectionId: string | null;
  providers: Array<{ id: string }>;
}

export interface AgentRuntimeActions {
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
  cancelAIChat?: (requestId: string) => Promise<IPCResult> | void;
  executeCommand: (command: string) => Promise<IPCResult | undefined>;
  agentStartTask?: (taskId: string, connectionId: string) => Promise<IPCResult>;
  agentStopTask?: (connectionId: string) => Promise<IPCResult>;
  agentExecuteCommand?: (connectionId: string, command: string) => Promise<IPCResult>;
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

// ==========================================================================
// Tunables
// ==========================================================================

const DUPLICATE_COMMAND_COOLDOWN_MS = 8000;
const MAX_LOCAL_AGENT_OUTPUT_SIZE = 256 * 1024;
const UNBLOCK_POLL_MAX_ITERATIONS = 120;
const UNBLOCK_POLL_INTERVAL_MS = 500;
const COMMAND_POLL_INTERVAL_MS = 200;

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
  let cleanContent = content.trim();

  if ((cleanContent.startsWith('"') && cleanContent.endsWith('"')) ||
      (cleanContent.startsWith("'") && cleanContent.endsWith("'"))) {
    cleanContent = cleanContent.slice(1, -1);
  }

  // 1. 直接 JSON 解析
  try {
    const parsed = JSON.parse(cleanContent);
    if (parsed?.decision) return parsed;
  } catch (e) {}

  // 2. 从 markdown 代码块中提取
  const patterns = [/```(?:json)?\s*([\s\S]*?)\s*```/, /`([\s\S]*?)`/];
  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed?.decision) return parsed;
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
      if (parsed?.decision) return parsed;
    } catch (e) {}

    // 4. 尝试修复常见的 JSON 格式问题
    const fixed = fixMalformedJson(jsonCandidate);
    if (fixed) {
      try {
        const parsed = JSON.parse(fixed);
        if (parsed?.decision) return parsed;
      } catch (e) {}
    }
  }

  // 5. 尝试从纯文本中推断意图（最后的兜底）
  return inferResponseFromText(cleanContent);
};

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
  const tail = normalizeTerminalText(output).split('\n').slice(-5).join('\n');
  const promptPatterns = [
    /\]\s*#\s*$/m,
    /\]\s*\$\s*$/m,
    /^.*>\s*$/m,
    /^.*#\s*$/m,
    /^.*\$\s*$/m,
    /\w+@[\w.-]+:\S+#\s*$/m,
    /\w+@[\w.-]+:\S+\$\s*$/m,
    /\[[^\]]+@[^\]]+\][#$]\s*$/m,
  ];

  return promptPatterns.some((pattern) => pattern.test(tail));
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
  private currentCancelToken: CancelToken | null = null;
  private processScheduled = false;

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
    queueMicrotask(() => {
      this.processScheduled = false;
      void this.process();
    });
  }

  private async process() {
    if (this.status !== 'idle') return;
    const task = this.snapshot.currentTask;
    if (!task || this.initializedTaskId !== task.id) return;
    if (this.snapshot.agentState !== 'thinking') return;

    await this.runStep();
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

  private async runStep() {
    const task = this.snapshot.currentTask;
    if (!task) return;
    const capturedVersion = this.taskVersion;

    if (this.stepCount >= (this.snapshot.config.maxExecutionSteps || 20)) {
      this.finishTask(false, t('agent.finishReasons.maxSteps'));
      return;
    }

    this.status = 'thinking';
    this.stepCount += 1;
    const thinkStepId = this.generateStepId();
    this.actions.addThinkingStep({
      id: thinkStepId,
      type: 'understanding',
      title: this.stepCount === 1 ? t('agent.thinking.process') : t('agent.thinking.stepAnalysis', { step: this.stepCount }),
      content: t('agent.thinking.analyzing'),
      timestamp: Date.now(),
      status: 'in_progress',
    });

    let aiResponse: AgentResponse | null;
    try {
      aiResponse = await this.callAgentAI(task.userInput, this.lastCommandOutput, capturedVersion);
    } catch (error) {
      if (error instanceof AbortedByRuntimeError) {
        // 由 pause / cancel 终止,走对应路径,这里不做收尾
        return;
      }
      const msg = error instanceof Error ? error.message : t('aiErrors.defaultError');
      this.actions.updateThinkingStep(thinkStepId, { status: 'failed', content: t('agent.thinking.aiRequestFailed', { error: msg }) });
      if (!this.isCurrent(capturedVersion)) return;
      this.finishTask(false, t('agent.finishReasons.aiFailed'));
      return;
    }

    if (!this.isCurrent(capturedVersion)) return;

    if (!aiResponse) {
      // 解析失败时重试一次（AI 可能返回了截断的 JSON）
      if (!this.lastParseRetried) {
        this.lastParseRetried = true;
        this.actions.updateThinkingStep(thinkStepId, { status: 'failed', content: 'AI 响应格式异常，正在重试...' });
        if (!this.isCurrent(capturedVersion)) return;
        // 给 agentMessages 追加一条提示，让 AI 修正格式
        this.agentMessages.push({
          id: Date.now().toString(),
          role: 'user',
          content: '你的上一次回复格式不正确，无法解析。请严格按照纯 JSON 格式回复：{"thought":{"reasoning":"...","observation":"..."},"decision":"execute|finish|ask","command":"..."}',
          timestamp: Date.now(),
        });
        this.status = 'idle';
        this.scheduleProcess();
        return;
      }
      this.lastParseRetried = false;
      this.actions.updateThinkingStep(thinkStepId, { status: 'failed', content: t('agent.thinking.cannotParse') });
      this.finishTask(false, t('agent.finishReasons.aiInvalid'));
      return;
    }
    this.lastParseRetried = false;

    this.actions.updateThinkingStep(thinkStepId, {
      status: 'completed',
      content: aiResponse.thought.reasoning,
    });

    if (aiResponse.decision === 'finish') {
      this.finishTask(true, aiResponse.finishReason || t('agent.notifications.completed'));
      return;
    }

    if (aiResponse.decision === 'ask') {
      this.status = 'awaitingQuestion';
      this.actions.setPendingQuestion(aiResponse.question || t('agent.thinking.analyzing'));
      return;
    }

    const command = aiResponse.command?.trim();
    if (!command) {
      this.finishTask(false, t('agent.finishReasons.noCommand'));
      return;
    }

    if (this.shouldBlockRepeatedCommand(command)) {
      this.finishTask(false, t('agent.finishReasons.duplicateCommand', { command }));
      return;
    }

    const risk = this.services.analyzeCommand(command);
    const { config } = this.snapshot;
    const needsApproval = risk.riskLevel === 'critical'
      || (risk.riskLevel === 'high' && config.approveHighRisk !== false)
      || (risk.riskLevel === 'medium' && config.approveMediumRisk !== false);

    if (needsApproval) {
      this.status = 'awaitingApproval';
      this.actions.setPendingApproval({ command, riskLevel: risk.riskLevel });
      return;
    }

    await this.runCommand(command, capturedVersion);
  }

  private async runCommand(command: string, capturedVersion: number) {
    if (!this.isCurrent(capturedVersion)) return;

    this.status = 'executing';
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
    try {
      output = await this.executeCommandAndWait(command, execStepId, capturedVersion);
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

    const content = `${command}\n\n${extractKeyOutput(output, 1500)}`;
    this.actions.updateThinkingStep(execStepId, { status: 'completed', content });

    this.status = 'idle';
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

    this.actions.setPendingInput('');
    this.actions.setPendingQuestion(null);
    this.seenPendingInput = null;

    this.status = 'idle';
    this.scheduleProcess();
  }

  private applyPause() {
    this.abortActiveWork('paused');
    this.status = 'paused';
  }

  private applyResume() {
    if (this.status !== 'paused') return;
    this.status = 'idle';
    this.scheduleProcess();
  }

  // --------------------------------------------------------------------
  // AI call
  // --------------------------------------------------------------------

  private async callAgentAI(
    userInput: string,
    lastOutput: string,
    capturedVersion: number,
  ): Promise<AgentResponse | null> {
    const { activeProviderId, providers, config, taskHistory } = this.snapshot;
    if (!activeProviderId) return null;
    const provider = providers.find((p) => p.id === activeProviderId);
    if (!provider) return null;

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

    const taskContextRounds = config.taskContextRounds ?? 3;
    if (taskContextRounds > 0 && taskHistory.length > 0) {
      const recentTasks = taskHistory
        .filter((t) => t.state === 'finished' || t.state === 'error')
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
      const maxLength = config.maxTerminalOutputLength ?? 8000;
      const extractedOutput = maxLength === 0 ? lastOutput : extractKeyOutput(lastOutput, maxLength);
      userMessageContent += `\n\n终端输出:\n\`\`\`\n${extractedOutput}\n\`\`\``;
    }

    messages.push({
      id: Date.now().toString(),
      role: 'user',
      content: userMessageContent,
      timestamp: Date.now(),
    });

    const requestId = `agent-${activeProviderId}-${this.taskVersion}-${Date.now()}`;
    this.currentAiRequestId = requestId;

    try {
      const result = await this.services.aiChat(activeProviderId, messages, { requestId });
      if (!this.isCurrent(capturedVersion)) {
        throw new AbortedByRuntimeError('task version changed');
      }
      if (!result.success || !result.data) {
        return null;
      }
      const parsed = parseAgentResponse(result.data.content);
      if (!parsed) return null;

      this.agentMessages.push(
        { id: (Date.now() - 1).toString(), role: 'user', content: userMessageContent, timestamp: Date.now() - 1 },
        { id: Date.now().toString(), role: 'assistant', content: result.data.content, timestamp: Date.now() },
      );

      const maxMessages = config.maxContextMessages || 20;
      if (this.agentMessages.length > maxMessages * 1.5) {
        this.agentMessages = this.agentMessages.slice(-(maxMessages * 2));
        this.actions.trimAgentContext();
      }

      return parsed;
    } finally {
      if (this.currentAiRequestId === requestId) {
        this.currentAiRequestId = null;
      }
    }
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

    // 优先走 sentinel 可靠路径
    if (this.services.agentExecAwait) {
      return await this.runWithSentinel(command, execStepId, capturedVersion, targetConnectionId);
    }

    // 回退到启发式路径（旧版行为，兼容没有 agentExecAwait 的场景）
    return await this.runWithHeuristics(command, execStepId, capturedVersion, targetConnectionId);
  }

  private async runWithSentinel(
    command: string,
    execStepId: string,
    capturedVersion: number,
    connectionId: string,
  ): Promise<string> {
    const isLongRunningCommand = isLikelyLongRunningCommand(command);
    const mustWaitForPrompt = shouldWaitForShellPrompt(command);
    const execTimeoutMs = mustWaitForPrompt ? 900_000 : (isLongRunningCommand ? 300_000 : 120_000);
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

      const result = await awaitPromise;
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

  private async runWithHeuristics(
    command: string,
    execStepId: string,
    capturedVersion: number,
    targetConnectionId: string,
  ): Promise<string> {
    if (this.services.agentExecuteCommand) {
      await this.services.agentExecuteCommand(targetConnectionId, command);
    } else {
      await this.services.executeCommand(command);
    }
    if (!this.isCurrent(capturedVersion)) {
      throw new AbortedByRuntimeError('task version changed');
    }

    const commandSentTime = Date.now();
    const isLongRunningCommand = isLikelyLongRunningCommand(command);
    const mustWaitForPrompt = shouldWaitForShellPrompt(command);
    const minWaitMs = isLongRunningCommand ? 10000 : 3000;
    const maxWaitMs = mustWaitForPrompt ? 900000 : (isLongRunningCommand ? 300000 : 20000);
    const noGrowthTimeoutMs = isLongRunningCommand ? 15000 : 2000;

    await this.pollUntil((token) => {
      let lastCheckLength = 0;
      let lastGrowTime = Date.now();

      return new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (token.cancelled) {
            reject(new AbortedByRuntimeError(token.reason || 'aborted'));
            return;
          }
          const currentOutput = this.terminalOutput;
          const blocking = detectTerminalBlocking(currentOutput);
          if (blocking.isBlocking) {
            resolve();
            return;
          }

          const hasSeenPrompt = currentOutput.length > 0 && hasShellPrompt(currentOutput);
          if (currentOutput.length > lastCheckLength) {
            lastGrowTime = Date.now();
            lastCheckLength = currentOutput.length;
          }

          const elapsed = Date.now() - commandSentTime;
          const timeSinceLastGrowth = Date.now() - lastGrowTime;
          const hasEnoughOutput = currentOutput.length > 100;

          const canStopByPrompt = hasSeenPrompt && elapsed > minWaitMs && timeSinceLastGrowth > 1000;
          const canStopByNoGrowth = !mustWaitForPrompt && !isLongRunningCommand
            && timeSinceLastGrowth > noGrowthTimeoutMs
            && elapsed > minWaitMs
            && hasEnoughOutput;
          const canStopByTimeout = elapsed > maxWaitMs;

          if (canStopByPrompt || canStopByNoGrowth || canStopByTimeout) {
            resolve();
            return;
          }

          const timer = setTimeout(tick, COMMAND_POLL_INTERVAL_MS);
          token.onCancel.push(() => clearTimeout(timer));
        };
        const timer = setTimeout(tick, COMMAND_POLL_INTERVAL_MS);
        token.onCancel.push(() => clearTimeout(timer));
      });
    });
    if (!this.isCurrent(capturedVersion)) {
      throw new AbortedByRuntimeError('task version changed');
    }

    this.lastCommandOutput = this.terminalOutput;

    const blocking = detectTerminalBlocking(this.lastCommandOutput);
    if (blocking.isBlocking) {
      await this.waitForUnblock(execStepId, blocking.prompt, capturedVersion);
    }

    return this.lastCommandOutput;
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

  private async waitForUnblock(execStepId: string, prompt: string, capturedVersion: number): Promise<void> {
    this.status = 'waitingForUnblock';
    this.actions.setPendingTerminalPrompt(prompt);
    const blockStepId = this.generateStepId();
    this.actions.addThinkingStep({
      id: blockStepId,
      type: 'observation',
      title: t('agent.thinking.terminalWaiting'),
      content: t('agent.thinking.terminalWaitingContent', { prompt }),
      timestamp: Date.now(),
      status: 'in_progress',
    });

    try {
      await this.pollUntil((token) => {
        return new Promise<void>((resolve, reject) => {
          let pollCount = 0;
          const tick = () => {
            if (token.cancelled) {
              reject(new AbortedByRuntimeError(token.reason || 'aborted'));
              return;
            }
            const currentOutput = this.terminalOutput;
            const stillBlocking = detectTerminalBlocking(currentOutput);
            if (!stillBlocking.isBlocking || currentOutput.length > this.lastCommandOutput.length + 5) {
              this.lastCommandOutput = currentOutput;
              resolve();
              return;
            }
            pollCount += 1;
            if (pollCount >= UNBLOCK_POLL_MAX_ITERATIONS) {
              resolve();
              return;
            }
            const timer = setTimeout(tick, UNBLOCK_POLL_INTERVAL_MS);
            token.onCancel.push(() => clearTimeout(timer));
          };
          const timer = setTimeout(tick, UNBLOCK_POLL_INTERVAL_MS);
          token.onCancel.push(() => clearTimeout(timer));
        });
      });
    } finally {
      this.actions.setPendingTerminalPrompt(null);
      if (this.isCurrent(capturedVersion)) {
        this.actions.updateThinkingStep(blockStepId, { status: 'completed' });
        this.status = 'executing';
      }
    }
  }

  /**
   * 将一段以 `CancelToken` 为入参的 promise 产生器,绑定到本 runtime 的 `currentCancelToken` 上。
   * pause / cancel / dispose / new task 都会 trigger 这个 token 的 cancel,让等待立即退出。
   */
  private pollUntil<T>(producer: (token: CancelToken) => Promise<T>): Promise<T> {
    const token = createCancelToken();
    this.currentCancelToken = token;
    return producer(token).finally(() => {
      if (this.currentCancelToken === token) {
        this.currentCancelToken = null;
      }
    });
  }

  // --------------------------------------------------------------------
  // Cancellation / cleanup
  // --------------------------------------------------------------------

  private abortActiveWork(reason: string) {
    if (this.currentAiRequestId) {
      try { this.services.cancelAIChat?.(this.currentAiRequestId); } catch { /* ignore */ }
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
