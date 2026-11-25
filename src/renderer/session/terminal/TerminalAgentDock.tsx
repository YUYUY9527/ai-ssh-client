import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  History,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Pause,
  Play,
  PlugZap,
  RotateCcw,
  Save,
  ScrollText,
  Send,
  Settings,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { COMMAND_DESCRIPTIONS } from '../../../shared/constants';
import type { AgentExecution, AgentState, AgentTask, MessageAttachment, ThinkingStep } from '../../../shared/types';
import { analyzeCommandRisk } from '../../ai/analyze-command-risk';
import { executionDurationMs, isExecutionFailure } from '../../agent/agent-execution-metrics';
import { submitAgentInput, type AgentSubmissionError } from '../../agent/terminal-agent-chat';
import { isRememberableRisk, rememberCommandDecision } from '../../assistant/risk-approval-memory';
import { useAIStore } from '../../store/useAIStore';
import { useAgentStore } from '../../store/useAgentStore';
import { AgentMarkdownView } from './AgentMarkdownView';

export interface TerminalAgentNotice {
  id: number;
  tone: 'info' | 'error';
  message: string;
}

export interface TerminalAgentDraftPaste {
  id: number;
  text: string;
}

interface AgentConversationSummary {
  id: string;
  title: string;
  taskCount: number;
  updatedAt: number;
  latestTask: AgentTask;
}

interface CommandTimelineItem {
  id: string;
  command: string;
  step?: ThinkingStep;
  execution?: AgentExecution;
  durationLabel: string | null;
  status: 'running' | 'success' | 'failed';
}

interface TerminalAgentDockProps {
  sessionId: string | null;
  isAlternateScreen: boolean;
  /** 每次用户点击工具栏 AI 按钮或终端触发 @ai 时递增，展开停靠面板。 */
  openToken: number;
  /** 每次需要把输入焦点聚焦到卡片输入框时递增。 */
  focusInputToken: number;
  /** 用户点击终端画布时递增，将已展开的卡片自动缩小为顶部状态胶囊。 */
  collapseToken: number;
  /** 终端右键「粘贴到 AI 助手」带入的草稿文本。 */
  pastedDraft: TerminalAgentDraftPaste | null;
  /** 本终端内的轻量提示或提交错误（例如未配置模型、开启新对话等）。 */
  notice: TerminalAgentNotice | null;
  onClearNotice: () => void;
  /** 判断某任务是否被用户按 Esc/停止中断。 */
  isTaskInterrupted: (taskId: string) => boolean;
  /** 中断正在运行的任务（通知后端掐断命令 + 更新 store）。 */
  onInterruptTask: () => void;
  /** 将代码块中的命令填入当前终端输入行（不自动执行）。 */
  onInsertCommand: (command: string) => void;
  /** 打开 AI 供应商设置页。 */
  onOpenSettings?: () => void;
  /** 把焦点交回终端画布。 */
  onFocusTerminal: () => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

function commandFromStep(content: string): string {
  return content.match(/命令：(.+?)(?:\n|$)/)?.[1]?.trim()
    || content.split('\n')[0]?.replace(/^.*?(?:执行命令|Execute)[:：]\s*/, '').trim()
    || content.split('\n')[0]?.trim()
    || '';
}

function getCommandDescription(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const baseCmd = parts[0];
  if (!baseCmd) return null;
  if (COMMAND_DESCRIPTIONS[command]) return COMMAND_DESCRIPTIONS[command];
  for (let i = parts.length; i >= 1; i -= 1) {
    const partial = parts.slice(0, i).join(' ');
    if (COMMAND_DESCRIPTIONS[partial]) return COMMAND_DESCRIPTIONS[partial];
  }
  return COMMAND_DESCRIPTIONS[baseCmd] || null;
}

function getTaskConversationId(task: AgentTask): string {
  return task.conversationId || task.id;
}

function sortTasksAscending(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort((left, right) => left.startTime - right.startTime);
}

function formatTaskDuration(task: AgentTask): string {
  const endTime = task.endTime || Date.now();
  const seconds = Math.max(0, Math.floor((endTime - task.startTime) / 1000));
  return `${seconds}s`;
}

function buildCommandTimeline(task: AgentTask): CommandTimelineItem[] {
  const execByStep = new Map<string, AgentExecution>();
  for (const execution of task.executions) {
    execByStep.set(execution.stepId, execution);
  }

  const items: CommandTimelineItem[] = [];
  const seenExecIds = new Set<string>();

  for (const step of task.thinkingSteps) {
    if (step.type !== 'execution') continue;
    const execution = execByStep.get(step.id);
    if (execution) seenExecIds.add(execution.id);
    const command = execution?.command || commandFromStep(step.content);
    if (!command) continue;
    const status: 'running' | 'success' | 'failed' = execution
      ? (isExecutionFailure(execution) ? 'failed' : 'success')
      : (step.status === 'failed' ? 'failed' : step.status === 'completed' ? 'success' : 'running');
    const durationMs = execution ? executionDurationMs(execution, step.timestamp) : null;
    items.push({
      id: execution?.id || step.id,
      command,
      step,
      execution,
      durationLabel: durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : null,
      status,
    });
  }

  for (const execution of task.executions) {
    if (seenExecIds.has(execution.id)) continue;
    const durationMs = executionDurationMs(execution, execution.timestamp);
    items.push({
      id: execution.id,
      command: execution.command,
      execution,
      durationLabel: `${(durationMs / 1000).toFixed(1)}s`,
      status: isExecutionFailure(execution) ? 'failed' : 'success',
    });
  }

  return items;
}

function statusBadgeMeta(
  state: AgentState,
  interrupted: boolean,
  hasApproval: boolean,
  hasQuestion: boolean,
  t: (key: string, params?: Record<string, string | number>) => string,
): { label: string; toneClass: string; spinning: boolean } {
  if (hasApproval) {
    return {
      label: t('terminal.agentStatusAwaitingApproval'),
      toneClass: 'border-warning bg-warning-muted text-warning-fg',
      spinning: false,
    };
  }
  if (hasQuestion) {
    return {
      label: t('terminal.agentStatusAwaitingAnswer'),
      toneClass: 'border-info bg-info-muted text-info-fg',
      spinning: false,
    };
  }
  if (interrupted) {
    return {
      label: t('terminal.agentDock.interrupted'),
      toneClass: 'border-warning bg-warning-muted text-warning-fg',
      spinning: false,
    };
  }
  if (state === 'error') {
    return {
      label: t('agent.states.error'),
      toneClass: 'border-danger bg-danger-muted text-danger-fg',
      spinning: false,
    };
  }
  if (state === 'finished') {
    return {
      label: t('agent.states.finished'),
      toneClass: 'border-success bg-success-muted text-success-fg',
      spinning: false,
    };
  }
  if (state === 'paused') {
    return {
      label: t('agent.states.paused'),
      toneClass: 'border-warning bg-warning-muted text-warning-fg',
      spinning: false,
    };
  }
  return {
    label: t(`agent.states.${state}`),
    toneClass: 'border-accent bg-accent-muted text-accent',
    spinning: true,
  };
}

/**
 * 终端顶部独立 AI 助手停靠卡片（向下展开，绝不遮挡底部终端输入）：
 * 完整整合对话线程、历史切换、新对话、附件上传、工具审计、可编辑风险审批、
 * 命令时间线与 Markdown/表格排版；点击终端画布时自动收起为顶部状态胶囊。
 */
export function TerminalAgentDock({
  sessionId,
  isAlternateScreen,
  openToken,
  focusInputToken,
  collapseToken,
  pastedDraft,
  notice,
  onClearNotice,
  isTaskInterrupted,
  onInterruptTask,
  onInsertCommand,
  onOpenSettings,
  onFocusTerminal,
  translate: t,
}: TerminalAgentDockProps) {
  const currentTask = useAgentStore((state) => state.currentTask);
  const agentState = useAgentStore((state) => state.agentState);
  const taskHistory = useAgentStore((state) => state.taskHistory);
  const activeConversationId = useAgentStore((state) => state.activeConversationId);
  const pendingApproval = useAgentStore((state) => state.pendingApproval);
  const pendingQuestion = useAgentStore((state) => state.pendingQuestion);
  const pendingTerminalPrompt = useAgentStore((state) => state.pendingTerminalPrompt);
  const setApprovalResult = useAgentStore((state) => state.setApprovalResult);
  const setPendingApproval = useAgentStore((state) => state.setPendingApproval);
  const pauseTask = useAgentStore((state) => state.pauseTask);
  const resumeTask = useAgentStore((state) => state.resumeTask);
  const startTask = useAgentStore((state) => state.startTask);
  const resetAgent = useAgentStore((state) => state.reset);
  const startNewConversation = useAgentStore((state) => state.startNewConversation);
  const selectConversation = useAgentStore((state) => state.selectConversation);
  const removeTaskFromHistory = useAgentStore((state) => state.removeTaskFromHistory);

  const providers = useAIStore((state) => state.providers);
  const activeProviderId = useAIStore((state) => state.activeProviderId);
  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeProviderId) ?? null,
    [providers, activeProviderId],
  );

  const belongsHere = Boolean(
    sessionId
    && currentTask
    && (!currentTask.connectionId || currentTask.connectionId === sessionId),
  );
  const task = belongsHere ? currentTask : null;
  const taskId = task?.id ?? null;

  const [dismissedTaskId, setDismissedTaskId] = useState<string | null>(null);
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedExecIds, setExpandedExecIds] = useState<Record<string, boolean>>({});
  const [expandedHistoryTurnIds, setExpandedHistoryTurnIds] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rememberChoice, setRememberChoice] = useState(false);
  const [isEditingApproval, setIsEditingApproval] = useState(false);
  const [approvalDraft, setApprovalDraft] = useState('');
  const [followUpInput, setFollowUpInput] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRecords, setAuditRecords] = useState<Array<{ at: string; tool: string; path?: string; write?: boolean }>>([]);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFocusRef = useRef(false);
  const lastOpenTokenRef = useRef(openToken);
  const lastFocusTokenRef = useRef(focusInputToken);
  const lastCollapseTokenRef = useRef(collapseToken);
  const lastPastedDraftIdRef = useRef<number | null>(null);

  const isRunning = Boolean(
    task
    && task.state !== 'finished'
    && task.state !== 'error'
    && agentState !== 'finished'
    && agentState !== 'error',
  );
  const isPaused = isRunning && agentState === 'paused';
  const interrupted = Boolean(task && isTaskInterrupted(task.id));
  const taskApproval = belongsHere ? pendingApproval : null;
  const taskQuestion = belongsHere ? pendingQuestion : null;
  const taskTerminalPrompt = belongsHere ? pendingTerminalPrompt : null;

  const isDismissed = Boolean(taskId && dismissedTaskId === taskId);
  const shouldShow = !isAlternateScreen && Boolean(
    (task && !isDismissed) || notice || manuallyOpened,
  );

  const requestInputFocus = () => {
    pendingFocusRef.current = true;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el || el.disabled) return;
      pendingFocusRef.current = false;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  };

  // 切换会话时重置本面板临时展开与输入状态，避免跨标签残留
  useEffect(() => {
    pendingFocusRef.current = false;
    setManuallyOpened(false);
    setCollapsed(false);
    setInlineError(null);
    setFollowUpInput('');
    setPendingAttachments([]);
    setExpandedExecIds({});
    setExpandedHistoryTurnIds({});
    setRememberChoice(false);
    setIsEditingApproval(false);
    setApprovalDraft('');
    setIsHistoryVisible(false);
    setAuditOpen(false);
  }, [sessionId]);

  // 外部请求打开（点击工具栏 AI 按钮 / 终端 @ai）时自动展开停靠面板
  useEffect(() => {
    if (openToken !== lastOpenTokenRef.current) {
      lastOpenTokenRef.current = openToken;
      setDismissedTaskId(null);
      setCollapsed(false);
      setManuallyOpened(true);
      setIsHistoryVisible(false);
      setInlineError(null);
    }
  }, [openToken]);

  // 工具栏点击 AI 按钮或粘贴到 AI 时标记聚焦意图（等卡片挂载且展开后稳定聚焦，避免首帧竞态）
  useEffect(() => {
    if (focusInputToken !== lastFocusTokenRef.current) {
      lastFocusTokenRef.current = focusInputToken;
      requestInputFocus();
    }
  }, [focusInputToken]);

  // 卡片实际展开渲染完成后兑现待聚焦请求
  useEffect(() => {
    if (!pendingFocusRef.current || !shouldShow || collapsed || isHistoryVisible) {
      return;
    }
    requestInputFocus();
  }, [shouldShow, collapsed, isHistoryVisible, openToken, focusInputToken]);

  // 用户点击终端区域时，仅在卡片当前可见且展开态下自动缩小为顶部状态胶囊
  useEffect(() => {
    if (collapseToken !== lastCollapseTokenRef.current) {
      lastCollapseTokenRef.current = collapseToken;
      if (shouldShow && !collapsed) {
        pendingFocusRef.current = false;
        setCollapsed(true);
      }
    }
  }, [collapseToken, shouldShow, collapsed]);

  // 终端右键「粘贴到 AI 助手」带入草稿并聚焦输入框
  useEffect(() => {
    if (!pastedDraft || pastedDraft.id === lastPastedDraftIdRef.current) return;
    lastPastedDraftIdRef.current = pastedDraft.id;
    setDismissedTaskId(null);
    setCollapsed(false);
    setManuallyOpened(true);
    setIsHistoryVisible(false);
    setInlineError(null);
    setFollowUpInput((prev) => (prev ? `${prev}\n${pastedDraft.text}` : pastedDraft.text));
    requestInputFocus();
  }, [pastedDraft]);

  useEffect(() => {
    setDismissedTaskId((prev) => (taskId && prev && prev !== taskId ? null : prev));
    setExpandedExecIds({});
    setRememberChoice(false);
    setIsEditingApproval(false);
    setApprovalDraft('');
    setInlineError(null);
  }, [taskId]);

  useEffect(() => {
    setIsEditingApproval(false);
    setApprovalDraft('');
    setRememberChoice(false);
  }, [taskApproval?.command]);

  useEffect(() => {
    if (taskApproval || taskQuestion || taskTerminalPrompt) {
      setDismissedTaskId(null);
      setCollapsed(false);
    }
  }, [taskApproval, taskQuestion, taskTerminalPrompt]);

  // 提问到达时自动聚焦底部输入框，方便直接回车回复
  useEffect(() => {
    if (taskQuestion && !collapsed) {
      requestInputFocus();
    }
  }, [taskQuestion, collapsed]);

  // 自适应 textarea 高度（单行起步，最高 ~96px）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [followUpInput, collapsed]);

  // 运行计时器
  useEffect(() => {
    if (!task) {
      setElapsedSeconds(0);
      return;
    }
    const compute = () => {
      const end = isRunning ? Date.now() : (task.endTime || Date.now());
      setElapsedSeconds(Math.max(0, Math.floor((end - task.startTime) / 1000)));
    };
    compute();
    if (!isRunning) return;
    const timer = window.setInterval(compute, 1000);
    return () => window.clearInterval(timer);
  }, [task, isRunning]);

  // 当前会话的历史对话列表（汇总所有历史任务）
  const conversationSummaries = useMemo<AgentConversationSummary[]>(() => {
    const conversationMap = new Map<string, AgentTask[]>();
    for (const item of taskHistory) {
      const convId = getTaskConversationId(item);
      const list = conversationMap.get(convId) || [];
      list.push(item);
      conversationMap.set(convId, list);
    }
    return Array.from(conversationMap.entries())
      .map(([id, list]) => {
        const sorted = sortTasksAscending(list);
        const latestTask = sorted[sorted.length - 1];
        return {
          id,
          title: sorted[0]?.userInput || t('agent.conversation.untitled'),
          taskCount: sorted.length,
          updatedAt: latestTask?.endTime || latestTask?.startTime || 0,
          latestTask,
        };
      })
      .filter((conv): conv is AgentConversationSummary => Boolean(conv.latestTask))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [taskHistory, t]);

  // 当前对话内的历史轮次（不含 currentTask，按时间升序）
  const previousConversationTasks = useMemo(() => {
    return sortTasksAscending(
      taskHistory.filter((item) => (
        getTaskConversationId(item) === activeConversationId
        && item.id !== task?.id
      )),
    );
  }, [taskHistory, activeConversationId, task?.id]);

  // 当前任务的命令执行时间线
  const commandTimeline = useMemo(
    () => (task ? buildCommandTimeline(task) : []),
    [task],
  );

  const latestThought = useMemo(() => {
    if (!task || !isRunning) return null;
    for (let i = task.thinkingSteps.length - 1; i >= 0; i -= 1) {
      const step = task.thinkingSteps[i];
      if (step.type !== 'execution' && step.content.trim()) {
        return step.content.trim();
      }
    }
    return null;
  }, [task, isRunning]);

  // 追踪用户是否停留在底部附近：向上翻阅历史时不强行拉回底部
  const isNearBottomRef = useRef(true);
  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  // 内容更新时平滑滚动到底部（审批/提问/新任务到达时始终滚底）
  const stepCount = task?.thinkingSteps.length ?? 0;
  const execCount = task?.executions.length ?? 0;
  const finishReason = task?.finishReason ?? '';
  useEffect(() => {
    if (collapsed || isHistoryVisible) return;
    const el = bodyRef.current;
    if (!el) return;
    if (isNearBottomRef.current || Boolean(taskApproval) || Boolean(taskQuestion)) {
      el.scrollTop = el.scrollHeight;
      isNearBottomRef.current = true;
    }
  }, [
    collapsed,
    isHistoryVisible,
    previousConversationTasks.length,
    stepCount,
    execCount,
    finishReason,
    taskApproval,
    taskQuestion,
    agentState,
  ]);

  // 审批卡片的风险分析（支持审批前编辑命令并实时重评风险）
  const effectiveApprovalCommand = (isEditingApproval ? approvalDraft : taskApproval?.command) ?? '';
  const approvalRiskMeta = useMemo(() => {
    if (!effectiveApprovalCommand) {
      return { className: '', reason: '', riskLevel: 'low' as const, description: null as string | null };
    }
    const analysis = analyzeCommandRisk(effectiveApprovalCommand);
    const className = analysis.riskLevel === 'critical'
      ? 'border-[color-mix(in_srgb,var(--danger)_45%,var(--border-color))] text-danger-fg bg-surface'
      : analysis.riskLevel === 'high'
        ? 'border-[color-mix(in_srgb,var(--accent-strong)_45%,var(--border-color))] text-accent-strong bg-surface'
        : analysis.riskLevel === 'medium'
          ? 'border-[color-mix(in_srgb,var(--warning)_45%,var(--border-color))] text-warning-fg bg-surface'
          : 'border-[color-mix(in_srgb,var(--success)_45%,var(--border-color))] text-success-fg bg-surface';
    return {
      className,
      reason: (analysis.reasons ?? []).slice(0, 2).join('；'),
      riskLevel: analysis.riskLevel,
      description: getCommandDescription(effectiveApprovalCommand),
    };
  }, [effectiveApprovalCommand]);

  const approvalDraftEdited = Boolean(
    approvalDraft.trim() && approvalDraft.trim() !== (taskApproval?.command ?? '').trim(),
  );

  if (!shouldShow || !sessionId) {
    return null;
  }

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // 忽略剪贴板限制
    }
  };

  const handleApprove = (decision: 'approved' | 'rejected') => {
    if (!taskApproval) return;
    const edited = approvalDraft.trim();
    const finalCommand = (isEditingApproval && edited) ? edited : taskApproval.command;
    const finalRisk = (isEditingApproval && edited)
      ? analyzeCommandRisk(edited).riskLevel
      : taskApproval.riskLevel;

    if (finalCommand && finalCommand !== taskApproval.command) {
      setPendingApproval({ command: finalCommand, riskLevel: finalRisk });
    }
    if (rememberChoice && isRememberableRisk(finalRisk)) {
      rememberCommandDecision(finalCommand, finalRisk, decision);
    }
    setIsEditingApproval(false);
    setApprovalDraft('');
    setRememberChoice(false);
    setApprovalResult(decision);
  };

  const handlePauseToggle = () => {
    if (!task) return;
    if (isPaused) {
      void window.electronAPI?.agentResumeTask?.();
      resumeTask();
    } else {
      void window.electronAPI?.agentPauseTask?.(task.connectionId || sessionId);
      pauseTask();
    }
  };

  const handleRetryTask = (targetTask: AgentTask) => {
    if (isRunning || taskApproval || taskQuestion || taskTerminalPrompt) {
      setInlineError(t('agent.errors.taskRunning'));
      return;
    }
    setIsHistoryVisible(false);
    setInlineError(null);
    onClearNotice();
    resetAgent();
    window.setTimeout(() => startTask(targetTask.userInput, sessionId), 0);
  };

  const handleNewConversation = () => {
    if (isRunning || taskApproval || taskQuestion || taskTerminalPrompt) return;
    startNewConversation();
    setIsHistoryVisible(false);
    setAuditOpen(false);
    setFollowUpInput('');
    setPendingAttachments([]);
    setInlineError(null);
    onClearNotice();
    setDismissedTaskId(null);
    setManuallyOpened(true);
    setCollapsed(false);
    requestInputFocus();
  };

  const handleSelectConversation = (conversationId: string) => {
    if (isRunning) {
      setInlineError(t('agent.errors.taskRunning'));
      return;
    }
    selectConversation(conversationId);
    setIsHistoryVisible(false);
    setInlineError(null);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (isRunning && conversationId === activeConversationId) {
      setInlineError(t('agent.errors.taskRunning'));
      return;
    }
    const tasksToDelete = taskHistory.filter((item) => getTaskConversationId(item) === conversationId);
    for (const item of tasksToDelete) {
      const result = await window.electronAPI?.deleteAgentTaskHistory?.(item.id);
      if (result && !result.success) {
        setInlineError(result.error);
        return;
      }
      removeTaskFromHistory(item.id);
    }
    if (conversationId === activeConversationId) {
      startNewConversation();
    }
    setInlineError(null);
  };

  const handleToggleAudit = async () => {
    const next = !auditOpen;
    setAuditOpen(next);
    if (!next) return;
    setIsHistoryVisible(false);
    const api = window.electronAPI?.getAgentAudit;
    if (!api || !sessionId) {
      setAuditRecords([]);
      return;
    }
    setAuditLoading(true);
    try {
      const result = await api(sessionId);
      setAuditRecords(result.success && result.data ? result.data.records : []);
    } catch {
      setAuditRecords([]);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleAttachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const api = window.electronAPI?.uploadAgentAttachment;
    if (!api) {
      setInlineError(t('agent.attach.unsupported'));
      return;
    }
    setAttachmentBusy(true);
    try {
      let currentCount = pendingAttachments.length;
      for (const file of Array.from(files)) {
        if (currentCount >= 8) {
          setInlineError(t('agent.attach.tooMany'));
          break;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const dataBase64 = dataUrl.split(',')[1] || '';
        const result = await api({ name: file.name, type: file.type || 'text/plain', dataBase64 });
        if (!result.success || !result.data) {
          setInlineError(!result.success ? result.error : t('agent.attach.failed'));
          break;
        }
        currentCount += 1;
        setPendingAttachments((previous) => [...previous, result.data!]);
      }
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : t('agent.attach.failed'));
    } finally {
      setAttachmentBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFollowUpSubmit = () => {
    const trimmed = followUpInput.trim();
    if (!trimmed) return;
    if (taskApproval) {
      setInlineError(t('agent.errors.useApprovalButtons'));
      return;
    }
    setInlineError(null);
    onClearNotice();
    const result = submitAgentInput(trimmed, sessionId, pendingAttachments);
    if (result.ok) {
      setFollowUpInput('');
      setPendingAttachments([]);
      setIsHistoryVisible(false);
      setDismissedTaskId(null);
      setCollapsed(false);
      return;
    }
    const errorKeys: Record<AgentSubmissionError, string> = {
      empty: 'terminal.agentInputEmpty',
      disabled: 'agent.errors.disabled',
      noProvider: 'agent.errors.noProvider',
      noConnection: 'agent.errors.noConnection',
      taskRunning: 'agent.errors.taskRunning',
      approvalResponseRequired: 'terminal.agentApprovalReplyRequired',
      wrongSession: 'agent.errors.wrongSession',
    };
    setInlineError(t(errorKeys[result.error]));
  };

  const handleDismiss = () => {
    if (taskId) {
      setDismissedTaskId(taskId);
    }
    setManuallyOpened(false);
    setIsHistoryVisible(false);
    setAuditOpen(false);
    setInlineError(null);
    onClearNotice();
    onFocusTerminal();
  };

  const badge = task
    ? statusBadgeMeta(agentState, interrupted, Boolean(taskApproval), Boolean(taskQuestion), t)
    : null;

  const finalAnswer = task && !isRunning && !interrupted && agentState !== 'error'
    ? (task.finishReason || t('agent.states.finished'))
    : null;
  const errorText = task && agentState === 'error'
    ? (task.error || task.finishReason || t('agent.states.error'))
    : null;

  const latestPrevTask = previousConversationTasks[previousConversationTasks.length - 1] ?? null;
  const collapsedSummary = taskApproval
    ? `${t('terminal.agentStatusAwaitingApproval')}: ${taskApproval.command}`
    : taskQuestion
      ? taskQuestion
      : finalAnswer
        ? finalAnswer.replace(/\s+/g, ' ').slice(0, 80)
        : errorText
          ? errorText
          : task?.userInput
            || latestPrevTask?.userInput
            || notice?.message
            || t('terminal.agentDock.title');

  const renderCommandTimeline = (items: CommandTimelineItem[], keyPrefix: string) => (
    <div className="space-y-1.5">
      {items.map((item) => {
        const execKey = `${keyPrefix}-${item.id}`;
        const expanded = Boolean(expandedExecIds[execKey]);
        const hasOutput = Boolean(item.execution?.output?.trim());
        const copied = copiedKey === `cmd-${execKey}`;
        return (
          <div key={execKey} className="terminal-agent-step-row">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <button
                type="button"
                disabled={!hasOutput}
                aria-expanded={hasOutput ? expanded : undefined}
                onClick={() => {
                  if (!hasOutput) return;
                  setExpandedExecIds((prev) => ({ ...prev, [execKey]: !prev[execKey] }));
                }}
                className={`flex min-w-0 flex-1 items-center gap-2 text-left ${hasOutput ? 'cursor-pointer' : 'cursor-default'}`}
              >
                {item.status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                ) : item.status === 'failed' ? (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                )}
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-secondary" title={item.command}>
                  $ {item.command}
                </code>
                {item.execution?.exitCode != null && (
                  <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${
                    item.status === 'failed'
                      ? 'bg-danger-muted text-danger-fg'
                      : 'bg-surface-raised text-fg-muted'
                  }`}>
                    exit {item.execution.exitCode}
                  </span>
                )}
                {item.durationLabel && (
                  <span className="shrink-0 font-mono text-[10px] text-fg-subtle tabular-nums">
                    {item.durationLabel}
                  </span>
                )}
                {hasOutput && (
                  expanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void copyText(`cmd-${execKey}`, item.command)}
                className="icon-button h-6 w-6 shrink-0"
                title={t('common.copy')}
                aria-label={t('common.copy')}
              >
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
            {expanded && hasOutput && (
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all border-t border-line-subtle bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-4 text-fg-muted scrollbar-thin">
                {item.execution?.output}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );

  const canStartNew = !isRunning && !taskApproval && !taskQuestion && !taskTerminalPrompt;
  const hasConversationTurns = previousConversationTasks.length > 0 || Boolean(task);

  return (
    <section
      className={`terminal-agent-dock ${collapsed ? 'terminal-agent-dock-collapsed' : ''}`}
      data-terminal-agent-dock
      aria-label={t('terminal.agentDock.title')}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {/* 顶部栏（收起态下点击头部即可向下展开并聚焦输入框） */}
      <div
        className={`terminal-agent-dock-header ${collapsed ? 'cursor-pointer' : ''}`}
        onClick={() => {
          if (collapsed) {
            setCollapsed(false);
            requestInputFocus();
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-accent bg-accent-muted text-accent">
            <Bot className="h-3.5 w-3.5" />
          </span>
          <span className="shrink-0 text-xs font-semibold text-fg">
            {t('terminal.agentDock.title')}
          </span>
          {badge && (
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${badge.toneClass}`}>
              {badge.spinning && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
              {badge.label}
            </span>
          )}
          {task && (
            <span className="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
              {elapsedSeconds}s
            </span>
          )}
          {!collapsed && (
            <span className="agent-dock-meta-provider min-w-0 max-w-[160px] items-center gap-1 truncate rounded-sm border border-line-subtle bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-fg-muted" title={activeProvider ? activeProvider.name : t('aiProvider.noProviders')}>
              <PlugZap className="h-3 w-3 shrink-0 text-accent" />
              <span className="truncate">{activeProvider ? activeProvider.name : t('aiProvider.noProviders')}</span>
            </span>
          )}
          {commandTimeline.length > 0 && !collapsed && (
            <span className="agent-dock-meta-commands shrink-0 rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
              {t('terminal.agentDock.commandCount', { count: commandTimeline.length })}
            </span>
          )}
          {!collapsed && (task?.tokenUsage ?? 0) > 0 && (
            <span className="agent-dock-meta-tokens shrink-0 rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-muted" title={t('agent.task.tokenUsage')}>
              {t('agent.task.tokens', { count: task?.tokenUsage ?? 0 })}
            </span>
          )}
          {collapsed && (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={collapsedSummary}>
              {collapsedSummary}
            </span>
          )}
        </div>

        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          {isRunning && (
            <>
              <button
                type="button"
                onClick={handlePauseToggle}
                className="icon-button h-6 w-6"
                title={isPaused ? t('agent.actions.resume') : t('agent.actions.pause')}
                aria-label={isPaused ? t('agent.actions.resume') : t('agent.actions.pause')}
              >
                {isPaused ? <Play className="h-3.5 w-3.5 text-accent" /> : <Pause className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={onInterruptTask}
                className="icon-button h-6 w-6 hover:text-danger"
                title={t('agent.actions.cancel')}
                aria-label={t('agent.actions.cancel')}
              >
                <Square className="h-3 w-3" />
              </button>
            </>
          )}
          {!collapsed && (
            <>
              <button
                type="button"
                onClick={handleNewConversation}
                disabled={!canStartNew}
                className="icon-button h-6 w-6 disabled:opacity-40"
                title={t('agent.actions.newConversation')}
                aria-label={t('agent.actions.newConversation')}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsHistoryVisible((prev) => !prev);
                  setAuditOpen(false);
                }}
                disabled={conversationSummaries.length === 0}
                className={`inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] transition-colors disabled:opacity-40 ${
                  isHistoryVisible
                    ? 'bg-accent-muted text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                }`}
                title={isHistoryVisible ? t('agent.actions.hideHistory') : t('agent.actions.viewHistory')}
                aria-label={isHistoryVisible ? t('agent.actions.hideHistory') : t('agent.actions.viewHistory')}
              >
                <History className="h-3.5 w-3.5" />
                {conversationSummaries.length > 0 && (
                  <span className="font-mono text-[10px] tabular-nums">{conversationSummaries.length}</span>
                )}
              </button>
              {window.electronAPI?.getAgentAudit && (
                <button
                  type="button"
                  onClick={() => void handleToggleAudit()}
                  className={`icon-button h-6 w-6 ${auditOpen ? 'bg-accent-muted text-accent' : ''}`}
                  title={t('agent.audit.title')}
                  aria-label={t('agent.audit.title')}
                >
                  <ScrollText className="h-3.5 w-3.5" />
                </button>
              )}
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="icon-button h-6 w-6"
                  title={t('settings.tabs.providers')}
                  aria-label={t('settings.tabs.providers')}
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setCollapsed((prev) => {
                const next = !prev;
                if (!next) requestInputFocus();
                return next;
              });
            }}
            className="icon-button h-6 w-6"
            title={collapsed ? t('terminal.agentDock.expand') : t('terminal.agentDock.collapse')}
            aria-label={collapsed ? t('terminal.agentDock.expand') : t('terminal.agentDock.collapse')}
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="icon-button h-6 w-6"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 主体内容区（顶部停靠向下展开） */}
      {!collapsed && (
        <>
          <div ref={bodyRef} onScroll={handleBodyScroll} className="terminal-agent-dock-body scrollbar-thin">
            {/* 工具调用审计抽屉 */}
            {auditOpen && (
              <div className="rounded-md border border-line bg-surface-sunken px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-fg-secondary">{t('agent.audit.title')}</span>
                  <button
                    type="button"
                    onClick={() => setAuditOpen(false)}
                    className="icon-button h-5 w-5"
                    aria-label={t('common.close')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {auditLoading ? (
                  <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('common.loading')}
                  </p>
                ) : auditRecords.length === 0 ? (
                  <p className="text-xs text-fg-muted">{t('agent.audit.empty')}</p>
                ) : (
                  <ul className="max-h-40 space-y-1 overflow-y-auto scrollbar-thin">
                    {auditRecords.slice().reverse().map((record, index) => (
                      <li key={`${record.at}-${index}`} className="flex items-center gap-2 text-xs text-fg">
                        <span className="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
                          {new Date(record.at).toLocaleTimeString()}
                        </span>
                        <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[11px]">{record.tool}</span>
                        {record.path && (
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-secondary">
                            {record.path}
                          </span>
                        )}
                        {record.write && (
                          <span className="shrink-0 rounded-sm bg-warning-muted px-1 text-[10px] text-warning-fg">
                            {t('agent.audit.write')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* 历史对话切换列表 */}
            {isHistoryVisible && conversationSummaries.length > 0 && (
              <div className="space-y-2">
                {conversationSummaries.map((conversation) => {
                  const isActive = conversation.id === activeConversationId;
                  const latest = conversation.latestTask;
                  const preview = latest.finishReason || latest.error || t('agent.conversation.taskCompleted');
                  return (
                    <div
                      key={conversation.id}
                      className={`flex items-start gap-2 rounded-md border p-2.5 transition-colors ${
                        isActive
                          ? 'border-accent bg-accent-muted'
                          : 'border-line-subtle bg-surface-sunken hover:border-line'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectConversation(conversation.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-fg-muted">
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Clock className="h-3 w-3" />
                            {formatTaskDuration(latest)}
                          </span>
                          <span>{t('agent.conversation.rounds', { count: conversation.taskCount })}</span>
                        </div>
                        <p className="mt-1 truncate text-xs font-semibold text-fg">
                          {conversation.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-fg-muted">
                          {preview}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteConversation(conversation.id)}
                        className="icon-button h-6 w-6 shrink-0 hover:text-danger"
                        title={t('agent.actions.deleteHistory')}
                        aria-label={t('agent.actions.deleteHistory')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 对话主体 */}
            {!isHistoryVisible && (
              <>
                {/* 空白待命提示 */}
                {!hasConversationTurns && !notice && !inlineError && (
                  <div className="rounded-sm border border-line-subtle bg-surface-sunken px-3 py-2.5 text-xs leading-5 text-fg-muted">
                    {t('terminal.agentDock.emptyHint')}
                  </div>
                )}

                {/* 当前对话的历史轮次 */}
                {previousConversationTasks.map((prevTask) => {
                  const prevTimeline = buildCommandTimeline(prevTask);
                  const prevStepsOpen = Boolean(expandedHistoryTurnIds[prevTask.id]);
                  const prevAnswer = prevTask.finishReason || prevTask.error || t('agent.conversation.taskCompleted');
                  return (
                    <div key={prevTask.id} className="space-y-2 border-b border-line-subtle pb-3">
                      <div className="flex items-start gap-2 rounded-sm border border-line-subtle bg-surface-sunken px-2.5 py-1.5">
                        <span className="mt-0.5 shrink-0 rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fg-muted">
                          @ai
                        </span>
                        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs font-medium leading-5 text-fg-secondary">
                          {prevTask.userInput}
                        </p>
                        <span className="shrink-0 font-mono text-[10px] text-fg-subtle tabular-nums">
                          {formatTaskDuration(prevTask)}
                        </span>
                      </div>

                      {prevTimeline.length > 0 && (
                        <div className="space-y-1.5">
                          <button
                            type="button"
                            onClick={() => setExpandedHistoryTurnIds((prev) => ({ ...prev, [prevTask.id]: !prev[prevTask.id] }))}
                            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                          >
                            {prevStepsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            <span>{t('terminal.agentDock.commandCount', { count: prevTimeline.length })}</span>
                          </button>
                          {prevStepsOpen && renderCommandTimeline(prevTimeline, prevTask.id)}
                        </div>
                      )}

                      <div className="terminal-agent-answer-card">
                        <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-line-subtle pb-1">
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
                            {prevTask.state === 'error'
                              ? <XCircle className="h-3 w-3 text-danger" />
                              : <CheckCircle2 className="h-3 w-3 text-success" />}
                            {t('terminal.agentDock.answerTitle')}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleRetryTask(prevTask)}
                              disabled={isRunning}
                              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>{t('common.retry')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void copyText(`prev-${prevTask.id}`, prevAnswer)}
                              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                            >
                              {copiedKey === `prev-${prevTask.id}` ? (
                                <>
                                  <Check className="h-3 w-3 text-success" />
                                  <span>{t('terminal.agentDock.copied')}</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  <span>{t('common.copy')}</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                        <AgentMarkdownView
                          content={prevAnswer}
                          onInsertCommand={onInsertCommand}
                          copyLabel={t('common.copy')}
                          copiedLabel={t('terminal.agentDock.copied')}
                          insertLabel={t('terminal.agentDock.insertToTerminal')}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* 当前任务问题摘要 */}
                {task?.userInput && (
                  <div className="flex items-start gap-2 rounded-sm border border-line-subtle bg-surface-sunken px-2.5 py-2">
                    <span className="mt-0.5 shrink-0 rounded-sm bg-accent-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent">
                      @ai
                    </span>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs font-medium leading-5 text-fg">
                      {task.userInput}
                    </p>
                  </div>
                )}

                {/* 当前任务命令执行时间线 */}
                {commandTimeline.length > 0 && renderCommandTimeline(commandTimeline, task?.id || 'current')}

                {/* 运行中实时思考提示 */}
                {isRunning && !taskApproval && !taskQuestion && !taskTerminalPrompt && (
                  <div className="flex items-start gap-2 rounded-sm border border-line-subtle bg-[color-mix(in_srgb,var(--bg-secondary)_75%,transparent)] px-3 py-2 text-xs text-fg-muted">
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                    <span className="min-w-0 flex-1 line-clamp-3 whitespace-pre-wrap break-words">
                      {latestThought || t(`agent.states.${agentState}`)}
                    </span>
                  </div>
                )}

                {/* 危险命令审批卡片（支持审批前编辑命令、实时风险原因与记住本次选择） */}
                {taskApproval && (
                  <div className="space-y-2.5 rounded-md border border-warning bg-warning-muted p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-warning-fg">
                        <ShieldAlert className="h-4 w-4 shrink-0" />
                        {t('terminal.agentDock.approvalTitle')}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${approvalRiskMeta.className}`}>
                        {t(`commandApproval.riskLevels.${approvalRiskMeta.riskLevel}`)}
                      </span>
                    </div>

                    {isEditingApproval ? (
                      <div className="space-y-1">
                        <textarea
                          value={approvalDraft}
                          onChange={(event) => setApprovalDraft(event.target.value)}
                          rows={3}
                          spellCheck={false}
                          className="industrial-input w-full font-mono text-xs"
                          aria-label={t('agent.approval.edit')}
                        />
                        <p className="text-[11px] leading-4 text-fg-muted">{t('agent.approval.editHint')}</p>
                      </div>
                    ) : (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-sunken px-2.5 py-2 font-mono text-xs text-fg">
                        {effectiveApprovalCommand}
                      </pre>
                    )}

                    {approvalRiskMeta.description && (
                      <p className="text-xs leading-5 text-fg-secondary">{approvalRiskMeta.description}</p>
                    )}
                    {approvalRiskMeta.reason && (
                      <p className="text-xs leading-5 text-warning-fg">{approvalRiskMeta.reason}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      {!isEditingApproval ? (
                        <button
                          type="button"
                          onClick={() => {
                            setApprovalDraft(taskApproval.command);
                            setIsEditingApproval(true);
                          }}
                          className="text-accent underline decoration-[color-mix(in_srgb,var(--accent-primary)_45%,transparent)] underline-offset-2 hover:text-accent-hover"
                        >
                          {t('agent.approval.edit')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setApprovalDraft(taskApproval.command);
                            setIsEditingApproval(false);
                          }}
                          className="text-fg-secondary underline underline-offset-2 hover:text-fg"
                        >
                          {approvalDraftEdited ? t('agent.approval.resetEdit') : t('common.cancel')}
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      {isRememberableRisk(approvalRiskMeta.riskLevel) ? (
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg-secondary">
                          <input
                            type="checkbox"
                            checked={rememberChoice}
                            onChange={(event) => setRememberChoice(event.target.checked)}
                          />
                          <Save className="h-3 w-3 text-fg-muted" />
                          <span>{t('commandApproval.rememberChoice')}</span>
                        </label>
                      ) : (
                        <span className="text-[11px] text-fg-muted">{t('commandApproval.criticalCannotRemember')}</span>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleApprove('rejected')}
                          className="industrial-button-secondary px-3 py-1 text-xs"
                        >
                          {t('agent.approval.reject')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApprove('approved')}
                          className="industrial-button-primary px-3 py-1 text-xs"
                        >
                          {t('agent.approval.approve')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* 终端交互提示 */}
                {taskTerminalPrompt && (
                  <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-muted px-3 py-2 text-xs text-warning-fg">
                    <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">
                      {t('agent.task.terminalWaitingHint', { prompt: taskTerminalPrompt })}
                    </span>
                  </div>
                )}

                {/* AI 向用户提问卡片 */}
                {taskQuestion && (
                  <div className="rounded-md border border-info bg-info-muted px-3 py-2.5 text-xs leading-5 text-fg">
                    <div className="mb-1 font-semibold text-info-fg">
                      {t('terminal.agentDock.questionTitle')}
                    </div>
                    <AgentMarkdownView
                      content={taskQuestion}
                      onInsertCommand={onInsertCommand}
                      copyLabel={t('common.copy')}
                      copiedLabel={t('terminal.agentDock.copied')}
                      insertLabel={t('terminal.agentDock.insertToTerminal')}
                    />
                  </div>
                )}

                {/* 最终 Markdown 回复 */}
                {finalAnswer && task && (
                  <div className="terminal-agent-answer-card">
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-line-subtle pb-1.5">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-success-fg">
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                        {t('terminal.agentDock.answerTitle')}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleRetryTask(task)}
                          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>{t('common.retry')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyText('answer', finalAnswer)}
                          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                        >
                          {copiedKey === 'answer' ? (
                            <>
                              <Check className="h-3 w-3 text-success" />
                              <span>{t('terminal.agentDock.copied')}</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>{t('common.copy')}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    <AgentMarkdownView
                      content={finalAnswer}
                      onInsertCommand={onInsertCommand}
                      copyLabel={t('common.copy')}
                      copiedLabel={t('terminal.agentDock.copied')}
                      insertLabel={t('terminal.agentDock.insertToTerminal')}
                    />
                  </div>
                )}

                {/* 被中断提示 */}
                {task && !isRunning && interrupted && (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-warning bg-warning-muted px-3 py-2 text-xs text-warning-fg">
                    <span>{t('terminal.agentInterrupted')}</span>
                    <button
                      type="button"
                      onClick={() => handleRetryTask(task)}
                      className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 text-[11px] font-medium text-fg hover:bg-surface-hover"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('common.retry')}
                    </button>
                  </div>
                )}

                {/* 错误卡片 */}
                {errorText && !interrupted && task && (
                  <div className="flex items-start justify-between gap-3 rounded-md border border-danger bg-danger-muted px-3 py-2.5 text-xs text-danger-fg">
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{errorText}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRetryTask(task)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 text-[11px] font-medium text-fg hover:bg-surface-hover"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('common.retry')}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* 轻量提示 / 提交校验错误 */}
            {(inlineError || notice) && (
              <div className={`rounded-sm border px-3 py-2 text-xs ${
                (inlineError || notice?.tone === 'error')
                  ? 'border-danger bg-danger-muted text-danger-fg'
                  : 'border-accent bg-accent-muted text-fg'
              }`}>
                {inlineError || notice?.message}
              </div>
            )}
          </div>

          {/* 底部输入栏（支持多行 Shift+Enter、附件上传与一键发送） */}
          <form
            className="terminal-agent-dock-footer"
            onSubmit={(event) => {
              event.preventDefault();
              handleFollowUpSubmit();
            }}
          >
            {pendingAttachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pendingAttachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-[200px] items-center gap-1 rounded-sm border border-line bg-surface px-1.5 py-0.5 text-[11px] text-fg-secondary"
                  >
                    <Paperclip className="h-3 w-3 shrink-0 text-fg-subtle" />
                    <span className="truncate">{attachment.name}</span>
                    <button
                      type="button"
                      onClick={() => setPendingAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                      className="ml-0.5 shrink-0 text-fg-subtle hover:text-fg"
                      aria-label={t('common.close')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
                className="hidden"
                onChange={(event) => void handleAttachFiles(event.target.files)}
              />
              {window.electronAPI?.uploadAgentAttachment && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={attachmentBusy || (isRunning && !taskQuestion) || Boolean(taskApproval)}
                  className="industrial-button-secondary h-8 w-8 shrink-0 px-0 py-0"
                  title={t('agent.attach.title')}
                  aria-label={t('agent.attach.title')}
                >
                  {attachmentBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                </button>
              )}
              <textarea
                ref={inputRef}
                rows={1}
                value={followUpInput}
                onChange={(event) => {
                  setFollowUpInput(event.target.value);
                  if (inlineError) setInlineError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    handleFollowUpSubmit();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (isRunning) {
                      onInterruptTask();
                    } else {
                      setCollapsed(true);
                      onFocusTerminal();
                    }
                  }
                }}
                placeholder={
                  taskQuestion
                    ? t('terminal.agentDock.answerPlaceholder')
                    : t('terminal.agentDock.followUpPlaceholder')
                }
                className="industrial-input min-h-[32px] max-h-24 min-w-0 flex-1 resize-none py-1.5 text-xs leading-5"
                disabled={isRunning && !taskQuestion}
              />
              <button
                type="submit"
                disabled={!followUpInput.trim() || (isRunning && !taskQuestion) || Boolean(taskApproval)}
                className="industrial-button-primary h-8 shrink-0 px-3 py-1 text-xs"
              >
                {isRunning && !taskQuestion ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                <span>{t('terminal.agentDock.send')}</span>
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
