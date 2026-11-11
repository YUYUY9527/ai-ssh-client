import { useEffect, useRef, useState } from 'react';

import type { SftpTransferTaskSnapshot } from '../../shared/ipc-types';
import { TransferSpeedTracker, isSpeedDisplayable } from './transfer-speed';

/** 停滞衰减的重算周期：传输卡住不再有新快照时，也能让速度逐步归零。 */
const SPEED_TICK_MS = 1000;

/**
 * 为每个传输中的任务计算实时速度（字节/秒）。
 *
 * 在 tasks 变化时采样；同时以 1s 周期重算，保证传输停滞（无新进度事件）时
 * 速度能衰减到 0，而不是冻结。返回 taskId -> 字节/秒 的映射，
 * 仅 transferring 状态的任务有条目。上传（服务端推送）与下载（浏览器落盘）
 * 的进度都会更新 store 里的 transferredBytes，因此两者统一在此测速。
 */
export function useTransferSpeeds(
  tasks: readonly SftpTransferTaskSnapshot[],
): Record<string, number> {
  const trackerRef = useRef<TransferSpeedTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new TransferSpeedTracker();
  }
  const tracker = trackerRef.current;
  const [, setTick] = useState(0);

  const hasActive = tasks.some(isSpeedDisplayable);
  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), SPEED_TICK_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  const now = Date.now();
  const speeds: Record<string, number> = {};
  const activeIds = new Set<string>();
  for (const task of tasks) {
    if (!isSpeedDisplayable(task)) continue;
    activeIds.add(task.taskId);
    tracker.observe(task.taskId, task.attempt, task.transferredBytes, now);
    speeds[task.taskId] = tracker.speedAt(task.taskId, now);
  }
  tracker.prune(activeIds);
  return speeds;
}
