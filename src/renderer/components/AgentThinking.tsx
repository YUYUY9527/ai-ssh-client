import { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Brain, 
  Zap, 
  ListTodo, 
  Terminal, 
  Eye, 
  CheckCircle2, 
  XCircle, 
  ChevronDown, 
  ChevronUp,
  Play,
  Pause,
  RotateCcw,
  ChevronRight,
  X,
  AlertCircle
} from 'lucide-react';
import { useAgentStore } from '../store/useAgentStore';
import type { ThinkingStep, AgentState } from '../../shared/types';

// 悬停气泡组件
function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, placement: 'bottom' as 'bottom' | 'top' });

  const updatePosition = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const tooltipHeight = 300; // 最大高度
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      
      // 如果下方空间不足，显示在上方
      if (spaceBelow < tooltipHeight + 16 && spaceAbove > spaceBelow) {
        setPosition({
          top: rect.top - 8,
          left: rect.left,
          placement: 'top'
        });
      } else {
        setPosition({
          top: rect.bottom + 8,
          left: rect.left,
          placement: 'bottom'
        });
      }
    }
  };

  const handleMouseEnter = () => {
    updatePosition();
    setShowTooltip(true);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    // 检查鼠标是否移动到了 tooltip 内部
    if (tooltipRef.current && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      
      // 如果鼠标在触发元素或tooltip区域内，不隐藏
      const isInTrigger = mouseX >= triggerRect.left && mouseX <= triggerRect.right &&
                          mouseY >= triggerRect.top && mouseY <= triggerRect.bottom;
      const isInTooltip = mouseX >= tooltipRect.left && mouseX <= tooltipRect.right &&
                          mouseY >= tooltipRect.top && mouseY <= tooltipRect.bottom;
      
      if (!isInTrigger && !isInTooltip) {
        setShowTooltip(false);
      }
    } else {
      setShowTooltip(false);
    }
  };

  const handleTooltipMouseLeave = () => {
    setShowTooltip(false);
  };

  return (
    <div 
      ref={triggerRef}
      className="relative inline-block w-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {showTooltip && (
        <div 
          ref={tooltipRef}
          className="fixed z-[9999] p-3 w-80 max-w-96 
                     bg-gray-900 text-white text-sm rounded-lg shadow-xl 
                     whitespace-pre-wrap break-words border border-gray-700"
          style={{ 
            top: position.placement === 'bottom' ? position.top : 'auto',
            bottom: position.placement === 'top' ? window.innerHeight - position.top : 'auto',
            left: Math.max(8, Math.min(position.left, window.innerWidth - 320)), 
            maxHeight: '300px', 
            overflowY: 'auto'
          }}
          onMouseLeave={handleTooltipMouseLeave}
        >
          {content}
          <div 
            className={`absolute ${position.placement === 'bottom' ? 'bottom-full left-4 mb-0' : 'top-full left-4 mt-0'}
                       border-4 border-transparent ${position.placement === 'bottom' ? 'border-b-gray-900' : 'border-t-gray-900'}`} 
          />
        </div>
      )}
    </div>
  );
}

interface AgentThinkingProps {
  onPause?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
}

const stateLabels: Record<AgentState, { label: string; color: string; icon: React.ReactNode }> = {
  idle: { label: '待机', color: 'text-slate-500', icon: <Brain className="w-3 h-3" /> },
  thinking: { label: '思考中', color: 'text-blue-500', icon: <Brain className="w-3 h-3 animate-pulse" /> },
  planning: { label: '规划中', color: 'text-purple-500', icon: <ListTodo className="w-3 h-3 animate-pulse" /> },
  executing: { label: '执行中', color: 'text-yellow-500', icon: <Terminal className="w-3 h-3 animate-pulse" /> },
  observing: { label: '观察中', color: 'text-cyan-500', icon: <Eye className="w-3 h-3 animate-pulse" /> },
  paused: { label: '已暂停', color: 'text-orange-500', icon: <Pause className="w-3 h-3" /> },
  finished: { label: '已完成', color: 'text-green-500', icon: <CheckCircle2 className="w-3 h-3" /> },
  error: { label: '出错', color: 'text-red-500', icon: <XCircle className="w-3 h-3" /> },
};

const stepTypeIcons: Record<ThinkingStep['type'], React.ReactNode> = {
  understanding: <Brain className="w-3 h-3" />,
  planning: <ListTodo className="w-3 h-3" />,
  command_generation: <Zap className="w-3 h-3" />,
  execution: <Terminal className="w-3 h-3" />,
  observation: <Eye className="w-3 h-3" />,
  decision: <Brain className="w-3 h-3" />,
  complete: <CheckCircle2 className="w-3 h-3" />,
};

// 将步骤分组为轮次
interface StepGroup {
  stepNumber: number;
  steps: ThinkingStep[];
  isActive: boolean;
  summary: string;
}

function getExecutionCommand(content: string): string {
  const normalized = content.trim();
  const firstLine = normalized.split('\n').find((line) => line.trim().length > 0);
  return firstLine || normalized;
}

export function AgentThinking({ onPause, onResume, onRetry, onCancel }: AgentThinkingProps) {
  const { currentTask, agentState, config, pendingTerminalPrompt } = useAgentStore();
  const [userExpandedGroups, setUserExpandedGroups] = useState<Set<number>>(new Set()); // 用户手动展开的组
  const [userCollapsedGroups, setUserCollapsedGroups] = useState<Set<number>>(new Set()); // 用户手动折叠的组
  const [showAllGroups, setShowAllGroups] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const thinkingSteps = currentTask?.thinkingSteps ?? [];

  // 生成组的摘要
  function generateGroupSummary(steps: ThinkingStep[]): string {
    // 优先检查是否有完成步骤
    const completeStep = steps.find(s => s.type === 'complete' && s.status === 'completed');
    if (completeStep) {
      return '任务完成';
    }

    const commands = steps.filter(s => s.type === 'execution' && s.status === 'completed');
    if (commands.length > 0) {
      const cmdContents = commands.map(s => {
        const match = s.content.match(/命令：(.+?)(?:\n|$)/);
        return match ? match[1] : '执行命令';
      });
      if (cmdContents.length === 1) {
        return `执行: ${cmdContents[0]}`;
      }
      return `执行了 ${cmdContents.length} 条命令`;
    }

    const observation = steps.find(s => s.type === 'observation' && s.status === 'completed');
    if (observation) {
      const content = observation.content;
      return content.length > 50 ? content.substring(0, 50) + '...' : content;
    }

    return steps[0]?.title || '';
  }

  // 将步骤分组为轮次
  // 每个 understanding 步骤标志新一轮的开始
  const stepGroups = useMemo(() => {
    if (thinkingSteps.length === 0) return [];
    
    const groups: StepGroup[] = [];
    let currentGroup: ThinkingStep[] = [];
    let stepNumber = 1;
    let isFirstStep = true;
    
    thinkingSteps.forEach((step) => {
      // 每当遇到新的 understanding 步骤，意味着新一轮开始
      if (step.type === 'understanding') {
        // 完成当前组（如果是第一轮，currentGroup 可能为空或只有之前的步骤）
        if (currentGroup.length > 0) {
          groups.push({
            stepNumber,
            steps: [...currentGroup],
            isActive: false,
            summary: generateGroupSummary(currentGroup),
          });
          stepNumber++;
        } else if (isFirstStep) {
          // 第一轮的 understanding 是该轮的第一步
          isFirstStep = false;
        }
        currentGroup = [];
      }
      currentGroup.push(step);
    });
    
    // 添加最后一组
    if (currentGroup.length > 0) {
      groups.push({
        stepNumber,
        steps: currentGroup,
        isActive: false,
        summary: generateGroupSummary(currentGroup),
      });
    }
    
    return groups;
  }, [thinkingSteps]);

  // 自动展开/折叠逻辑：只展开当前正在进行的轮次
  useEffect(() => {
    if (stepGroups.length > 0) {
      // 滚动到底部
      if (containerRef.current) {
        const scrollToBottom = () => {
          if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
          }
        };
        scrollToBottom();
        setTimeout(scrollToBottom, 50);
        setTimeout(scrollToBottom, 100);
      }
    }
  }, [stepGroups.length, stepGroups]);

  // 计算当前应该展开的组
  // 重要：直接依赖 thinkingSteps 确保每次步骤变化都能正确更新展开状态
  const getExpandedGroups = useMemo(() => {
    const expanded = new Set<number>();
    
    if (agentState !== 'finished' && agentState !== 'error') {
      // 执行中：自动展开所有组
      stepGroups.forEach((_, index) => expanded.add(index));
      
      // 尊重用户手动折叠的组（最后一轮不能折叠）
      userCollapsedGroups.forEach(index => {
        if (index !== stepGroups.length - 1) {
          expanded.delete(index);
        }
      });
      
      // 保留用户手动展开的组
      userExpandedGroups.forEach(index => expanded.add(index));
    } else {
      // 已完成/出错：默认只展开最后一轮
      if (stepGroups.length > 0) {
        const lastGroupIndex = stepGroups.length - 1;
        
        // 如果用户没有手动折叠最后一轮，则展开
        if (!userCollapsedGroups.has(lastGroupIndex)) {
          expanded.add(lastGroupIndex);
        }
      }
      
      // 保留用户手动展开的其他组
      userExpandedGroups.forEach(index => {
        if (index !== stepGroups.length - 1) {
          expanded.add(index);
        }
      });
    }
    
    return expanded;
  }, [stepGroups, userExpandedGroups, userCollapsedGroups, agentState]);



  // 统计信息
  const stats = useMemo(() => {
    const commands = thinkingSteps.filter(s => s.type === 'execution' && s.status === 'completed');
    const observations = thinkingSteps.filter(s => s.type === 'observation' && s.status === 'completed');
    return {
      rounds: stepGroups.length,
      commands: commands.length,
      observations: observations.length,
    };
  }, [thinkingSteps, stepGroups]);

  if (!currentTask) return null;

  const toggleGroup = (groupIndex: number) => {
    const isCurrentlyExpanded = getExpandedGroups.has(groupIndex);
    
    if (isCurrentlyExpanded) {
      // 折叠：添加到 userCollapsedGroups，从 userExpandedGroups 移除
      setUserCollapsedGroups(prev => new Set(prev).add(groupIndex));
      setUserExpandedGroups(prev => {
        const next = new Set(prev);
        next.delete(groupIndex);
        return next;
      });
    } else {
      // 展开：添加到 userExpandedGroups，从 userCollapsedGroups 移除
      setUserExpandedGroups(prev => new Set(prev).add(groupIndex));
      setUserCollapsedGroups(prev => {
        const next = new Set(prev);
        next.delete(groupIndex);
        return next;
      });
    }
  };

  const stateInfo = stateLabels[agentState];
  const duration = currentTask.endTime 
    ? currentTask.endTime - currentTask.startTime 
    : Date.now() - currentTask.startTime;
  const durationSeconds = Math.floor(duration / 1000);

  return (
    <div className="flex flex-col h-full max-h-full gap-4">
      {/* 任务头部 */}
      <div className="agent-task-card flex-shrink-0">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <Brain className="w-4 h-4 text-teal-500" />
            <span className="font-medium text-sm text-slate-900 dark:text-white">智能体任务</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={`flex items-center gap-1 text-xs ${stateInfo.color}`}>
              {stateInfo.icon}
              {stateInfo.label}
            </span>
            {pendingTerminalPrompt && (
              <span className="flex items-center gap-1 text-xs text-amber-500">
                <AlertCircle className="w-3 h-3" />
                等待终端输入
              </span>
            )}
            <span className="text-xs text-slate-400">
              {durationSeconds}s
            </span>
          </div>
        </div>

        {/* 统计信息 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 mb-3">
          <span className="flex items-center gap-1.5">
            <ListTodo className="w-3 h-3" />
            {stats.rounds} 轮
          </span>
          <span className="flex items-center gap-1.5">
            <Terminal className="w-3 h-3" />
            {stats.commands} 命令
          </span>
          {stats.observations > 0 && (
            <span className="flex items-center gap-1.5">
              <Eye className="w-3 h-3" />
              {stats.observations} 观察
            </span>
          )}
        </div>

        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300 mb-3">
          {currentTask.userInput}
        </p>

        {pendingTerminalPrompt && (
          <div className="mb-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            终端正在等待你的输入：{pendingTerminalPrompt}。请先在终端中完成交互，智能体会继续等待。
          </div>
        )}

        {/* 控制按钮 */}
        {(agentState === 'thinking' || agentState === 'planning' || agentState === 'executing' || agentState === 'observing') && (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-sm hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
          >
            <Pause className="w-3 h-3" />
            暂停
          </button>
        )}

        {agentState === 'paused' && (
          <div className="flex gap-2">
            <button
              onClick={onResume}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-sm hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
            >
              <Play className="w-3 h-3" />
              继续
            </button>
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-sm hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
            >
              <X className="w-3 h-3" />
              取消
            </button>
          </div>
        )}

        {agentState === 'error' && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 rounded-sm hover:bg-teal-200 dark:hover:bg-teal-900/50 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            重试
          </button>
        )}

        {agentState === 'error' && currentTask.error && (
          <p className="text-xs leading-5 text-red-500 mt-3">{currentTask.error}</p>
        )}
      </div>

      {/* 思考步骤 - 按轮次分组显示 */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-none">
        {stepGroups.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6">
            等待智能体开始思考...
          </p>
        ) : (
          <div className="space-y-3 pb-1">
            {stepGroups.length > 3 && (
              <div className="flex justify-end">
                <button
                  onClick={() => setShowAllGroups(!showAllGroups)}
                  className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
                >
                  {showAllGroups ? '收起' : `查看全部 ${stepGroups.length} 轮`}
                </button>
              </div>
            )}
            {(() => {
              const startIndex = showAllGroups ? 0 : Math.max(0, stepGroups.length - 3);
              return stepGroups.slice(startIndex).map((group, displayIndex) => {
                const actualIndex = startIndex + displayIndex;
                const isExpanded = getExpandedGroups.has(actualIndex);
                const latestStep = group.steps[group.steps.length - 1];
                const isLastGroup = actualIndex === stepGroups.length - 1;
                const hasInProgressStep = group.steps.some(s => s.status === 'in_progress');
                const isCurrentlyActive = hasInProgressStep || (isLastGroup && agentState !== 'finished' && agentState !== 'error');

                return (
                  <div
                    key={group.stepNumber}
                    className={`agent-round-card ${isCurrentlyActive ? 'agent-round-card-active' : ''}`}
                  >
                    {/* 组标题 - 可点击折叠 */}
                    <button
                      onClick={() => toggleGroup(actualIndex)}
                      className="agent-round-header"
                    >
                      {/* 状态指示器 */}
                      <span className={`flex-shrink-0 ${isCurrentlyActive ? 'text-teal-500' : 'text-slate-400'}`}>
                        {isCurrentlyActive ? (
                          <div className="w-2.5 h-2.5 rounded-full bg-teal-500 animate-pulse" />
                        ) : latestStep.status === 'completed' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        ) : latestStep.status === 'failed' ? (
                          <XCircle className="w-3.5 h-3.5 text-red-500" />
                        ) : (
                          <div className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                        )}
                      </span>

                      {/* 轮次标签 */}
                      <span className={`flex-shrink-0 px-2 py-1 rounded-sm text-xs font-medium ${
                        isCurrentlyActive
                          ? 'bg-teal-100 dark:bg-teal-900/50 text-teal-600 dark:text-teal-400'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}>
                        第{group.stepNumber}轮
                      </span>

                      {/* 摘要 */}
                      <span className="flex-1 text-sm leading-6 text-slate-700 dark:text-slate-200 truncate">
                        {group.summary}
                      </span>

                      {/* 步骤数量 */}
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {group.steps.length} 步
                      </span>

                      {/* 展开/折叠图标 */}
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      )}
                    </button>

                    {/* 展开的步骤详情 */}
                    {isExpanded && (
                      <div className="agent-step-list">
                        {group.steps.map((step) => (
                          <div
                            key={step.id}
                            className={`agent-step-row ${
                              step.status === 'in_progress' ? 'bg-teal-50/60 dark:bg-teal-900/10' : ''
                            }`}
                          >
                            {/* 步骤图标 */}
                            <span className="flex-shrink-0 mt-1 text-slate-400">
                              {stepTypeIcons[step.type]}
                            </span>

                            {/* 步骤内容 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                                  {step.type === 'execution' ? '执行命令' : step.title}
                                </span>
                                {step.status === 'in_progress' && (
                                  <span className="px-1.5 py-0.5 rounded-sm text-xs bg-teal-100 dark:bg-teal-900/50 text-teal-600 dark:text-teal-400">
                                    进行中
                                  </span>
                                )}
                                {step.status === 'completed' && (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                                )}
                                {step.status === 'failed' && (
                                  <XCircle className="w-3.5 h-3.5 text-red-500" />
                                )}
                              </div>
                              {step.type === 'execution' ? (
                                <Tooltip content={step.content}>
                                  <div className="cursor-help">
                                    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                                      执行命令
                                    </p>
                                    <p className="mt-1 text-sm leading-6 text-slate-700 dark:text-slate-200 break-all font-mono">
                                      {getExecutionCommand(step.content)}
                                    </p>
                                  </div>
                                </Tooltip>
                              ) : (
                                <Tooltip content={step.content}>
                                  <p className="text-xs leading-6 text-slate-500 dark:text-slate-400 line-clamp-2 whitespace-pre-wrap cursor-help">
                                    {step.content}
                                  </p>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>

      {/* 最终结果总结 */}
      {(agentState === 'finished' || agentState === 'error') && (
        <div className={`agent-result-card flex-shrink-0 ${
          agentState === 'finished'
            ? ''
            : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
        }`}>
          <div className="flex items-center gap-2.5 mb-3">
            {agentState === 'finished' ? (
              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            ) : (
              <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
            )}
            <h4 className={`font-medium text-sm ${
              agentState === 'finished'
                ? 'text-green-800 dark:text-green-300'
                : 'text-red-800 dark:text-red-300'
            }`}>
              {agentState === 'finished' ? '任务完成' : '任务出错'}
            </h4>
          </div>

          {/* 展示 finishReason */}
          {agentState === 'finished' && currentTask.finishReason && (
            <Tooltip content={currentTask.finishReason}>
              <p className="text-sm leading-7 text-green-700 dark:text-green-400 whitespace-pre-wrap cursor-help">
                {currentTask.finishReason}
              </p>
            </Tooltip>
          )}

          {agentState === 'error' && currentTask.error && (
            <p className="text-sm leading-7 text-red-600 dark:text-red-400 mt-2">
              错误：{currentTask.error}
            </p>
          )}

          <div className={`mt-3 text-xs ${
            agentState === 'finished'
              ? 'text-green-600/70 dark:text-green-400/70'
              : 'text-red-600/70 dark:text-red-400/70'
          }`}>
            耗时：{durationSeconds} 秒
          </div>
        </div>
      )}
    </div>
  );
}
