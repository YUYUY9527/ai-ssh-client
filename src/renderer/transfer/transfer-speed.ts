import type { SftpTransferTaskSnapshot } from '../../shared/ipc-types';

/** 滑动窗口长度（毫秒）。用窗口内的平均速率平滑瞬时抖动，避免速度数字乱跳。 */
export const SPEED_WINDOW_MS = 4000;
/** 至少积累这么长的采样跨度才输出速度，防止用极短间隔做除法产生尖峰。 */
export const SPEED_MIN_SPAN_MS = 300;
/** 字节未变化时，最多隔多久补一个采样点，用于刷新时间端点让停滞速度衰减。 */
const IDLE_RESAMPLE_MS = 250;

export interface SpeedSample {
  /** 采样时刻（毫秒时间戳）。 */
  t: number;
  /** 该时刻的累计已传字节（含续传起点，做差后起点抵消）。 */
  bytes: number;
}

/**
 * 计算窗口内的平均传输速度（字节/秒）。
 *
 * 以 `now` 作为窗口右端点：即使最后一个采样之后没有新数据，也按“没有新增字节”
 * 处理。这样传输停滞时速度会随时间自然衰减到 0，而不是冻结在旧值上。
 */
export function computeWindowSpeed(
  samples: readonly SpeedSample[],
  now: number,
  windowMs: number = SPEED_WINDOW_MS,
): number {
  if (samples.length === 0) return 0;
  const cutoff = now - windowMs;
  let oldest: SpeedSample | undefined;
  let newest: SpeedSample | undefined;
  for (const sample of samples) {
    if (sample.t < cutoff) continue;
    if (!oldest) oldest = sample;
    newest = sample;
  }
  if (!oldest || !newest) return 0;
  const span = now - oldest.t;
  if (span < SPEED_MIN_SPAN_MS) return 0;
  const delta = newest.bytes - oldest.bytes;
  if (delta <= 0) return 0;
  return (delta / span) * 1000;
}

interface TaskSpeedState {
  attempt: number;
  lastBytes: number;
  samples: SpeedSample[];
}

/**
 * 按任务维护采样窗口并计算实时速度。
 * 纯内存、无副作用依赖，便于单测；由 useTransferSpeeds 在渲染期驱动。
 */
export class TransferSpeedTracker {
  private readonly states = new Map<string, TaskSpeedState>();

  /**
   * 记录一次采样。attempt 变化（重试）或字节回退时清空历史，
   * 避免把上一轮的累计值算进本轮、得出负速度或虚假尖峰。
   */
  observe(taskId: string, attempt: number, bytes: number, now: number): void {
    let state = this.states.get(taskId);
    if (!state || state.attempt !== attempt || bytes < state.lastBytes) {
      state = { attempt, lastBytes: bytes, samples: [] };
      this.states.set(taskId, state);
    }
    const last = state.samples[state.samples.length - 1];
    if (!last || last.bytes !== bytes || now - last.t >= IDLE_RESAMPLE_MS) {
      state.samples.push({ t: now, bytes });
    }
    state.lastBytes = bytes;
    // 丢弃窗口外的旧采样（多留 1s 余量），控制内存。
    const cutoff = now - SPEED_WINDOW_MS - 1000;
    if (state.samples.length > 2 && state.samples[0].t < cutoff) {
      state.samples = state.samples.filter((sample) => sample.t >= cutoff);
    }
  }

  /** 取任务在 now 时刻的速度（字节/秒）；无采样返回 0。 */
  speedAt(taskId: string, now: number): number {
    const state = this.states.get(taskId);
    if (!state) return 0;
    return computeWindowSpeed(state.samples, now);
  }

  /** 清理不再活跃的任务，防止长期运行内存增长。 */
  prune(activeTaskIds: ReadonlySet<string>): void {
    for (const taskId of this.states.keys()) {
      if (!activeTaskIds.has(taskId)) {
        this.states.delete(taskId);
      }
    }
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 格式化字节数（1024 进制），与文件列表 formatSize 的口径一致。 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), BYTE_UNITS.length - 1);
  return `${parseFloat((bytes / k ** index).toFixed(1))} ${BYTE_UNITS[index]}`;
}

/** 格式化传输速度，例如 “12.4 MB/s”。 */
export function formatTransferSpeed(bytesPerSecond: number): string {
  return `${formatByteSize(bytesPerSecond)}/s`;
}

/** 任务是否处于适合展示实时速度的状态。 */
export function isSpeedDisplayable(task: SftpTransferTaskSnapshot): boolean {
  return task.status === 'transferring';
}
