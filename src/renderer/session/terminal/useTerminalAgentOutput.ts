import { useEffect, useRef, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { AgentState, AgentTask } from '../../../shared/types';
import { useAgentStore } from '../../store/useAgentStore';
import { useSessionStore } from '../useSessionStore';
import { formatAgentTerminalText, sanitizeAgentTerminalText } from '../../agent/terminal-agent-chat';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface TerminalAgentOutputOptions {
  isAlternateScreen: boolean;
  sessionId: string | null;
  terminalInstanceVersion: number;
  translate: Translate;
  xtermRef: RefObject<XTerm | null>;
}

function stateLabel(state: AgentState, t: Translate): string | null {
  switch (state) {
    case 'thinking':
    case 'planning':
    case 'executing':
    case 'observing':
      return t(`agent.states.${state}`);
    case 'paused':
    case 'finished':
    case 'error':
      return t(`agent.states.${state}`);
    default:
      return null;
  }
}

function commandFromStep(content: string): string {
  return content.match(/命令：(.+?)(?:\n|$)/)?.[1]?.trim()
    || content.split('\n')[0]?.replace(/^.*?(?:执行命令|Execute)[:：]\s*/, '').trim()
    || content.split('\n')[0]?.trim()
    || '';
}

function writeLine(term: XTerm, text: string, color?: string): void {
  const safeText = sanitizeAgentTerminalText(text);
  const label = color ? `\x1b[${color}m${safeText}\x1b[0m` : safeText;
  term.write(`\r\n${label}\r\n`);
}

/** Projects Agent store transitions into the active xterm without a chat panel. */
export function useTerminalAgentOutput({
  isAlternateScreen,
  sessionId,
  terminalInstanceVersion,
  translate: t,
  xtermRef,
}: TerminalAgentOutputOptions): void {
  const currentTask = useAgentStore((state) => state.currentTask);
  const agentState = useAgentStore((state) => state.agentState);
  const pendingApproval = useAgentStore((state) => state.pendingApproval);
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion);
  const pendingTerminalPrompt = useAgentStore((state) => state.pendingTerminalPrompt);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const taskIdRef = useRef<string | null>(null);
  const stateRef = useRef<AgentState | 'idle'>('idle');
  const executionStepIdsRef = useRef<Set<string>>(new Set());
  const promptRef = useRef<string | null>(null);
  const approvalRef = useRef<string | null>(null);
  const completedTaskIdRef = useRef<string | null>(null);
  const terminalRef = useRef<string | null>(null);

  useEffect(() => {
    if (isAlternateScreen || !sessionId || activeSessionId !== sessionId) {
      return;
    }
    const term = xtermRef.current;
    if (!term) {
      return;
    }

    if (!currentTask) {
      taskIdRef.current = null;
      stateRef.current = 'idle';
      executionStepIdsRef.current.clear();
      promptRef.current = null;
      approvalRef.current = null;
      completedTaskIdRef.current = null;
      terminalRef.current = null;
      return;
    }
    if (currentTask.connectionId && currentTask.connectionId !== sessionId) {
      return;
    }

    if (taskIdRef.current !== currentTask.id) {
      taskIdRef.current = currentTask.id;
      stateRef.current = agentState;
      executionStepIdsRef.current.clear();
      promptRef.current = null;
      approvalRef.current = null;
      completedTaskIdRef.current = null;
      terminalRef.current = null;
      const userText = sanitizeAgentTerminalText(currentTask.userInput);
      term.write(`\r\n\x1b[36m┌─ Agent ─────────────────────────\x1b[0m\r\n`);
      term.write(`\x1b[36m│\x1b[0m \x1b[1m${formatAgentTerminalText(userText)}`);
      term.write(`\x1b[36m└────────────────────────────────\x1b[0m\r\n`);
    }

    if (stateRef.current !== agentState) {
      stateRef.current = agentState;
      const label = stateLabel(agentState, t);
      if (label) {
        const color = agentState === 'error'
          ? '31'
          : agentState === 'finished'
            ? '32'
            : agentState === 'paused'
              ? '33'
              : '36';
        writeLine(term, `Agent · ${label}`, color);
      }
    }

    for (const step of currentTask.thinkingSteps) {
      if (step.type !== 'execution' || executionStepIdsRef.current.has(step.id)) {
        continue;
      }
      executionStepIdsRef.current.add(step.id);
      const command = sanitizeAgentTerminalText(commandFromStep(step.content));
      if (command) {
        writeLine(term, `$ ${command}`, '90');
      }
    }

    if (!pendingApproval) {
      approvalRef.current = null;
    } else if (approvalRef.current !== pendingApproval.command) {
      approvalRef.current = pendingApproval.command;
      writeLine(term, t('terminal.agentApproval', { command: pendingApproval.command }), '33');
      writeLine(term, t('terminal.agentApprovalReplyHint'), '90');
    }

    if (!pendingTerminalPrompt) {
      terminalRef.current = null;
    } else if (terminalRef.current !== pendingTerminalPrompt) {
      terminalRef.current = pendingTerminalPrompt;
      writeLine(term, t('agent.task.terminalWaitingHint', { prompt: pendingTerminalPrompt }), '33');
    }

    if (!pendingQuestion) {
      promptRef.current = null;
    } else if (promptRef.current !== pendingQuestion) {
      promptRef.current = pendingQuestion;
      writeLine(term, pendingQuestion, '33');
      writeLine(term, t('terminal.agentQuestionHint'), '90');
    }

    if (
      (agentState === 'finished' || agentState === 'error')
      && completedTaskIdRef.current !== currentTask.id
    ) {
      completedTaskIdRef.current = currentTask.id;
      const summary = agentState === 'error'
        ? currentTask.error || currentTask.finishReason || t('agent.states.error')
        : currentTask.finishReason || t('agent.states.finished');
      writeLine(term, '', undefined);
      term.write(`\x1b[${agentState === 'error' ? '31' : '32'}m${formatAgentTerminalText(summary)}\x1b[0m`);
    }
  }, [
    activeSessionId,
    agentState,
    currentTask,
    isAlternateScreen,
    pendingApproval,
    pendingQuestion,
    pendingTerminalPrompt,
    sessionId,
    terminalInstanceVersion,
    t,
    xtermRef,
  ]);
}
