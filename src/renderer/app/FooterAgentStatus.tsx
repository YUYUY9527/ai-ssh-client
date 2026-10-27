import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { isAgentTaskRunningInSession } from '../agent/terminal-agent-chat';
import { useI18n } from '../i18n';
import { useAgentStore } from '../store/useAgentStore';
import { resolveFooterAgentElapsedSeconds, resolveFooterAgentPhase } from './footer-agent-status';

/**
 * 底栏里的 Agent 运行状态，紧挨着「已连接」。
 *
 * 从终端浮层挪过来：浮层压在小屏终端左下角时会盖住命令输出（真实反馈的截图里
 * 就正好挡住 vmstat 的表头），而且 vim/less 一进全屏还得让位——任务明明还在跑，
 * 状态却消失了。底栏不占终端画布，没有这两个问题。
 *
 * 自己订阅 store 并自己掐秒表：这样每秒只重渲染这一小块，
 * 不会带着 `AppController` 和整棵终端树一起重画。
 */
export function FooterAgentStatus() {
  const { t } = useI18n();
  const activeConnectionId = useAgentStore((state) => state.activeConnectionId);
  const taskConnectionId = useAgentStore((state) => state.currentTask?.connectionId || null);
  const taskState = useAgentStore((state) => state.currentTask?.state ?? null);
  const taskStartTime = useAgentStore((state) => state.currentTask?.startTime ?? null);
  const agentState = useAgentStore((state) => state.agentState);

  // 在跑的任务是否属于当前标签页：别的会话的任务不该在这里报进度
  const isRunning = isAgentTaskRunningInSession({
    sessionId: activeConnectionId,
    currentTaskState: taskState,
    currentTaskConnectionId: taskConnectionId,
    agentState,
  });

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isRunning || !taskStartTime) {
      setElapsedSeconds(0);
      return;
    }
    const tick = () => {
      setElapsedSeconds(resolveFooterAgentElapsedSeconds(taskStartTime, Date.now()));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, taskStartTime]);

  if (!isRunning) return null;

  // 阶段用 agentState（思考中/执行中/观察中），任务级 state 只有 running/paused，
  // 看不出「现在到底在干什么」。
  const phase = resolveFooterAgentPhase(agentState);
  const hints = `${t('terminal.agentStatusEscapeHint')} · ${t('terminal.agentStatusInputHint')}`;

  // 不挂 aria-live：这里每秒都在变，读屏会被念到停不下来。状态靠 title 可查。
  return (
    <div
      className="app-footer-meta app-footer-agent min-w-0 text-accent"
      title={hints}
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="truncate">
        {t('terminal.agentStatusRunning', {
          state: phase ? t(`agent.states.${phase}`) : t('agent.status.running'),
          elapsed: elapsedSeconds,
        })}
      </span>
      <span className="hidden shrink-0 opacity-70 sm:inline">
        {t('terminal.agentStatusEscapeHint')}
      </span>
    </div>
  );
}
