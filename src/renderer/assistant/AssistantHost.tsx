import { lazy, Suspense } from 'react';
import { useAgentStore } from '../store/useAgentStore';

const AgentExecutor = lazy(async () => {
  const module = await import('../components/AgentExecutor');
  return { default: module.AgentExecutor };
});

/**
 * 后台托管 Agent 执行引擎（AgentExecutor）。
 * 交互界面已完整集成进终端顶部的 TerminalAgentDock 停靠卡片，不再渲染右下角悬浮机器人。
 */
export function AssistantHost() {
  const currentTask = useAgentStore((state) => state.currentTask);
  const shouldRunAgentExecutor = Boolean(
    currentTask && currentTask.state !== 'finished' && currentTask.state !== 'error',
  );

  if (!shouldRunAgentExecutor) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <AgentExecutor />
    </Suspense>
  );
}
