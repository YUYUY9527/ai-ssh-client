import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Clock, History, Loader2, MessageCircle, Pause, Play, PlugZap, RotateCcw, Save, Send, Settings, ShieldAlert, Terminal, Trash2, User, X, XCircle } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { useAgentStore } from '../store/useAgentStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { rememberRiskDecision } from '../assistant/risk-approval-memory';
import { useSessionStore } from '../session/useSessionStore';
import { COMMAND_DESCRIPTIONS } from '../../shared/constants';
import { useI18n, t } from '../i18n';
import type { AgentTask, ThinkingStep } from '../../shared/types';

const AgentExecutor = lazy(async () => {
  const module = await import('./AgentExecutor');
  return { default: module.AgentExecutor };
});

/** 小机器人头像(纯 CSS 绘制,和右下角按钮同款) */
function RobotFaceMini({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const isSm = size === 'sm';
  return (
    <span className={`robot-face-mini ${isSm ? 'robot-face-mini-sm' : ''}`}>
      <span className="robot-face-mini-ear robot-face-mini-ear-left" />
      <span className="robot-face-mini-ear robot-face-mini-ear-right" />
      <span className="robot-face-mini-antenna" />
      <span className="robot-face-mini-eye robot-face-mini-eye-left" />
      <span className="robot-face-mini-eye robot-face-mini-eye-right" />
      <span className="robot-face-mini-mouth" />
    </span>
  );
}

interface AgentPetProps {
  input: string;
  onInputChange: (value: string) => void;
  focusInputToken: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}

interface PetPosition {
  x: number;
  y: number;
}

interface PetDragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  hasLongPressed: boolean;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface AgentConversationSummary {
  id: string;
  title: string;
  taskCount: number;
  updatedAt: number;
  latestTask: AgentTask;
}

const PET_BUTTON_SIZE = 56;
const PET_DEFAULT_RIGHT = 20;
const PET_DEFAULT_BOTTOM = 48;
const PET_EDGE_PADDING = 12;
const PET_LONG_PRESS_MS = 360;
const PET_MOVE_CANCEL_THRESHOLD = 8;
const PET_PANEL_GAP = 16;
const PET_PANEL_EDGE_PADDING = 16;
const PET_PANEL_MAX_WIDTH = 400;
const PET_PANEL_MAX_HEIGHT = 620;
const PET_PANEL_VERTICAL_RESERVE = 144;
const COMPLETION_BURST_MS = 1200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function getDefaultPetPosition(): PetPosition {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 };
  }

  return {
    x: window.innerWidth - PET_DEFAULT_RIGHT - PET_BUTTON_SIZE,
    y: window.innerHeight - PET_DEFAULT_BOTTOM - PET_BUTTON_SIZE,
  };
}

function getViewportSize(): ViewportSize {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function clampPetPosition(position: PetPosition): PetPosition {
  if (typeof window === 'undefined') {
    return position;
  }

  return {
    x: clamp(position.x, PET_EDGE_PADDING, window.innerWidth - PET_BUTTON_SIZE - PET_EDGE_PADDING),
    y: clamp(position.y, PET_EDGE_PADDING, window.innerHeight - PET_BUTTON_SIZE - PET_EDGE_PADDING),
  };
}

function repositionPetForViewportChange(
  position: PetPosition,
  previousViewport: ViewportSize,
  nextViewport: ViewportSize,
): PetPosition {
  if (previousViewport.width <= 0 || previousViewport.height <= 0) {
    return clampPetPosition(position);
  }

  const distanceToLeft = position.x;
  const distanceToRight = previousViewport.width - position.x - PET_BUTTON_SIZE;
  const distanceToTop = position.y;
  const distanceToBottom = previousViewport.height - position.y - PET_BUTTON_SIZE;

  return clampPetPosition({
    x: distanceToRight < distanceToLeft
      ? nextViewport.width - distanceToRight - PET_BUTTON_SIZE
      : position.x,
    y: distanceToBottom < distanceToTop
      ? nextViewport.height - distanceToBottom - PET_BUTTON_SIZE
      : position.y,
  });
}

function getPetPanelStyle(position: PetPosition): React.CSSProperties {
  if (typeof window === 'undefined') {
    return {};
  }

  const panelWidth = Math.min(PET_PANEL_MAX_WIDTH, window.innerWidth - PET_PANEL_EDGE_PADDING * 2);
  const panelHeight = Math.min(
    PET_PANEL_MAX_HEIGHT,
    window.innerHeight - PET_PANEL_VERTICAL_RESERVE,
  );
  const preferredLeft = position.x + PET_BUTTON_SIZE - panelWidth;
  const left = clamp(
    preferredLeft,
    PET_PANEL_EDGE_PADDING,
    window.innerWidth - panelWidth - PET_PANEL_EDGE_PADDING,
  );
  const topWhenAbove = position.y - panelHeight - PET_PANEL_GAP;
  const shouldPlaceAbove = topWhenAbove >= PET_PANEL_EDGE_PADDING;
  const top = shouldPlaceAbove
    ? topWhenAbove
    : clamp(
      position.y + PET_BUTTON_SIZE + PET_PANEL_GAP,
      PET_PANEL_EDGE_PADDING,
      window.innerHeight - panelHeight - PET_PANEL_EDGE_PADDING,
    );
  const arrowLeft = clamp(
    position.x + PET_BUTTON_SIZE / 2 - left - 8,
    18,
    panelWidth - 34,
  );

  return {
    left: `${left}px`,
    top: `${top}px`,
    '--agent-pet-arrow-left': `${arrowLeft}px`,
    '--agent-pet-arrow-top': shouldPlaceAbove ? 'auto' : '-0.5rem',
    '--agent-pet-arrow-bottom': shouldPlaceAbove ? '-0.5rem' : 'auto',
  } as React.CSSProperties;
}

function getCommandDescription(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const baseCmd = parts[0];

  if (COMMAND_DESCRIPTIONS[command]) {
    return COMMAND_DESCRIPTIONS[command];
  }

  for (let i = parts.length; i >= 1; i -= 1) {
    const partial = parts.slice(0, i).join(' ');
    if (COMMAND_DESCRIPTIONS[partial]) {
      return COMMAND_DESCRIPTIONS[partial];
    }
  }

  return COMMAND_DESCRIPTIONS[baseCmd] || null;
}

function formatDuration(task: AgentTask): string {
  const endTime = task.endTime || Date.now();
  const seconds = Math.max(0, Math.floor((endTime - task.startTime) / 1000));
  return `${seconds}s`;
}

function getStepCommand(step: ThinkingStep): string {
  const match = step.content.match(/命令：(.+?)(?:\n|$)/);
  return match?.[1]?.trim() || step.content.split('\n')[0]?.trim() || t('agent.conversation.executeCommand');
}

function getTaskStatus(task: AgentTask): { label: string; tone: 'running' | 'success' | 'error' | 'idle' } {
  if (task.state === 'finished') return { label: t('agent.conversation.completed'), tone: 'success' };
  if (task.state === 'error') return { label: t('agent.conversation.error'), tone: 'error' };
  if (task.state === 'paused') return { label: t('agent.conversation.paused'), tone: 'idle' };
  return { label: t('agent.conversation.running'), tone: 'running' };
}

function getTaskSummary(task: AgentTask): string {
  if (task.finishReason) return task.finishReason;
  if (task.error) return task.error;

  const latestStep = [...task.thinkingSteps].reverse().find((step) => step.content.trim());
  if (latestStep) return latestStep.content.replace(/\s+/g, ' ').slice(0, 180);

  return task.state === 'finished' ? t('agent.conversation.taskCompleted') : t('agent.conversation.analyzing');
}

function getTaskConversationId(task: AgentTask): string {
  return task.conversationId || task.id;
}

function sortTasksAscending(tasks: AgentTask[]): AgentTask[] {
  return [...tasks].sort((left, right) => left.startTime - right.startTime);
}

function getConversationSummaries(tasks: AgentTask[]): AgentConversationSummary[] {
  const conversationMap = new Map<string, AgentTask[]>();

  for (const task of tasks) {
    const conversationId = getTaskConversationId(task);
    const conversationTasks = conversationMap.get(conversationId) || [];
    conversationTasks.push(task);
    conversationMap.set(conversationId, conversationTasks);
  }

  return Array.from(conversationMap.entries())
    .map(([id, conversationTasks]) => {
      const sortedTasks = sortTasksAscending(conversationTasks);
      const latestTask = sortedTasks[sortedTasks.length - 1];
      return {
        id,
        title: sortedTasks[0]?.userInput || t('agent.conversation.untitled'),
        taskCount: sortedTasks.length,
        updatedAt: latestTask?.endTime || latestTask?.startTime || 0,
        latestTask,
      };
    })
    .filter((conversation): conversation is AgentConversationSummary => Boolean(conversation.latestTask))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function isStaleThinkingPlaceholder(step: ThinkingStep, steps: ThinkingStep[]): boolean {
  if (step.type === 'execution' || step.status !== 'in_progress') return false;
  if (step.content !== t('agent.thinking.analyzing')) return false;

  return steps.some((nextStep) => (
    nextStep.id !== step.id
    && nextStep.timestamp >= step.timestamp
    && nextStep.type === step.type
    && nextStep.status !== 'in_progress'
  ));
}

function AgentThinkingStep({ step }: { step: ThinkingStep }) {
  const [showFull, setShowFull] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const { t } = useI18n();

  // 真实判断内容是否被 line-clamp 截断:对比 scrollHeight 与 clientHeight。
  // 字符长度阈值不靠谱 —— 中文 10 字就能占满 3 行,但 length 只有 10。
  useEffect(() => {
    const el = paragraphRef.current;
    if (!el) return;
    if (showFull) {
      setIsOverflowing(true);
      return;
    }
    const measure = () => {
      if (!paragraphRef.current) return;
      const node = paragraphRef.current;
      setIsOverflowing(node.scrollHeight - node.clientHeight > 1);
    };
    measure();
    // 容器宽度变化可能让 overflow 状态变化
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [step.content, showFull]);

  return (
    <div className={`agent-chat-step ${showFull ? 'agent-chat-step-expanded' : ''}`}>
      <span className="font-medium text-slate-600 dark:text-slate-300">{step.title}</span>
      <p ref={paragraphRef}>{step.content}</p>
      {(isOverflowing || showFull) && (
        <button
          type="button"
          onClick={() => setShowFull(!showFull)}
          className="agent-chat-step-detail-button"
        >
          {showFull ? t('agent.conversation.collapseDetails') : t('agent.conversation.expandDetails')}
        </button>
      )}
    </div>
  );
}

function AgentExecutionStep({ step }: { step: ThinkingStep }) {
  const { t } = useI18n();

  return (
    <div className="agent-chat-step agent-chat-step-execution">
      <span className="font-medium text-slate-600 dark:text-slate-300">
        {step.title || t('agent.conversation.executeCommand')}
      </span>
      <code className="agent-chat-command">
        {getStepCommand(step)}
      </code>
    </div>
  );
}

function AgentTaskConversation({
  task,
  isCurrent,
  onRetry,
}: {
  task: AgentTask;
  isCurrent: boolean;
  onRetry?: (task: AgentTask) => void;
}) {
  const [expanded, setExpanded] = useState(isCurrent && task.state !== 'finished');
  const { t } = useI18n();
  const status = getTaskStatus(task);
  const visibleSteps = task.thinkingSteps.filter((step) => (
    !isStaleThinkingPlaceholder(step, task.thinkingSteps)
  ));
  const commandSteps = visibleSteps.filter((step) => step.type === 'execution');
  const isTaskRunning = task.state !== 'finished' && task.state !== 'error';

  useEffect(() => {
    if (!isCurrent) return;
    setExpanded(isTaskRunning);
  }, [isCurrent, isTaskRunning]);

  return (
    <div className="agent-chat-turn">
      <div className="agent-chat-message agent-chat-message-user">
        <div className="agent-chat-avatar agent-chat-avatar-user">
          <User className="h-4 w-4" />
        </div>
        <div className="agent-chat-bubble agent-chat-bubble-user">
          <p>{task.userInput}</p>
        </div>
      </div>

      <div className="agent-chat-message">
        <div className="agent-chat-avatar agent-chat-avatar-bot">
          <RobotFaceMini size="sm" />
        </div>
        <div className="agent-chat-bubble agent-chat-bubble-bot">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`agent-chat-status agent-chat-status-${status.tone}`}>
              {status.tone === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
              {status.tone === 'success' && <CheckCircle2 className="h-3 w-3" />}
              {status.tone === 'error' && <XCircle className="h-3 w-3" />}
              {status.label}
            </span>
            <span className="agent-chat-meta">
              <Clock className="h-3 w-3" />
              {formatDuration(task)}
            </span>
            {commandSteps.length > 0 && (
              <span className="agent-chat-meta">
                <Terminal className="h-3 w-3" />
                {commandSteps.length} 命令
              </span>
            )}
          </div>

          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-200">
            {getTaskSummary(task)}
          </p>

          {(visibleSteps.length > 0 || onRetry) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {visibleSteps.length > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="agent-chat-detail-toggle"
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {expanded ? t('agent.conversation.collapseProcess') : t('agent.conversation.expandProcess')}
                </button>
              )}
              {onRetry && (
                <button
                  type="button"
                  onClick={() => onRetry(task)}
                  className="agent-chat-detail-toggle"
                  title={t('agent.actions.retry')}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('agent.actions.retry')}
                </button>
              )}
            </div>
          )}

          {expanded && (
            <div className="agent-chat-detail">
              {visibleSteps.map((step) => (
                step.type === 'execution'
                  ? <AgentExecutionStep key={step.id} step={step} />
                  : <AgentThinkingStep key={step.id} step={step} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentHistoryList({
  conversations,
  activeConversationId,
  onSelect,
  onDelete,
}: {
  conversations: AgentConversationSummary[];
  activeConversationId: string;
  onSelect: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="agent-history-list">
      {conversations.map((conversation) => {
        const status = getTaskStatus(conversation.latestTask);
        return (
          <div
            key={conversation.id}
            className={`agent-history-item ${conversation.id === activeConversationId ? 'agent-history-item-active' : ''}`}
          >
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex items-center gap-2">
                <span className={`agent-chat-status agent-chat-status-${status.tone}`}>
                  {status.label}
                </span>
                <span className="agent-chat-meta">
                  <Clock className="h-3 w-3" />
                  {formatDuration(conversation.latestTask)}
                </span>
                <span className="agent-chat-meta">
                  {t('agent.conversation.rounds', { count: conversation.taskCount })}
                </span>
              </div>
              <p className="mt-2 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {conversation.title}
              </p>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                {getTaskSummary(conversation.latestTask)}
              </p>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(conversation.id);
              }}
              className="agent-chat-delete-button"
              title={t('agent.actions.deleteHistory')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function AgentPet({ input, onInputChange, focusInputToken, isOpen, onOpenChange, onOpenSettings }: AgentPetProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dragStateRef = useRef<PetDragState | null>(null);
  const dragLongPressTimerRef = useRef<number | null>(null);
  const completionBurstTimerRef = useRef<number | null>(null);
  const openScrollTimerRef = useRef<number | null>(null);
  const previousAgentStateRef = useRef<string | null>(null);
  const suppressNextToggleRef = useRef(false);
  const viewportSizeRef = useRef<ViewportSize>(getViewportSize());
  const [position, setPosition] = useState<PetPosition>(() => getDefaultPetPosition());
  const [isDraggingPet, setIsDraggingPet] = useState(false);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);
  const [isCompletionBurstVisible, setIsCompletionBurstVisible] = useState(false);
  const [isCompletionViewed, setIsCompletionViewed] = useState(false);
  const shouldAutoScrollRef = useRef(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [rememberApprovalChoice, setRememberApprovalChoice] = useState(false);
  const { providers, activeProviderId } = useAIStore();
  const activeConnectionId = useSessionStore((state) => state.activeSessionId);
  const { t } = useI18n();
  const {
    currentTask,
    agentState,
    pendingApproval,
    pendingQuestion,
    pendingTerminalPrompt,
    taskHistory,
    config,
    startTask,
    reset,
    activeConversationId,
    startNewConversation,
    selectConversation,
    removeTaskFromHistory,
    pauseTask,
    resumeTask,
    cancelTask,
    setApprovalResult,
    setPendingInput,
  } = useAgentStore();

  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const activeConnection = useConnectionStore((state) => state.connections.find((connection) => connection.id === activeConnectionId));
  const isBusy = agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing';
  const shouldRunAgentExecutor = Boolean(currentTask && currentTask.state !== 'finished' && currentTask.state !== 'error');
  const hasAlert = Boolean(pendingApproval || pendingQuestion || pendingTerminalPrompt || localError);
  const conversationSummaries = getConversationSummaries(taskHistory);
  const activeHistoryTasks = taskHistory.filter((task) => (
    getTaskConversationId(task) === activeConversationId
    && task.id !== currentTask?.id
  ));
  const activeConversationTasks = [
    ...sortTasksAscending(activeHistoryTasks),
    ...(currentTask && getTaskConversationId(currentTask) === activeConversationId ? [currentTask] : []),
  ];
  const currentTaskActivity = currentTask?.thinkingSteps
    .map((step) => `${step.id}:${step.status}:${step.content.length}`)
    .join('|') || '';
  const shouldShowCompletionCue = agentState === 'finished' && !isCompletionViewed;
  const shouldShowCompletionEffects = shouldShowCompletionCue || isCompletionBurstVisible;

  const handlePauseTask = () => {
    void window.electronAPI?.agentPauseTask?.();
    pauseTask();
  };

  const handleResumeTask = () => {
    void window.electronAPI?.agentResumeTask?.();
    resumeTask();
  };

  const handleApproval = (result: 'approved' | 'rejected') => {
    // 会话级记住选择：后续同 riskLevel 自动决策
    if (rememberApprovalChoice && pendingApproval) {
      rememberRiskDecision(pendingApproval.riskLevel, result);
    }
    setRememberApprovalChoice(false);
    setApprovalResult(result);
  };

  const markCompletionViewed = () => {
    if (completionBurstTimerRef.current !== null) {
      window.clearTimeout(completionBurstTimerRef.current);
      completionBurstTimerRef.current = null;
    }
    setIsCompletionBurstVisible(false);
    setIsCompletionViewed(true);
  };

  const scrollConversationToBottom = () => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  };

  const scheduleScrollConversationToBottom = () => {
    if (openScrollTimerRef.current !== null) {
      window.clearTimeout(openScrollTimerRef.current);
      openScrollTimerRef.current = null;
    }

    requestAnimationFrame(() => {
      scrollConversationToBottom();
      requestAnimationFrame(scrollConversationToBottom);
    });

    openScrollTimerRef.current = window.setTimeout(() => {
      scrollConversationToBottom();
      openScrollTimerRef.current = null;
    }, 80);
  };

  const handleToggleHistory = () => {
    setIsHistoryVisible((visible) => !visible);
    shouldAutoScrollRef.current = false;
  };

  const handleSelectConversation = (conversationId: string) => {
    if (isBusy) {
      setLocalError(t('agent.errors.taskRunning'));
      return;
    }

    selectConversation(conversationId);
    setIsHistoryVisible(false);
    setLocalError(null);
    shouldAutoScrollRef.current = true;
  };

  const handleDeleteHistoryConversation = async (conversationId: string) => {
    if (isBusy && conversationId === activeConversationId) {
      setLocalError(t('agent.errors.taskRunning'));
      return;
    }

    const tasksToDelete = taskHistory.filter((task) => getTaskConversationId(task) === conversationId);
    for (const task of tasksToDelete) {
      const result = await window.electronAPI?.deleteAgentTaskHistory?.(task.id);
      if (result && !result.success) {
        setLocalError(result.error);
        return;
      }
      removeTaskFromHistory(task.id);
    }

    if (conversationId === activeConversationId) {
      startNewConversation();
    }

    setLocalError(null);
  };

  const handleRetryTask = (task: AgentTask) => {
    if (isBusy || pendingApproval || pendingQuestion || pendingTerminalPrompt) {
      setLocalError(t('agent.errors.taskRunning'));
      return;
    }

    if (!activeConnectionId) {
      setLocalError(t('agent.errors.noConnection'));
      return;
    }

    setIsHistoryVisible(false);
    setLocalError(null);
    onInputChange('');
    shouldAutoScrollRef.current = true;
    reset();
    setTimeout(() => startTask(task.userInput), 0);
  };

  useEffect(() => {
    const updatePosition = () => {
      const nextViewport = getViewportSize();
      const previousViewport = viewportSizeRef.current;
      viewportSizeRef.current = nextViewport;
      setPosition((current) => repositionPetForViewportChange(
        current,
        previousViewport,
        nextViewport,
      ));
    };

    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, []);

  useEffect(() => {
    if (focusInputToken > 0) {
      onOpenChange(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [focusInputToken, onOpenChange]);

  useEffect(() => {
    if (isOpen) {
      shouldAutoScrollRef.current = true;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        scrollConversationToBottom();
      });
      scheduleScrollConversationToBottom();
    }
  }, [isOpen]);

  useEffect(() => {
    const previousAgentState = previousAgentStateRef.current;
    const hasFinishedTask = agentState === 'finished' && previousAgentState !== 'finished';

    if (completionBurstTimerRef.current !== null && agentState !== 'finished') {
      window.clearTimeout(completionBurstTimerRef.current);
      completionBurstTimerRef.current = null;
      setIsCompletionBurstVisible(false);
      setIsCompletionViewed(false);
    }

    if (hasFinishedTask && previousAgentState !== null) {
      setIsCompletionViewed(false);
      setIsCompletionBurstVisible(true);
      if (completionBurstTimerRef.current !== null) {
        window.clearTimeout(completionBurstTimerRef.current);
      }
      completionBurstTimerRef.current = window.setTimeout(() => {
        setIsCompletionBurstVisible(false);
        completionBurstTimerRef.current = null;
      }, COMPLETION_BURST_MS);
    }

    previousAgentStateRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    if (isOpen && agentState === 'finished' && !isCompletionBurstVisible && !isCompletionViewed) {
      markCompletionViewed();
    }
  }, [agentState, isCompletionBurstVisible, isCompletionViewed, isOpen]);

  useEffect(() => () => {
    if (completionBurstTimerRef.current !== null) {
      window.clearTimeout(completionBurstTimerRef.current);
    }
    if (openScrollTimerRef.current !== null) {
      window.clearTimeout(openScrollTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !isBusy || !shouldAutoScrollRef.current) return;

    requestAnimationFrame(() => {
      scrollConversationToBottom();
    });
  }, [
    isOpen,
    isBusy,
    currentTaskActivity,
    currentTask?.state,
    pendingApproval,
    pendingQuestion,
    pendingTerminalPrompt,
    activeConversationTasks.length,
  ]);

  // 点击面板外部自动关闭(仅在空闲且无待处理事项时)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      // 忙碌、等待审批、等待回答时不自动关闭
      if (isBusy || pendingApproval || pendingQuestion || pendingTerminalPrompt) return;

      const target = e.target as Node;
      // 点击在面板或按钮内部,不关闭
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;

      onOpenChange(false);
    };

    // 用 mousedown 而不是 click,避免拖拽选中文本时误触发
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isBusy, pendingApproval, pendingQuestion, pendingTerminalPrompt, onOpenChange]);

  const handlePanelScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 32;
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;

    if (!config.enabled) {
      setLocalError(t('agent.errors.disabled'));
      return;
    }

    if (!activeProviderId) {
      setLocalError(t('agent.errors.noProvider'));
      return;
    }

    if (!activeConnectionId) {
      setLocalError(t('agent.errors.noConnection'));
      return;
    }

    setLocalError(null);
    setIsHistoryVisible(false);
    onInputChange('');
    shouldAutoScrollRef.current = true;

    if (pendingQuestion) {
      setPendingInput(text);
      return;
    }

    if (!currentTask || agentState === 'finished' || agentState === 'error') {
      reset();
      setTimeout(() => startTask(text), 0);
      return;
    }

    setLocalError(t('agent.errors.taskRunning'));
  };

  const handleNewConversation = () => {
    if (isBusy || pendingApproval || pendingQuestion || pendingTerminalPrompt) return;

    startNewConversation();
    setIsHistoryVisible(false);
    onInputChange('');
    setLocalError(null);
    shouldAutoScrollRef.current = true;
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const clearDragTimer = () => {
    if (dragLongPressTimerRef.current === null) return;
    window.clearTimeout(dragLongPressTimerRef.current);
    dragLongPressTimerRef.current = null;
  };

  const handlePetPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;

    const dragState: PetDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      hasLongPressed: false,
    };

    dragStateRef.current = dragState;
    event.currentTarget.setPointerCapture(event.pointerId);

    clearDragTimer();
    dragLongPressTimerRef.current = window.setTimeout(() => {
      if (dragStateRef.current !== dragState) return;
      dragState.hasLongPressed = true;
      suppressNextToggleRef.current = true;
      setIsDraggingPet(true);
    }, PET_LONG_PRESS_MS);
  };

  const handlePetPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!dragState.hasLongPressed) {
      if (distance > PET_MOVE_CANCEL_THRESHOLD) {
        clearDragTimer();
      }
      return;
    }

    event.preventDefault();
    setPosition(clampPetPosition({
      x: dragState.originX + deltaX,
      y: dragState.originY + deltaY,
    }));
  };

  const handlePetPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    clearDragTimer();

    if (dragState?.pointerId === event.pointerId) {
      if (dragState.hasLongPressed) {
        suppressNextToggleRef.current = true;
      }
      dragStateRef.current = null;
      setIsDraggingPet(false);
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePetClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextToggleRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextToggleRef.current = false;
      return;
    }

    const nextOpen = !isOpen;
    if (nextOpen && agentState === 'finished') {
      markCompletionViewed();
    }
    onOpenChange(nextOpen);
  };

  return (
    <>
      {shouldRunAgentExecutor && (
        <Suspense fallback={null}>
          <AgentExecutor />
        </Suspense>
      )}

      {isOpen && (
        <div ref={panelRef} className="agent-pet-panel" style={getPetPanelStyle(position)}>
          <div className="agent-pet-panel-header">
            <div className="flex min-w-0 items-center gap-3">
              <div className="agent-pet-avatar-mini">
                <RobotFaceMini />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">{t('agent.title')}</h2>
                  {isBusy && <span className="status-dot status-dot-connecting" />}
                </div>
                <p className="truncate text-xs text-slate-500">
                  {activeConnection ? `${activeConnection.username}@${activeConnection.host}` : t('agent.notConnected')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {(agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing') && (
                <>
                  <button onClick={handlePauseTask} className="agent-pet-header-action" title={t('agent.actions.pause')}>
                    <Pause className="h-3.5 w-3.5" />
                    <span>{t('agent.actions.pause')}</span>
                  </button>
                  <button onClick={cancelTask} className="agent-pet-header-action" title={t('agent.actions.cancel')}>
                    <XCircle className="h-3.5 w-3.5" />
                    <span>{t('agent.actions.cancel')}</span>
                  </button>
                </>
              )}
              {agentState === 'paused' && (
                <>
                  <button onClick={handleResumeTask} className="agent-pet-header-action agent-pet-header-action-primary" title={t('agent.actions.resume')}>
                    <Play className="h-3.5 w-3.5" />
                    <span>{t('agent.actions.resume')}</span>
                  </button>
                  <button onClick={cancelTask} className="agent-pet-header-action" title={t('agent.actions.cancel')}>
                    <XCircle className="h-3.5 w-3.5" />
                    <span>{t('agent.actions.cancel')}</span>
                  </button>
                </>
              )}
              <button onClick={onOpenSettings} className="icon-button h-7 w-7" title={t('settings.tabs.providers')}>
                <Settings className="h-4 w-4" />
              </button>
              <button onClick={() => onOpenChange(false)} className="icon-button h-7 w-7" title={t('common.close')}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="agent-pet-status-strip">
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
              <PlugZap className="h-3.5 w-3.5 text-teal-500" />
              {activeProvider ? activeProvider.name : t('aiProvider.noProviders')}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={handleToggleHistory}
                disabled={conversationSummaries.length === 0}
                className={`agent-pet-header-action ${isHistoryVisible ? 'agent-pet-header-action-primary' : ''}`}
                title={isHistoryVisible ? t('agent.actions.hideHistory') : t('agent.actions.viewHistory')}
              >
                <History className="h-3.5 w-3.5" />
                <span>{conversationSummaries.length}</span>
              </button>
              <span className="inline-flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-orange-500" />
                {agentState === 'idle' ? t('agent.status.idle') : agentState === 'finished' ? t('agent.status.finished') : agentState === 'error' ? t('agent.status.error') : t('agent.status.running')}
              </span>
            </div>
          </div>

          <div ref={bodyRef} onScroll={handlePanelScroll} className="agent-pet-panel-body scrollbar-modern">
            {isHistoryVisible && conversationSummaries.length > 0 && (
              <AgentHistoryList
                conversations={conversationSummaries}
                activeConversationId={activeConversationId}
                onSelect={handleSelectConversation}
                onDelete={handleDeleteHistoryConversation}
              />
            )}

            {!isHistoryVisible && activeConversationTasks.length === 0 && (
              <div className="agent-pet-empty">
                <RobotFaceMini />
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{t('agent.empty.title')}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{t('agent.empty.description')}</p>
                </div>
              </div>
            )}

            {!isHistoryVisible && activeConversationTasks.length > 0 && (
              <div className="agent-chat-thread">
                {activeConversationTasks.map((task) => (
                  <AgentTaskConversation
                    key={task.id}
                    task={task}
                    isCurrent={task.id === currentTask?.id}
                    onRetry={handleRetryTask}
                  />
                ))}
              </div>
            )}

            {pendingApproval && (
              <div className="agent-pet-approval">
                <div className="mb-2 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-orange-400" />
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">{t('agent.approval.title')}</span>
                </div>
                <code className="block break-all rounded-sm bg-black/20 px-2 py-2 font-mono text-xs text-orange-200">
                  {pendingApproval.command}
                </code>
                {getCommandDescription(pendingApproval.command) && (
                  <p className="mt-2 text-xs leading-5 text-slate-400">{getCommandDescription(pendingApproval.command)}</p>
                )}
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={rememberApprovalChoice}
                    onChange={(event) => setRememberApprovalChoice(event.target.checked)}
                  />
                  <span className="inline-flex flex-col gap-0.5">
                    <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
                      <Save className="h-3 w-3" />
                      {t('commandApproval.rememberChoice')}
                    </span>
                    <span>{t('commandApproval.rememberChoiceDesc')}</span>
                  </span>
                </label>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => handleApproval('rejected')} className="industrial-button-secondary flex-1 px-3 py-1.5 text-xs">{t('agent.approval.reject')}</button>
                  <button onClick={() => handleApproval('approved')} className="industrial-button-primary flex-1 px-3 py-1.5 text-xs">{t('agent.approval.approve')}</button>
                </div>
              </div>
            )}

            {pendingQuestion && (
              <div className="agent-pet-question">
                <MessageCircle className="h-4 w-4 text-teal-400" />
                <p className="text-sm leading-6 text-slate-700 dark:text-slate-200">{pendingQuestion}</p>
              </div>
            )}

            {localError && (
              <div className="rounded-sm border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {localError}
              </div>
            )}
          </div>

          <div className="agent-pet-input">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="industrial-input min-h-[76px] flex-1 resize-none"
              placeholder={pendingQuestion ? t('agent.input.answerPlaceholder') : t('agent.input.placeholder')}
            />
            <div className="flex flex-col gap-2">
              <button onClick={handleSend} disabled={!input.trim() || (isBusy && !pendingQuestion) || Boolean(pendingApproval)} className="industrial-button-primary h-9 w-10 px-0 py-0" title={t('agent.actions.send')}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
              <button
                onClick={handleNewConversation}
                disabled={isBusy || Boolean(pendingApproval || pendingQuestion || pendingTerminalPrompt)}
                className="industrial-button-secondary h-9 w-10 px-0 py-0"
                title={t('agent.actions.newConversation')}
              >
                <MessageCircle className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        ref={buttonRef}
        className={`agent-pet-button ${isOpen ? 'agent-pet-button-open' : ''} ${hasAlert ? 'agent-pet-button-alert' : ''} ${isBusy ? 'agent-pet-button-busy' : ''} ${shouldShowCompletionCue ? 'agent-pet-button-done' : ''} ${isCompletionBurstVisible && !isCompletionViewed ? 'agent-pet-button-complete-burst' : ''} ${agentState === 'error' ? 'agent-pet-button-error' : ''} ${isDraggingPet ? 'agent-pet-button-dragging' : ''}`}
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
        aria-expanded={isOpen}
        aria-pressed={isOpen}
        onPointerDown={handlePetPointerDown}
        onPointerMove={handlePetPointerMove}
        onPointerUp={handlePetPointerEnd}
        onPointerCancel={handlePetPointerEnd}
        onClick={handlePetClick}
        title={t('agent.title')}
      >
        <span className="agent-pet-face">
          <span className="agent-pet-ear agent-pet-ear-left" />
          <span className="agent-pet-ear agent-pet-ear-right" />
          <span className="agent-pet-eye agent-pet-eye-left" />
          <span className="agent-pet-eye agent-pet-eye-right" />
          <span className="agent-pet-mouth" />
          {isBusy && <span className="agent-pet-blush" />}
        </span>
        {isBusy && <span className="agent-pet-orbit" />}
        {shouldShowCompletionEffects && (
          <span className="agent-pet-done-ring" />
        )}
        {hasAlert && <span className="agent-pet-exclaim">!</span>}
      </button>
    </>
  );
}
