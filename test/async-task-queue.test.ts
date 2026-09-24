import { describe, expect, it } from 'vitest';

import { createAsyncTaskQueue } from '../src/renderer/transfer/async-task-queue';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('async task queue', () => {
  it('limits concurrency and preserves FIFO order', async () => {
    const queue = createAsyncTaskQueue<number>(1);
    const started: string[] = [];
    const completed: string[] = [];
    const resolvers: Array<() => void> = [];

    const enqueue = (key: string) => queue.enqueue({
      key,
      run: () => new Promise<void>((resolve) => {
        started.push(key);
        resolvers.push(() => {
          completed.push(key);
          resolve();
        });
      }),
    });

    expect(enqueue('a')).toBe(true);
    expect(enqueue('b')).toBe(true);
    expect(enqueue('a')).toBe(false);
    await flush();
    expect(started).toEqual(['a']);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);

    resolvers[0]();
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(0);

    resolvers[1]();
    await flush();
    expect(completed).toEqual(['a', 'b']);
    expect(queue.activeCount).toBe(0);
  });

  it('can remove a pending job without disturbing active work', async () => {
    const queue = createAsyncTaskQueue<void>(1);
    let release!: () => void;
    const started: string[] = [];

    queue.enqueue({
      key: 'active',
      run: () => new Promise<void>((resolve) => {
        started.push('active');
        release = resolve;
      }),
    });
    queue.enqueue({ key: 'pending', run: () => { started.push('pending'); } });
    await flush();

    expect(queue.remove('pending')).toBe(true);
    expect(queue.remove('pending')).toBe(false);
    release();
    await flush();
    expect(started).toEqual(['active']);
  });
});
