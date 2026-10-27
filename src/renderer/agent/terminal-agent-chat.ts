import type { AgentState, PendingApproval } from '../../shared/types';
import { useAgentStore } from '../store/useAgentStore';
import { useAIStore } from '../store/useAIStore';
import { useSessionStore } from '../session/useSessionStore';

export const TERMINAL_AGENT_PREFIX = '@ai';

export type AgentSubmissionError =
  | 'empty'
  | 'disabled'
  | 'noProvider'
  | 'noConnection'
  | 'taskRunning'
  | 'approvalResponseRequired'
  | 'wrongSession';

export type AgentSubmissionAction =
  | { type: 'start'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'new-conversation' }
  | { type: 'approval'; result: 'approved' | 'rejected' };

export type AgentSubmissionResult =
  | { ok: true; action: AgentSubmissionAction }
  | { ok: false; error: AgentSubmissionError };

export interface AgentSubmissionState {
  agentEnabled: boolean;
  hasProvider: boolean;
  hasConnection: boolean;
  expectedConnectionId: string | null;
  currentTaskConnectionId: string | null;
  currentTaskActive: boolean;
  pendingQuestion: string | null;
  pendingApproval: PendingApproval | null;
}

/**
 * Parse a terminal line beginning with the @ai prefix. Leading whitespace is
 * ignored, but the command itself must be the first token so ordinary shell
 * commands such as `echo @ai` are never intercepted.
 */
export function parseTerminalAgentCommand(input: string): { text: string } | null {
  const match = input.trimStart().match(/^@ai(?:\s+|$)([\s\S]*)$/i);
  if (!match) {
    return null;
  }

  return { text: sanitizeAgentTerminalText(match[1]).trim() };
}

export type TerminalAgentReplyMode = 'answer' | 'approval' | 'follow-up' | 'busy';

export type TerminalAgentLineAction =
  | { type: 'agent'; text: string }
  | { type: 'shell-escape'; text: string }
  | { type: 'exit-follow-up' }
  | { type: 'shell' };

/**
 * Decide how a submitted terminal line participates in the current Agent
 * conversation. Follow-up mode accepts the next question directly; @sh always
 * escapes to the normal shell, and an empty line exits follow-up mode.
 */
export function resolveTerminalAgentLineAction(
  rawInput: string,
  replyMode: TerminalAgentReplyMode | null,
): TerminalAgentLineAction {
  const input = rawInput.trim();
  if (/^@sh(?:\s|$)/i.test(input)) {
    return { type: 'shell-escape', text: input.replace(/^@sh\s*/i, '') };
  }
  if (!input) {
    return replyMode === 'follow-up'
      ? { type: 'exit-follow-up' }
      : { type: 'shell' };
  }
  // 'busy'（Agent 正在跑任务）不属于「对话进行中」：此时用户在终端敲的普通命令
  // 就是给 shell 的。旧实现把 busy 当作任何非空行都送 Agent 的窗口，任务跑 45s~15min
  // 期间连 `ls` 都被吞掉，用户还以为终端卡死了。要打断 Agent 请用 Esc，要问 Agent 请带 @ai。
  if (replyMode && replyMode !== 'busy') {
    const parsed = parseTerminalAgentCommand(input);
    return { type: 'agent', text: parsed?.text || input };
  }
  const parsed = parseTerminalAgentCommand(input);
  return parsed
    ? { type: 'agent', text: parsed.text }
    : { type: 'shell' };
}

export function isTerminalAgentCommand(input: string): boolean {
  return parseTerminalAgentCommand(input) !== null;
}

export interface AgentTaskActivityState {
  sessionId: string | null;
  currentTaskState: AgentState | null;
  currentTaskConnectionId: string | null;
  agentState: AgentState | 'idle';
}

/** 是否有 Agent 任务正在**这个会话**里跑（任务属于别的标签页时不算）。 */
export function isAgentTaskRunningInSession(state: AgentTaskActivityState): boolean {
  const { sessionId, currentTaskState, currentTaskConnectionId, agentState } = state;
  if (!sessionId || !currentTaskState) return false;
  if (currentTaskConnectionId && currentTaskConnectionId !== sessionId) return false;
  if (currentTaskState === 'finished' || currentTaskState === 'error') return false;
  return agentState !== 'finished' && agentState !== 'error';
}

export type TerminalAgentEscapeAction = 'interrupt-task' | 'exit-follow-up' | 'passthrough';

/**
 * 终端里按 Esc 该做什么。
 *
 * 旧实现只在连续对话里拦截 Esc，任务运行中直接放行 → 裸 ESC 落到 bash 上，
 * readline 当它是 meta 前缀，下一个键被吃成 `M-x`，看起来就像终端卡住，
 * 用户只能再按 Ctrl+C 才回来。所以「有 Agent 上下文」时必须自己消化这次按键。
 *
 * `passthrough` 用于纯 Shell 场景：vim / less / 补全菜单都依赖 Esc，不能抢。
 */
export function resolveTerminalAgentEscapeAction(input: {
  isTaskRunningHere: boolean;
  isFollowUpActive: boolean;
}): TerminalAgentEscapeAction {
  if (input.isTaskRunningHere) {
    return 'interrupt-task';
  }
  if (input.isFollowUpActive) {
    return 'exit-follow-up';
  }
  return 'passthrough';
}

/**
 * Require a conventional PS1 prompt before treating @ai as an Agent request.
 * This prevents a line such as `cat <<EOF` / `@ai literal` from being
 * intercepted as a heredoc body. Custom prompts without a recognized marker
 * can still use the floating Agent panel.
 */
export function isShellPromptReadyForAgent(
  bufferLine: string,
  currentInput: string,
): boolean {
  if (!bufferLine) {
    return false;
  }
  let line = bufferLine.replace(/\s+$/, '');
  const typedInput = currentInput.trimEnd();
  if (typedInput) {
    if (line.endsWith(typedInput)) {
      line = line.slice(0, -typedInput.length).replace(/\s+$/, '');
    } else if (!/(?:[$#%]|[❯➜λ])$/u.test(line)) {
      return false;
    }
  }
  if (!line || line === '#' || line.endsWith('>')) {
    return false;
  }
  return /(?:[$#%]|[❯➜λ])$/u.test(line);
}

/**
 * Detect a pasted @ai request, including the common single onData chunk used
 * by xterm for `@ai request\r`. A trailing newline is required so merely
 * pasting text into the shell does not submit it to the Agent.
 */
export function parseTerminalAgentPaste(data: string, currentInput = ''): { text: string } | null {
  if (!/[\r\n]$/.test(data)) {
    return null;
  }
  return parseTerminalAgentCommand(`${currentInput}${data.replace(/[\r\n]+$/, '')}`);
}

/**
 * 退出连续对话时发给远端的字节：让 bash 重新画一条提示符。
 *
 * `^U` 只清光标左边、`^K` 清右边，两个一起才真的清空整行：
 * 只发 `^U` 就补 `\r` 的话，光标停在行中间时后半截会被当成命令执行
 * （实测 `echo MID` 光标退到 `ech` 后 `^U\r` 得到 `bash: o: 未找到命令`）。
 * 最后的 `\r` 是空行回车，bash 会补一条 `\r\n<提示符>`；空行不进历史、也不改 `$?`。
 */
export const TERMINAL_AGENT_EXIT_REPAINT = '\x15\x0b\r';

/** Remove terminal control bytes before model output is written into xterm. */
export function sanitizeAgentTerminalText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\t/g, '  ');
}

/** Normalize model prose for a terminal without preserving Markdown alignment padding. */
export function normalizeAgentTerminalText(value: string): string {
  const normalized = sanitizeAgentTerminalText(value)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return normalized;
}

/** Convert plain terminal-agent text to safe xterm output. */
export function formatAgentTerminalText(value: string): string {
  const normalized = normalizeAgentTerminalText(value).replace(/\n/g, '\r\n');
  return normalized ? `${normalized}\r\n` : '';
}

/**
 * 退出连续对话时写进终端的那行灰字。
 *
 * 必须以 `\r` 开头、`\r\n` 结尾：远端对 `^U` 的回包（一串退格 + `\x1b[K`）
 * 要等一个来回才到，若光标停在提示末尾，那些退格会把刚写的字吃掉
 * （实测只剩「已退出 Agent 连」）；先回行首清行再换行，退格就落在空处，
 * 也不会拼在残留的 `@ai` 后面的同一行里。
 */
export function formatAgentExitNotice(text: string): string {
  const normalized = normalizeAgentTerminalText(text);
  return normalized ? `\r\x1b[2K\x1b[90m${normalized}\x1b[0m\r\n` : '';
}

export function resolveAgentSubmission(
  rawText: string,
  state: AgentSubmissionState,
): AgentSubmissionResult {
  const text = rawText.trim();
  if (!text) {
    return { ok: false, error: 'empty' };
  }
  if (/^new$/i.test(text)) {
    return { ok: true, action: { type: 'new-conversation' } };
  }
  if (!state.agentEnabled) {
    return { ok: false, error: 'disabled' };
  }
  if (!state.hasProvider) {
    return { ok: false, error: 'noProvider' };
  }
  if (!state.hasConnection) {
    return { ok: false, error: 'noConnection' };
  }
  if (
    state.currentTaskActive
    && state.currentTaskConnectionId
    && state.expectedConnectionId
    && state.currentTaskConnectionId !== state.expectedConnectionId
  ) {
    return { ok: false, error: 'wrongSession' };
  }
  if (state.pendingApproval) {
    if (/^(?:y|yes|approve|批准|同意)$/i.test(text)) {
      return { ok: true, action: { type: 'approval', result: 'approved' } };
    }
    if (/^(?:n|no|reject|拒绝)$/i.test(text)) {
      return { ok: true, action: { type: 'approval', result: 'rejected' } };
    }
    return { ok: false, error: 'approvalResponseRequired' };
  }
  if (state.pendingQuestion) {
    return { ok: true, action: { type: 'answer', text } };
  }
  if (state.currentTaskActive) {
    return { ok: false, error: 'taskRunning' };
  }

  return { ok: true, action: { type: 'start', text } };
}

/** Shared submission path for the floating panel and terminal @ai input. */
export function submitAgentInput(
  rawText: string,
  expectedConnectionId?: string | null,
): AgentSubmissionResult {
  const agent = useAgentStore.getState();
  const ai = useAIStore.getState();
  const session = useSessionStore.getState();
  const connectionId = expectedConnectionId || session.activeSessionId;
  const result = resolveAgentSubmission(rawText, {
    agentEnabled: agent.config.enabled,
    hasProvider: Boolean(ai.activeProviderId),
    hasConnection: Boolean(connectionId),
    expectedConnectionId: connectionId,
    currentTaskConnectionId: agent.currentTask?.connectionId || null,
    currentTaskActive: Boolean(
      agent.currentTask
      && agent.currentTask.state !== 'finished'
      && agent.currentTask.state !== 'error'
      && agent.agentState !== 'finished'
      && agent.agentState !== 'error',
    ),
    pendingQuestion: agent.pendingQuestion,
    pendingApproval: agent.pendingApproval,
  });

  if (!result.ok) {
    return result;
  }

  if (result.action.type === 'new-conversation') {
    if (
      agent.currentTask
      && agent.currentTask.state !== 'finished'
      && agent.currentTask.state !== 'error'
    ) {
      agent.cancelTask();
    }
    agent.startNewConversation();
  } else if (result.action.type === 'approval') {
    agent.setApprovalResult(result.action.result);
  } else if (result.action.type === 'answer') {
    agent.setPendingInput(result.action.text);
  } else {
    agent.reset();
    agent.startTask(result.action.text, connectionId || undefined);
  }

  return result;
}

