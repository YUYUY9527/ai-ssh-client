import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  createSftpTransferService,
  temporaryRemotePath,
  checkpointRemotePath,
} from '../server/sftp-transfer.cjs';

function missing() {
  return Object.assign(new Error('missing'), { code: 2 });
}

/** 与 sftp-transfer.test.ts 同口径的内存 SFTP。 */
function createSftp(files = new Map<string, Buffer>()) {
  const handles = new Map<string, { path: string; buffer: Buffer }>();
  let handleSeq = 0;
  return {
    lstat(remotePath: string, callback: Function) {
      if (!files.has(remotePath)) {
        callback(missing());
        return;
      }
      callback(null, { size: files.get(remotePath)!.length });
    },
    open(remotePath: string, flags: string, callback: Function) {
      const id = `h${(handleSeq += 1)}`;
      if (flags === 'w' || flags === 'w+') {
        handles.set(id, { path: remotePath, buffer: Buffer.alloc(0) });
      } else {
        handles.set(id, {
          path: remotePath,
          buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)),
        });
      }
      callback(null, id);
    },
    write(handle: string, data: Buffer, offset: number, length: number, position: number, callback: Function) {
      const entry = handles.get(handle)!;
      const chunk = data.subarray(offset, offset + length);
      if (position === entry.buffer.length) {
        entry.buffer = Buffer.concat([entry.buffer, chunk]);
      } else {
        const next = Buffer.alloc(Math.max(entry.buffer.length, position + chunk.length));
        entry.buffer.copy(next);
        chunk.copy(next, position);
        entry.buffer = next;
      }
      callback(null, offset + length);
    },
    close(handle: string, callback: Function) {
      const entry = handles.get(handle);
      if (entry) {
        files.set(entry.path, entry.buffer);
        handles.delete(handle);
      }
      callback(null);
    },
    rename(source: string, destination: string, callback: Function) {
      if (!files.has(source)) {
        callback(missing());
        return;
      }
      if (files.has(destination)) {
        callback(Object.assign(new Error('Failure'), { code: 4 }));
        return;
      }
      files.set(destination, files.get(source)!);
      files.delete(source);
      callback(null);
    },
    unlink(remotePath: string, callback: Function) {
      files.delete(remotePath);
      callback(null);
    },
    createReadStream(remotePath: string) {
      const stream: any = new EventEmitter();
      stream.readable = true;
      queueMicrotask(() => {
        if (!files.has(remotePath)) {
          stream.emit('error', missing());
          return;
        }
        stream.emit('data', files.get(remotePath));
        stream.emit('end');
      });
      return stream;
    },
    createWriteStream(remotePath: string) {
      const stream: any = new EventEmitter();
      const chunks: Buffer[] = [];
      stream.writable = true;
      stream.end = (data?: Buffer) => {
        if (data) chunks.push(Buffer.from(data));
        files.set(remotePath, Buffer.concat(chunks));
        queueMicrotask(() => stream.emit('close'));
      };
      stream.write = (data: Buffer) => {
        chunks.push(Buffer.from(data));
        return true;
      };
      stream.on = stream.addListener.bind(stream);
      return stream;
    },
  };
}

function requestLike(chunks: Buffer[], headers: Record<string, string> = {}) {
  const stream: any = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

/** 内存 storage 适配器，与 index.cjs 注入的 {load,save} 同契约。 */
function createMemoryStorage(initial: unknown = null) {
  const state = { data: initial as any };
  return {
    state,
    load: () => state.data,
    save: (payload: unknown) => { state.data = payload; },
  };
}

function makeService(sftp: unknown, storage?: { load: () => unknown; save: (p: unknown) => void }) {
  const events: { clientId: string; type: string; payload: any }[] = [];
  const service = createSftpTransferService({
    getSftp: async () => sftp,
    emitEvent: (clientId: string, type: string, payload: unknown) => events.push({ clientId, type, payload }),
    storage,
  });
  return { service, events };
}

function startOne(service: any, name = 'report.txt', size = 5) {
  return service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name, ref: `web-file:${name}`, size }],
  }).tasks[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sftp-transfer persistence and recovery', () => {
  it('persists tasks and downgrades non-terminal tasks to interrupted on restart', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const storage = createMemoryStorage();
    const { service } = makeService(sftp, storage);

    const done = startOne(service, 'done.txt', 5);
    await service.upload('client-a', done.taskId, requestLike([Buffer.from('hello')], {
      'content-length': '5',
      'x-sftp-source-size': '5',
    }));
    const pending = startOne(service, 'pending.txt', 5);

    // 节流落盘（1s），等到持久化真正发生。
    await vi.waitFor(() => {
      expect(storage.state.data?.tasks?.length).toBe(2);
    }, { timeout: 3000, interval: 25 });

    // “重启”：同一 storage + 同一远端，新建服务实例。
    const { service: restarted } = makeService(sftp, storage);
    const tasks = restarted.list('client-a').tasks;
    expect(tasks).toHaveLength(2);
    const restoredDone = tasks.find((task: any) => task.taskId === done.taskId);
    const restoredPending = tasks.find((task: any) => task.taskId === pending.taskId);
    expect(restoredDone.status).toBe('completed');
    expect(restoredPending.status).toBe('interrupted');
    expect(restoredPending.error).toMatchObject({ code: 'interrupted', retryable: true });
    // interrupted 可重试，重试仍能从远端 checkpoint 续传。
    const retried = await restarted.retry('client-a', { taskId: pending.taskId });
    expect(retried.status).toBe('queued');
  });

  it('keeps remote checkpoint resume offset across restart', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const storage = createMemoryStorage();
    const { service } = makeService(sftp, storage);

    const task = startOne(service, 'big.bin', 100);
    // 只传 10 字节的分片（complete=0），服务端落 checkpoint 后回到 queued。
    await service.upload('client-a', task.taskId, requestLike([Buffer.alloc(10, 7)], {
      'x-sftp-source-size': '100',
      'x-sftp-upload-complete': '0',
    }));
    await vi.waitFor(() => {
      expect(storage.state.data?.tasks?.length).toBe(1);
    }, { timeout: 3000, interval: 25 });

    const { service: restarted } = makeService(sftp, storage);
    const restored = restarted.list('client-a').tasks[0];
    expect(restored.status).toBe('interrupted');
    const retried = await restarted.retry('client-a', { taskId: task.taskId });
    expect(retried.resumedFrom).toBe(10);
    expect(retried.transferredBytes).toBe(10);
  });

  it('starts empty when the persisted file is corrupted', () => {
    const sftp = createSftp();
    const storage = {
      load: () => { throw new Error('corrupted'); },
      save: () => undefined,
    };
    const { service } = makeService(sftp, storage);
    expect(service.list('client-a').tasks).toHaveLength(0);
  });

  it('garbage-collects expired clean terminal records but keeps failed ones', () => {
    const sftp = createSftp();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const record = (taskId: string, status: string, completedAt: number) => ({
      clientId: 'client-a',
      snapshot: {
        taskId,
        connectionId: 'connection-a',
        direction: 'upload',
        name: `${taskId}.txt`,
        remotePath: `/uploads/${taskId}.txt`,
        status,
        attempt: 1,
        sequence: 3,
        createdAt: completedAt,
        updatedAt: completedAt,
        completedAt,
        progress: status === 'completed' ? 100 : 40,
      },
    });
    const storage = createMemoryStorage({
      version: 1,
      tasks: [
        record('old-completed', 'completed', eightDaysAgo),
        record('old-failed', 'failed', eightDaysAgo),
        record('old-interrupted', 'interrupted', eightDaysAgo),
        record('fresh-completed', 'completed', Date.now()),
      ],
    });
    const { service } = makeService(sftp, storage);
    const ids = service.list('client-a').tasks.map((task: any) => task.taskId);
    expect(ids).not.toContain('old-completed');
    // failed/interrupted 持有远端 partial 清理线索，不自动过期。
    expect(ids).toContain('old-failed');
    expect(ids).toContain('old-interrupted');
    expect(ids).toContain('fresh-completed');
  });

  it('caps total records by evicting the oldest clean terminal tasks', () => {
    const sftp = createSftp();
    const base = Date.now() - 100000;
    const tasks = Array.from({ length: 1005 }, (_, index) => ({
      clientId: 'client-a',
      snapshot: {
        taskId: `task-${index}`,
        connectionId: 'connection-a',
        direction: 'upload',
        name: `task-${index}.txt`,
        remotePath: `/uploads/task-${index}.txt`,
        status: 'completed',
        attempt: 1,
        sequence: 3,
        createdAt: base + index,
        updatedAt: base + index,
        completedAt: base + index,
        progress: 100,
      },
    }));
    const storage = createMemoryStorage({ version: 1, tasks });
    const { service } = makeService(sftp, storage);
    const ids = service.list('client-a').tasks.map((task: any) => task.taskId);
    expect(ids).toHaveLength(1000);
    expect(ids).not.toContain('task-0');
    expect(ids).not.toContain('task-4');
    expect(ids).toContain('task-5');
    expect(ids).toContain('task-1004');
  });
});

describe('sftp-transfer cancel semantics', () => {
  it('treats a request aborted after cancel as canceled and removes partial files', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const { service } = makeService(sftp);
    const task = startOne(service, 'big.bin', 100);

    // 只推一个块然后保持打开，模拟传输中的请求。
    const request: any = new Readable({ read() { /* 等待更多数据 */ } });
    request.headers = { 'x-sftp-source-size': '100', 'x-sftp-upload-complete': '0' };
    request.push(Buffer.alloc(10, 1));

    const uploading = service.upload('client-a', task.taskId, request);
    await vi.waitFor(() => {
      expect(service.list('client-a').tasks[0].status).toBe('transferring');
    }, { timeout: 3000, interval: 10 });

    service.cancel('client-a', { taskId: task.taskId });
    expect(service.list('client-a').tasks[0].status).toBe('canceling');

    // 客户端 abort / 网络断开以“非 canceled”错误到达：仍必须按取消收尾。
    request.destroy(new Error('connection reset'));
    const settled = await uploading;
    expect(settled.status).toBe('canceled');

    const partial = temporaryRemotePath('/uploads/big.bin', task.taskId);
    expect(remoteFiles.has(partial)).toBe(false);
    expect(remoteFiles.has(checkpointRemotePath(partial))).toBe(false);
  });
});

describe('sftp-transfer upload watchdog', () => {
  it('fails a stalled upload with upload-stalled after the idle timeout', async () => {
    vi.useFakeTimers();
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const { service } = makeService(sftp);
    const task = startOne(service, 'stalled.bin', 100);

    // 请求永不发送数据：半开连接场景。
    const request: any = new Readable({ read() { /* 永不推数据 */ } });
    request.headers = { 'x-sftp-source-size': '100', 'x-sftp-upload-complete': '0' };

    const uploading = service.upload('client-a', task.taskId, request);
    const rejection = expect(uploading).rejects.toMatchObject({ code: 'upload-stalled' });
    // 看门狗间隔 30s、空闲阈值 180s（server/sftp-transfer.cjs 常量）。
    await vi.advanceTimersByTimeAsync(180000 + 30000);
    await rejection;

    const settled = service.list('client-a').tasks[0];
    expect(settled.status).toBe('failed');
    expect(settled.error).toMatchObject({ code: 'upload-stalled', retryable: true });
  });

  it('does not fire while data keeps flowing', async () => {
    vi.useFakeTimers();
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const { service } = makeService(sftp);
    const task = startOne(service, 'active.bin', 5);

    const uploading = service.upload('client-a', task.taskId, requestLike([Buffer.from('hello')], {
      'content-length': '5',
      'x-sftp-source-size': '5',
    }));
    // 让传输在假时钟下完成；随后长时间推进不应产生任何看门狗错误。
    await vi.advanceTimersByTimeAsync(1000);
    const settled = await uploading;
    expect(settled.status).toBe('completed');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(service.list('client-a').tasks[0].status).toBe('completed');
    expect(remoteFiles.get('/uploads/active.bin')!.toString()).toBe('hello');
  });
});

describe('sftp-transfer conflict response', () => {
  it('drains the request body before responding with conflict', async () => {
    const remoteFiles = new Map<string, Buffer>([['/uploads/report.txt', Buffer.from('old')]]);
    const sftp = createSftp(remoteFiles);
    const { service } = makeService(sftp);
    const task = startOne(service, 'report.txt', 5);

    const request = requestLike([Buffer.from('hello')], {
      'content-length': '5',
      'x-sftp-source-size': '5',
    });
    const resumeSpy = vi.spyOn(request, 'resume');
    await expect(service.upload('client-a', task.taskId, request)).rejects.toMatchObject({ code: 'conflict' });
    // 冲突分支在抛错前排空 body，避免连接被重置导致 409 响应送达不稳定。
    expect(resumeSpy).toHaveBeenCalled();
    const settled = service.list('client-a').tasks[0];
    expect(settled.status).toBe('waiting-conflict');
    expect(settled.conflict?.suggestedName).toBeTruthy();
  });
});
