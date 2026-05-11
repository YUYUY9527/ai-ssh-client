import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, MessageCircle, Pause, Play, PlugZap, RotateCcw, Send, Settings, ShieldAlert, Terminal, User, X, XCircle } from 'lucide-react';
import { useAIStore } from '../store/useAIStore';
import { useAgentStore } from '../store/useAgentStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { AgentExecutor } from './AgentExecutor';
import { AppIcon } from './AppIcon';
import { COMMAND_DESCRIPTIONS } from '../../shared/constants';
import type { AgentTask, ThinkingStep } from '../../shared/types';

interface AgentPetProps {
  input: string;
  onInputChange: (value: string) => void;
  focusInputToken: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
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
  return match?.[1]?.trim() || step.content.split('\n')[0]?.trim() || '执行命令';
}

function getTaskStatus(task: AgentTask): { label: string; tone: 'running' | 'success' | 'error' | 'idle' } {
  if (task.state === 'finished') return { label: '已完成', tone: 'success' };
  if (task.state === 'error') return { label: '出错', tone: 'error' };
  if (task.state === 'paused') return { label: '已暂停', tone: 'idle' };
  return { label: '执行中', tone: 'running' };
}

function getTaskSummary(task: AgentTask): string {
  if (task.finishReason) return task.finishReason;
  if (task.error) return task.error;

  const latestStep = [...task.thinkingSteps].reverse().find((step) => step.content.trim());
  if (latestStep) return latestStep.content.replace(/\s+/g, ' ').slice(0, 180);

  return task.state === 'finished' ? '任务已完成。' : '正在分析任务并观察终端输出。';
}

function AgentThinkingStep({ step }: { step: ThinkingStep }) {
  const [showFull, setShowFull] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement>(null);

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
          {showFull ? '收起思考详情' : '查看思考详情'}
        </button>
      )}
    </div>
  );
}

function AgentTaskConversation({ task, isCurrent }: { task: AgentTask; isCurrent: boolean }) {
  const [expanded, setExpanded] = useState(isCurrent && task.state !== 'finished');
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
          <Bot className="h-4 w-4" />
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
              {expanded ? '收起执行过程' : '查看执行过程'}
            </button>
          )}

          {expanded && (
            <div className="agent-chat-detail">
              {commandSteps.length > 0 && (
                <div className="space-y-2">
                  <div className="agent-chat-detail-label">执行命令</div>
                  {commandSteps.map((step) => (
                    <code key={step.id} className="agent-chat-command">
                      {getStepCommand(step)}
                    </code>
                  ))}
                </div>
              )}

              {detailSteps.length > 0 && (
                <div className="space-y-2">
                  <div className="agent-chat-detail-label">思考与观察</div>
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
  const shouldAutoScrollRef = useRef(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const { providers, activeProviderId } = useAIStore();
  const { activeConnectionId } = useConnectionStore();
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
      setLocalError('智能体已在设置中禁用');
      return;
    }

    if (!activeProviderId) {
      setLocalError('请先在设置里配置并激活 AI 供应商');
      return;
    }

    if (!activeConnectionId) {
      setLocalError('请先连接一个 SSH 会话');
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

    setLocalError('当前任务仍在运行，请先等待完成或取消任务');
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

  return (
    <>
      <AgentExecutor />

      {isOpen && (
        <div className="agent-pet-panel">
          <div className="agent-pet-panel-header">
            <div className="flex min-w-0 items-center gap-3">
              <div className="agent-pet-avatar-mini">
                <AppIcon className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-white">终端智能体</h2>
                  {isBusy && <span className="h-2 w-2 rounded-full bg-teal-400 animate-pulse" />}
                </div>
                <p className="truncate text-xs text-slate-500">
                  {activeConnection ? `${activeConnection.username}@${activeConnection.host}` : '未连接 SSH'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {(agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing') && (
                <>
                  <button onClick={pauseTask} className="agent-pet-header-action" title="暂停">
                    <Pause className="h-3.5 w-3.5" />
                    <span>暂停</span>
                  </button>
                  <button onClick={cancelTask} className="agent-pet-header-action" title="取消">
                    <XCircle className="h-3.5 w-3.5" />
                    <span>取消</span>
                  </button>
                </>
              )}
              {agentState === 'paused' && (
                <>
                  <button onClick={resumeTask} className="agent-pet-header-action agent-pet-header-action-primary" title="继续">
                    <Play className="h-3.5 w-3.5" />
                    <span>继续</span>
                  </button>
                  <button onClick={cancelTask} className="agent-pet-header-action" title="取消">
                    <XCircle className="h-3.5 w-3.5" />
                    <span>取消</span>
                  </button>
                </>
              )}
              <button onClick={onOpenSettings} className="icon-button h-7 w-7" title="AI 供应商设置">
                <Settings className="h-4 w-4" />
              </button>
              <button onClick={() => onOpenChange(false)} className="icon-button h-7 w-7" title="收起">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="agent-pet-status-strip">
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
              <PlugZap className="h-3.5 w-3.5 text-teal-500" />
              {activeProvider ? activeProvider.name : '未激活供应商'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5 text-orange-500" />
              {agentState === 'idle' ? '待命' : agentState === 'finished' ? '完成' : agentState === 'error' ? '异常' : '执行中'}
            </span>
          </div>

          <div ref={bodyRef} onScroll={handlePanelScroll} className="agent-pet-panel-body scrollbar-modern">
            {conversationTasks.length === 0 && (
              <div className="agent-pet-empty">
                <Bot className="h-8 w-8 text-teal-400" />
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">告诉我你想在终端里完成什么。</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">我会观察终端输出、生成命令并按风险设置请求确认。</p>
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
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">命令需要审批</span>
                </div>
                <code className="block break-all rounded-sm bg-black/20 px-2 py-2 font-mono text-xs text-orange-200">
                  {pendingApproval.command}
                </code>
                {getCommandDescription(pendingApproval.command) && (
                  <p className="mt-2 text-xs leading-5 text-slate-400">{getCommandDescription(pendingApproval.command)}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <button onClick={() => setApprovalResult('rejected')} className="industrial-button-secondary flex-1 px-3 py-1.5 text-xs">拒绝</button>
                  <button onClick={() => setApprovalResult('approved')} className="industrial-button-primary flex-1 px-3 py-1.5 text-xs">批准执行</button>
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
              placeholder={pendingQuestion ? '补充信息后按 Enter...' : '例如：帮我检查 nginx 为什么启动失败'}
            />
            <div className="flex flex-col gap-2">
              <button onClick={handleSend} disabled={!input.trim() || (isBusy && !pendingQuestion) || Boolean(pendingApproval)} className="industrial-button-primary h-9 w-10 px-0 py-0" title="发送">
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
              <button onClick={handleClear} className="industrial-button-secondary h-9 w-10 px-0 py-0" title="重置">
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        className={`agent-pet-button ${isOpen ? 'agent-pet-button-open' : ''} ${hasAlert ? 'agent-pet-button-alert' : ''}`}
        onClick={() => onOpenChange(!isOpen)}
        title="终端智能体"
      >
        <span className="agent-pet-face">
          <span className="agent-pet-eye agent-pet-eye-left" />
          <span className="agent-pet-eye agent-pet-eye-right" />
          <span className="agent-pet-mouth" />
        </span>
        {agentState === 'finished' && !isOpen && <CheckCircle2 className="agent-pet-badge text-green-300" />}
        {isBusy && <span className="agent-pet-orbit" />}
      </button>
    </>
  );
}
