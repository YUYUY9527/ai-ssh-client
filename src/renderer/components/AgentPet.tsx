import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, MessageCircle, Pause, Play, PlugZap, RotateCcw, Send, Settings, ShieldAlert, Terminal, User, X, XCircle } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { useAgentStore } from '../store/useAgentStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { AgentExecutor } from './AgentExecutor';
import { COMMAND_DESCRIPTIONS } from '../../shared/constants';
import { useI18n, t } from '../i18n';
import type { AgentTask, ThinkingStep } from '../../shared/types';

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

const PET_BUTTON_SIZE = 64;
const PET_DEFAULT_RIGHT = 20;
const PET_DEFAULT_BOTTOM = 48;
const PET_EDGE_PADDING = 12;
const PET_LONG_PRESS_MS = 360;
const PET_MOVE_CANCEL_THRESHOLD = 8;
const PET_PANEL_GAP = 16;
const PET_PANEL_EDGE_PADDING = 16;
const PET_PANEL_MAX_WIDTH = 430;
const PET_PANEL_MAX_HEIGHT = 680;
const PET_PANEL_VERTICAL_RESERVE = 144;

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

function clampPetPosition(position: PetPosition): PetPosition {
  if (typeof window === 'undefined') {
    return position;
  }

  return {
    x: clamp(position.x, PET_EDGE_PADDING, window.innerWidth - PET_BUTTON_SIZE - PET_EDGE_PADDING),
    y: clamp(position.y, PET_EDGE_PADDING, window.innerHeight - PET_BUTTON_SIZE - PET_EDGE_PADDING),
  };
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

function AgentTaskConversation({ task, isCurrent }: { task: AgentTask; isCurrent: boolean }) {
  const [expanded, setExpanded] = useState(isCurrent && task.state !== 'finished');
  const { t } = useI18n();
  const status = getTaskStatus(task);
  const commandSteps = task.thinkingSteps.filter((step) => step.type === 'execution');
  const observationSteps = task.thinkingSteps.filter((step) => step.type === 'observation');
  const detailSteps = task.thinkingSteps.filter((step) => step.type !== 'execution');
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

          {(commandSteps.length > 0 || detailSteps.length > 0 || observationSteps.length > 0) && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="agent-chat-detail-toggle"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {expanded ? t('agent.conversation.collapseProcess') : t('agent.conversation.expandProcess')}
            </button>
          )}

          {expanded && (
            <div className="agent-chat-detail">
              {commandSteps.length > 0 && (
                <div className="space-y-2">
                  <div className="agent-chat-detail-label">{t('agent.conversation.executedCommands')}</div>
                  {commandSteps.map((step) => (
                    <code key={step.id} className="agent-chat-command">
                      {getStepCommand(step)}
                    </code>
                  ))}
                </div>
              )}

              {detailSteps.length > 0 && (
                <div className="space-y-2">
                  <div className="agent-chat-detail-label">{t('agent.conversation.thinkingAndObserving')}</div>
                  {detailSteps.map((step) => (
                    <AgentThinkingStep key={step.id} step={step} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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
  const suppressNextToggleRef = useRef(false);
  const [position, setPosition] = useState<PetPosition>(() => getDefaultPetPosition());
  const [isDraggingPet, setIsDraggingPet] = useState(false);
  const shouldAutoScrollRef = useRef(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const { providers, activeProviderId } = useAIStore();
  const { activeConnectionId } = useConnectionStore();
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
    clearTaskHistory,
    pauseTask,
    resumeTask,
    cancelTask,
    setApprovalResult,
    setPendingInput,
  } = useAgentStore();

  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const activeConnection = useConnectionStore((state) => state.connections.find((connection) => connection.id === activeConnectionId));
  const isBusy = agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing';
  const hasAlert = Boolean(pendingApproval || pendingQuestion || pendingTerminalPrompt || localError);
  const conversationTasks = [
    ...taskHistory.filter((task) => task.id !== currentTask?.id).slice(0, 12).reverse(),
    ...(currentTask ? [currentTask] : []),
  ];
  const currentTaskActivity = currentTask?.thinkingSteps
    .map((step) => `${step.id}:${step.status}:${step.content.length}`)
    .join('|') || '';

  useEffect(() => {
    const updatePosition = () => {
      setPosition((current) => clampPetPosition(current));
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
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isBusy || !shouldAutoScrollRef.current) return;

    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      body.scrollTop = body.scrollHeight;
    });
  }, [
    isOpen,
    isBusy,
    currentTaskActivity,
    currentTask?.state,
    pendingApproval,
    pendingQuestion,
    pendingTerminalPrompt,
    conversationTasks.length,
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

  const handleClear = () => {
    reset();
    clearTaskHistory();
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

    onOpenChange(!isOpen);
  };

  return (
    <>
      <AgentExecutor />

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
                  {isBusy && <span className="h-2 w-2 rounded-full bg-teal-400 animate-pulse" />}
                </div>
                <p className="truncate text-xs text-slate-500">
                  {activeConnection ? `${activeConnection.username}@${activeConnection.host}` : t('agent.notConnected')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {(agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing') && (
                <>
                  <button onClick={pauseTask} className="agent-pet-header-action" title={t('agent.actions.pause')}>
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
                  <button onClick={resumeTask} className="agent-pet-header-action agent-pet-header-action-primary" title={t('agent.actions.resume')}>
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
            <span className="inline-flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-orange-500" />
              {agentState === 'idle' ? t('agent.status.idle') : agentState === 'finished' ? t('agent.status.finished') : agentState === 'error' ? t('agent.status.error') : t('agent.status.running')}
            </span>
          </div>

          <div ref={bodyRef} onScroll={handlePanelScroll} className="agent-pet-panel-body scrollbar-modern">
            {conversationTasks.length === 0 && (
              <div className="agent-pet-empty">
                <RobotFaceMini />
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{t('agent.empty.title')}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{t('agent.empty.description')}</p>
                </div>
              </div>
            )}

            {conversationTasks.length > 0 && (
              <div className="agent-chat-thread">
                {conversationTasks.map((task) => (
                  <AgentTaskConversation key={task.id} task={task} isCurrent={task.id === currentTask?.id} />
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
                <div className="mt-3 flex gap-2">
                  <button onClick={() => setApprovalResult('rejected')} className="industrial-button-secondary flex-1 px-3 py-1.5 text-xs">{t('agent.approval.reject')}</button>
                  <button onClick={() => setApprovalResult('approved')} className="industrial-button-primary flex-1 px-3 py-1.5 text-xs">{t('agent.approval.approve')}</button>
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
              <button onClick={handleClear} className="industrial-button-secondary h-9 w-10 px-0 py-0" title={t('common.reset')}>
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        ref={buttonRef}
        className={`agent-pet-button ${isOpen ? 'agent-pet-button-open' : ''} ${hasAlert ? 'agent-pet-button-alert' : ''} ${isBusy ? 'agent-pet-button-busy' : ''} ${agentState === 'finished' ? 'agent-pet-button-done' : ''} ${agentState === 'error' ? 'agent-pet-button-error' : ''} ${isDraggingPet ? 'agent-pet-button-dragging' : ''}`}
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
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
        {isBusy && (
          <>
            <span className="agent-pet-orbit" />
            <span className="agent-pet-spark agent-pet-spark-1" />
            <span className="agent-pet-spark agent-pet-spark-2" />
            <span className="agent-pet-spark agent-pet-spark-3" />
          </>
        )}
        {hasAlert && <span className="agent-pet-exclaim">!</span>}
      </button>
    </>
  );
}
