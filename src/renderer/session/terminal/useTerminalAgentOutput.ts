import { useEffect, useRef, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { AgentState, AgentTask } from '../../../shared/types';
import { useAgentStore } from '../../store/useAgentStore';
import { useSessionStore } from '../useSessionStore';
import { executionDurationMs, isExecutionFailure } from '../../agent/agent-execution-metrics';
import { formatAgentTerminalText, normalizeAgentTerminalText, sanitizeAgentTerminalText } from '../../agent/terminal-agent-chat';
import { isShellPromptOnlyLine, readLogicalBufferLine, resolveAgentPromptEraseSequence } from './terminal-input-line';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface TerminalAgentOutputOptions {
  isAlternateScreen: boolean;
  sessionId: string | null;
  terminalInstanceVersion: number;
  translate: Translate;
  xtermRef: RefObject<XTerm | null>;
  /**
   * 这个任务是不是被用户按 Esc 中断掉的。
   *
   * 中断走的是 store 的 `cancelTask()`，它把 `finishReason` 写成英文
   * `Task cancelled by user`，并且状态是 `finished`（绿色）。直接照着打会把
   * 「被中断」显示成一条英文的成功结论，还顺带提示「继续输入下一个问题」——
   * 而此时连续对话已经收起了，按提示敲字只会进 Shell。所以这里单独区分。
   */
  isTaskInterrupted?: (taskId: string) => boolean;
}

function stateLabel(state: AgentState, t: Translate): string | null {
  switch (state) {
    case 'thinking':
    case 'planning':
    case 'executing':
    case 'observing':
    case 'paused':
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

function currentLogicalLine(term: XTerm): string | null {
  const buffer = term.buffer?.active;
  if (!buffer) {
    return null;
  }
  return readLogicalBufferLine((index) => buffer.getLine(index), buffer.cursorY);
}

function previousLogicalLine(term: XTerm): string | null {
  const buffer = term.buffer?.active;
  if (!buffer || buffer.cursorY <= 0) {
    return null;
  }
  return readLogicalBufferLine((index) => buffer.getLine(index), buffer.cursorY - 1);
}

/**
 * 光标当前停在空行或裸提示符上时，可以直接复用这一行；
 * 用户已经输入了内容的行不能覆盖，仍从下一行开始。
 */
function canReuseCurrentLine(term: XTerm): boolean {
  const line = currentLogicalLine(term);
  if (line === null) {
    return false;
  }
  return !line.trim() || isShellPromptOnlyLine(line);
}

function writeLine(term: XTerm, text: string, color?: string): void {
  // xterm 默认 convertEol=false：内部换行必须补成 CRLF，否则下一行会从
  // 上一行结束时的列继续写，多行 Agent 回复会呈阶梯状错位。
  const safeText = normalizeAgentTerminalText(text).replace(/\n/g, '\r\n');
  const label = color ? `\x1b[${color}m${safeText}\x1b[0m` : safeText;
  // 光标落在提示符下方的空行时，单纯清当前空行会把上一行的裸提示符留在屏幕上；
  // 这里按当前/上一行一起判断，把提示符那行也擦掉。
  const erasePrompt = resolveAgentPromptEraseSequence(
    currentLogicalLine(term) ?? '',
    previousLogicalLine(term),
  );
  const prefix = erasePrompt ?? (canReuseCurrentLine(term) ? '\r\x1b[2K' : '\r\n');
  term.write(`${prefix}${label}\r\n`);
}

/** Projects Agent store transitions into the active xterm without a chat panel. */
export function useTerminalAgentOutput({
  isAlternateScreen,
  sessionId,
  terminalInstanceVersion,
  translate: t,
  xtermRef,
  isTaskInterrupted,
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
  const executionResultIdsRef = useRef<Set<string>>(new Set());
  const promptRef = useRef<string | null>(null);
  const approvalRef = useRef<string | null>(null);
  const completedTaskIdRef = useRef<string | null>(null);
  const terminalRef = useRef<string | null>(null);
  // 放进 ref：这个判断只影响结束那一行的写法，不该让它变化时重跑整个投影 effect
  const isTaskInterruptedRef = useRef(isTaskInterrupted);
  isTaskInterruptedRef.current = isTaskInterrupted;

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
      executionResultIdsRef.current.clear();
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
      stateRef.current = 'idle';
      executionStepIdsRef.current.clear();
      executionResultIdsRef.current.clear();
      promptRef.current = null;
      approvalRef.current = null;
      completedTaskIdRef.current = null;
      terminalRef.current = null;
      const prefix = canReuseCurrentLine(term) ? '\r\x1b[2K' : '\r\n';
      // 用户的问题已经在终端输入行回显过，这里不再重复打印；
      // 只打一条 Agent 分隔标题，正文交给状态/命令/结果行。
      term.write(`${prefix}\x1b[36m── Agent ──────────────────────────\x1b[0m\r\n`);
    }

    // 同一任务被重新驱动（结束态 → 进行中）时重新武装结束输出：否则第二次结束时
    // completedTaskIdRef 已命中，摘要不再打印，终端会永久停在最后一行状态标签上
    //（真实回归：运行时被陈旧 sync 复活跑第二轮，见 agent-runtime 的 disposed 守卫）。
    if (
      completedTaskIdRef.current === currentTask.id
      && (
        agentState === 'thinking'
        || agentState === 'planning'
        || agentState === 'executing'
        || agentState === 'observing'
      )
    ) {
      completedTaskIdRef.current = null;
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

    // 每条命令的结局（成功/失败 + 退出码 + 真实耗时）。
    // 没有这一行时，终端里只剩一串 `$ cmd` 和它们的输出，用户看不出哪条失败了、
    // 每条跑了多久 —— 也就是「看不到当前执行状态」的直接来源。
    // 用执行记录 id 去重（不是 step id）：同一 step 重跑会产生新的 execution。
    for (const execution of currentTask.executions) {
      if (executionResultIdsRef.current.has(execution.id)) {
        continue;
      }
      executionResultIdsRef.current.add(execution.id);
      const step = currentTask.thinkingSteps.find((item) => item.id === execution.stepId);
      const durationMs = executionDurationMs(execution, step?.timestamp ?? execution.timestamp);
      const failed = isExecutionFailure(execution);
      const status = execution.exitCode === undefined || execution.exitCode === null
        ? (failed ? t('agent.execution.failed') : t('agent.execution.completed'))
        : t('agent.execution.exitCode', { code: execution.exitCode });
      writeLine(term, t('terminal.agentExecutionResult', {
        mark: failed ? '✗' : '✓',
        status,
        duration: (durationMs / 1000).toFixed(1),
      }), failed ? '31' : '32');
    }

    if (!pendingApproval) {
      approvalRef.current = null;
    } else if (approvalRef.current !== pendingApproval.command) {
      approvalRef.current = pendingApproval.command;
      writeLine(term, t('terminal.agentApproval', { command: pendingApproval.command }), '33');
      writeLine(term, t('terminal.agentApprovalRiskLevel', {
        risk: t(`commandApproval.riskLevels.${pendingApproval.riskLevel}`),
      }), '33');
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
      const interrupted = isTaskInterruptedRef.current?.(currentTask.id) ?? false;
      if (interrupted) {
        writeLine(term, '', undefined);
        term.write(`\x1b[33m${formatAgentTerminalText(t('terminal.agentInterrupted'))}\x1b[0m`);
        return;
      }
      const summary = agentState === 'error'
        ? currentTask.error || currentTask.finishReason || t('agent.states.error')
        : currentTask.finishReason || t('agent.states.finished');
      writeLine(term, '', undefined);
      term.write(`\x1b[${agentState === 'error' ? '31' : '32'}m${formatAgentTerminalText(summary)}\x1b[0m`);
      if (agentState === 'finished') {
        writeLine(term, t('terminal.agentContinuationHint'), '90');
      }
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
