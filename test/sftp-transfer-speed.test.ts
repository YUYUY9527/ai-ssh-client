import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  createSftpTransferService,
  temporaryRemotePath,
  checkpointRemotePath,
} from '../server/sftp-transfer.cjs';
import { readSftpSmallFile, EDGE_BYTES } from '../server/sftp-download-validator.cjs';

function missing() {
  return Object.assign(new Error('missing'), { code: 2 });
}

/**
 * 内存 SFTP + 可控 meta 写入：createWriteStream 只被 checkpoint sidecar 使用，
 * 这里把它的 close 扣住，直到 release() 才放行，用来观察“checkpoint 在途时
 * 写管线是否继续前进”。sftp.write 记录每次写的位置，供断言在途窗口。
 */
function createControllableSftp(files = new Map<string, Buffer>()) {
  const handles = new Map<string, { path: string; buffer: Buffer }>();
  let handleSeq = 0;
  const writeLog: { position: number; length: number }[] = [];
  const metaOffsets: number[] = [];
  const heldStreams: { release: () => void }[] = [];
  let released = false;
  let metaStarts = 0;

  const sftp = {
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
      writeLog.push({ position, length });
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
      metaStarts += 1;
      stream.end = (data?: Buffer) => {
        if (data) chunks.push(Buffer.from(data));
        const payload = Buffer.concat(chunks);
        files.set(remotePath, payload);
        try {
          metaOffsets.push(JSON.parse(payload.toString('utf8')).confirmedOffset);
        } catch { /* 损坏内容不参与断言 */ }
        const emitClose = () => queueMicrotask(() => stream.emit('close'));
        if (released) {
          emitClose();
        } else {
          heldStreams.push({ release: emitClose });
        }
      };
      stream.write = (data: Buffer) => {
        chunks.push(Buffer.from(data));
        return true;
      };
      return stream;
    },
  };

  return {
    sftp,
    writeLog,
    metaOffsets,
    get metaStarts() { return metaStarts; },
    maxWritten: () => writeLog.reduce((max, entry) => Math.max(max, entry.position + entry.length), 0),
    release: () => {
      released = true;
      const held = heldStreams.splice(0);
      for (const entry of held) entry.release();
    },
  };
}

function requestLike(chunks: Buffer[], headers: Record<string, string> = {}) {
  const stream: any = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

function makeService(sftp: unknown) {
  const events: unknown[] = [];
  const service = createSftpTransferService({
    getSftp: async () => sftp,
    emitEvent: (clientId: string, type: string, payload: unknown) => events.push({ clientId, type, payload }),
  });
  return { service, events };
}

function startOne(service: any, name: string, size: number) {
  return service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name, ref: `web-file:${name}`, size }],
  }).tasks[0];
}

const MiB = 1024 * 1024;

afterEach(() => {
  vi.useRealTimers();
});

describe('sftp-transfer checkpoint pipeline', () => {
  it('keeps writing while a checkpoint is in flight (no pipeline stall)', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const control = createControllableSftp(remoteFiles);
    const { service } = makeService(control.sftp);
    const size = 9 * MiB;
    const task = startOne(service, 'big.bin', size);

    const uploading = service.upload('client-a', task.taskId, requestLike([Buffer.alloc(size, 3)], {
      'x-sftp-source-size': String(size),
    }));

    // 第一个 4MiB checkpoint 触发后，meta 写被扣住。
    await vi.waitFor(() => {
      expect(control.metaStarts).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000, interval: 5 });

    // 关键断言：meta 仍在途，数据写已经推进到整个 9MiB。
    // 旧实现 onAck await checkpoint，写管线会停在 ~4MiB+窗口 处。
    await vi.waitFor(() => {
      expect(control.maxWritten()).toBe(size);
    }, { timeout: 3000, interval: 5 });
    expect(control.metaStarts).toBeGreaterThanOrEqual(1);

    // 首个 checkpoint 恰好落在 4MiB 阈值。
    expect(control.metaOffsets[0]).toBe(4 * MiB);

    control.release();
    const settled = await uploading;
    expect(settled.status).toBe('completed');
    expect(remoteFiles.get('/uploads/big.bin')!.length).toBe(size);
    // 提交后 sidecar 必须被清理，且在途后台写没有把它重建出来。
    const partial = temporaryRemotePath('/uploads/big.bin', task.taskId);
    expect(remoteFiles.has(checkpointRemotePath(partial))).toBe(false);
  });

  it('chases the latest offset while transferring, and cancel leaves no orphan meta', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const control = createControllableSftp(remoteFiles);
    const { service } = makeService(control.sftp);
    const task = startOne(service, 'cancel.bin', 100 * MiB);

    // 保持请求流打开（分片未结束）：写管线会持续等待更多数据，传输不会收尾，
    // 这样放行被扣住的 checkpoint 时还能观察到“单飞追写最新偏移”。
    // 注意：确认偏移 = 已推送 - 在途窗口(2MiB)，推 10MiB 才能确认到 8MiB，
    // 越过 4MiB（首写，扣住）与 8MiB（记为 pending）两个阈值。
    const request: any = new Readable({ read() { /* 等待更多数据 */ } });
    request.headers = { 'x-sftp-source-size': String(100 * MiB), 'x-sftp-upload-complete': '0' };
    request.push(Buffer.alloc(10 * MiB, 1));

    const uploading = service.upload('client-a', task.taskId, request);
    await vi.waitFor(() => {
      expect(service.list('client-a').tasks[0].transferredBytes).toBeGreaterThanOrEqual(8 * MiB);
    }, { timeout: 3000, interval: 5 });
    // 4MiB checkpoint 在途被扣住；8MiB 只记录为 pending，还没有第二次 meta 写。
    expect(control.metaStarts).toBe(1);
    expect(control.metaOffsets).toEqual([4 * MiB]);

    // 放行首写：传输仍在进行（未 stop），应当追写最新偏移 8MiB。
    control.release();
    await vi.waitFor(() => {
      expect(control.metaOffsets.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000, interval: 5 });
    expect(control.metaOffsets[control.metaOffsets.length - 1]).toBe(8 * MiB);

    service.cancel('client-a', { taskId: task.taskId });
    request.destroy(new Error('connection reset'));

    // 取消清理必须等后台 checkpoint 落地后再删，否则在途写会重建 meta。
    const settled = await uploading;
    expect(settled.status).toBe('canceled');

    // 给任何可能的“重建”留出执行机会，然后断言确实没有残留。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const partial = temporaryRemotePath('/uploads/cancel.bin', task.taskId);
    expect(remoteFiles.has(partial)).toBe(false);
    expect(remoteFiles.has(checkpointRemotePath(partial))).toBe(false);
  });
});

describe('readSftpSmallFile', () => {
  it('returns the whole file once with head == tail == sha256(content)', async () => {
    const content = Buffer.alloc(EDGE_BYTES - 123, 9);
    const files = new Map<string, Buffer>([['/remote/small.bin', content]]);
    let reads = 0;
    const sftp = {
      createReadStream(remotePath: string) {
        reads += 1;
        const stream: any = new EventEmitter();
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
    };
    const result = await readSftpSmallFile(sftp, '/remote/small.bin', content.length);
    expect(reads).toBe(1);
    expect(result.data.equals(content)).toBe(true);
    const digest = createHash('sha256').update(content).digest('hex');
    expect(result.head).toBe(digest);
    expect(result.tail).toBe(digest);
  });
});
