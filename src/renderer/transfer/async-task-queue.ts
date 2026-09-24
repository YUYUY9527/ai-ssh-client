export interface AsyncTaskQueueJob<T> {
  key: string;
  run: () => Promise<T> | T;
}

export interface AsyncTaskQueue<T> {
  enqueue: (job: AsyncTaskQueueJob<T>) => boolean;
  remove: (key: string) => boolean;
  clear: () => void;
  readonly activeCount: number;
  readonly pendingCount: number;
}

/**
 * Small FIFO queue with a hard concurrency limit.
 *
 * Uploads use this instead of starting one request per file. Browser fetch and
 * the SSH/SFTP channel share the same uplink, so unbounded parallel uploads
 * can starve the event loop and flood progress events.
 */
export function createAsyncTaskQueue<T>(concurrency: number): AsyncTaskQueue<T> {
  const limit = Math.max(1, Math.floor(concurrency));
  const pending: AsyncTaskQueueJob<T>[] = [];
  const pendingKeys = new Set<string>();
  const activeKeys = new Set<string>();
  let activeCount = 0;

  const pump = (): void => {
    while (activeCount < limit && pending.length > 0) {
      const job = pending.shift()!;
      pendingKeys.delete(job.key);
      activeKeys.add(job.key);
      activeCount += 1;

      Promise.resolve()
        .then(job.run)
        .catch(() => undefined)
        .finally(() => {
          activeKeys.delete(job.key);
          activeCount -= 1;
          pump();
        });
    }
  };

  return {
    enqueue: (job) => {
      if (pendingKeys.has(job.key) || activeKeys.has(job.key)) {
        return false;
      }
      pendingKeys.add(job.key);
      pending.push(job);
      void Promise.resolve().then(pump);
      return true;
    },
    remove: (key) => {
      const index = pending.findIndex((job) => job.key === key);
      if (index < 0) return false;
      pending.splice(index, 1);
      pendingKeys.delete(key);
      return true;
    },
    clear: () => {
      pending.splice(0, pending.length);
      pendingKeys.clear();
    },
    get activeCount() {
      return activeCount;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}
