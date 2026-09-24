import type { PendingApproval } from '../../shared/types';
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

export type TerminalAgentReplyMode = 'answer' | 'approval' | 'follow-up';

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
  if (replyMode) {
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

/** Convert plain terminal-agent text to safe xterm output. */
export function formatAgentTerminalText(value: string): string {
  const normalized = sanitizeAgentTerminalText(value).replace(/\n/g, '\r\n');
  return normalized ? `${normalized}\r\n` : '';
}

export function resolveAgentSubmission(
  rawText: string,
  state: AgentSubmissionState,
): AgentSubmissionResult {
  const text = rawText.trim();
  if (!text) {
    return { ok: false, error: 'empty' };
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

  if (result.action.type === 'approval') {
    agent.setApprovalResult(result.action.result);
  } else if (result.action.type === 'answer') {
    agent.setPendingInput(result.action.text);
  } else {
    agent.reset();
    agent.startTask(result.action.text, connectionId || undefined);
  }

  return result;
}

