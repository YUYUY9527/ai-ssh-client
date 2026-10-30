import { describe, it, expect } from 'vitest';
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

/** 简易内存 SFTP：支持 open/write/read stream/rename/unlink/lstat。 */
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
      } else if (flags === 'r' || flags === 'r+') {
        if (!files.has(remotePath) && flags === 'r') {
          callback(missing());
          return;
        }
        handles.set(id, {
          path: remotePath,
          buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)),
        });
      } else {
        handles.set(id, { path: remotePath, buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)) });
      }
      callback(null, id);
    },
    write(handle: string, data: Buffer, offset: number, length: number, position: number, callback: Function) {
      const entry = handles.get(handle);
      expect(entry).toBeTruthy();
      // 对齐 ssh2：回调返回 bufferOffset + writtenLength，而非文件 position。
      const chunk = data.subarray(offset, offset + length);
      if (position === entry!.buffer.length) {
        entry!.buffer = Buffer.concat([entry!.buffer, chunk]);
      } else if (position < entry!.buffer.length) {
        const next = Buffer.alloc(Math.max(entry!.buffer.length, position + chunk.length));
        entry!.buffer.copy(next);
        chunk.copy(next, position);
        entry!.buffer = next;
      } else {
        const next = Buffer.alloc(position + chunk.length);
        entry!.buffer.copy(next);
        chunk.copy(next, position);
        entry!.buffer = next;
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

describe('sftp-transfer', () => {
  it('handles uploads, conflicts, batches, and resume', async () => {
    const events: { clientId: string; type: string; payload: unknown }[] = [];
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const service = createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: (clientId: string, type: string, payload: unknown) => events.push({ clientId, type, payload }),
    });

    const created = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'report.txt', ref: 'web-file:report', size: 5 }],
    });
    const task = created.tasks[0];
    await service.upload('client-a', task.taskId, requestLike([Buffer.from('hello')], {
      'content-length': '5',
      'x-sftp-source-size': '5',
      'x-sftp-source-mtime': '100',
    }));

    expect(remoteFiles.get('/uploads/report.txt')!.toString()).toBe('hello');
    const completed = service.list('client-a').tasks[0];
    expect(completed.status).toBe('completed');
    expect(completed.progress).toBe(100);
    expect(completed.commitGuarantee).toBe('atomic-create');
    expect(events.every((event) => event.clientId === 'client-a')).toBe(true);

    // 多块写入（>64KiB）：ssh2 回调返回 buffer 端偏移，不能当文件绝对偏移累加
    const largeSize = 70 * 1024;
    const largePayload = Buffer.alloc(largeSize, 7);
    const largeCreated = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'large.bin', ref: 'web-file:large', size: largeSize }],
    });
    const largeTask = largeCreated.tasks[0];
    await service.upload('client-a', largeTask.taskId, requestLike([largePayload], {
      'content-length': String(largeSize),
      'x-sftp-source-size': String(largeSize),
      'x-sftp-source-mtime': '200',
    }));
    expect(remoteFiles.get('/uploads/large.bin')!.length).toBe(largeSize);
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === largeTask.taskId).status,
    ).toBe('completed');

    remoteFiles.set('/uploads/existing.txt', Buffer.from('old'));
    const conflicted = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'existing.txt', ref: 'web-file:existing', size: 3 }],
    }).tasks[0];
    await expect(
      service.upload('client-a', conflicted.taskId, requestLike([Buffer.from('new')], {
        'x-sftp-source-size': '3',
        'x-sftp-source-mtime': '1',
      })),
    ).rejects.toThrow(/Destination already exists/);
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === conflicted.taskId).status,
    ).toBe('waiting-conflict');
    expect(() => service.resolveConflict('client-b', {
      taskId: conflicted.taskId,
      attempt: 1,
      policy: 'overwrite',
    })).toThrow(/not found/);
    service.resolveConflict('client-a', {
      taskId: conflicted.taskId,
      attempt: 1,
      policy: 'overwrite',
    });
    await service.upload('client-a', conflicted.taskId, requestLike([Buffer.from('new')], {
      'x-sftp-source-size': '3',
      'x-sftp-source-mtime': '1',
    }));
    expect(remoteFiles.get('/uploads/existing.txt')!.toString()).toBe('new');
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === conflicted.taskId).commitGuarantee,
    ).toBe('best-effort-replace');

    remoteFiles.set('/uploads/a.txt', Buffer.from('a'));
    remoteFiles.set('/uploads/b.txt', Buffer.from('b'));
    const batch = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [
        { name: 'a.txt', ref: 'web-file:a', size: 1 },
        { name: 'b.txt', ref: 'web-file:b', size: 1 },
      ],
    }).tasks;
    await expect(
      service.upload('client-a', batch[0].taskId, requestLike([Buffer.from('1')])),
    ).rejects.toThrow(/Destination already exists/);
    await expect(
      service.upload('client-a', batch[1].taskId, requestLike([Buffer.from('2')])),
    ).rejects.toThrow(/Destination already exists/);
    service.resolveConflict('client-a', {
      taskId: batch[0].taskId,
      attempt: 1,
      policy: 'skip',
      applyToBatch: true,
    });
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === batch[0].taskId).status,
    ).toBe('queued');
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === batch[1].taskId).conflictPolicy,
    ).toBe('skip');

    // 续传：先写入 partial + checkpoint，再以 offset 续传。
    const resumeTask = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'resume.bin', ref: 'web-file:resume', size: 10 }],
    }).tasks[0];
    const tempPath = temporaryRemotePath('/uploads/resume.bin', resumeTask.taskId);
    const metaPath = checkpointRemotePath(tempPath);
    remoteFiles.set(tempPath, Buffer.from('hello'));
    remoteFiles.set(metaPath, Buffer.from(JSON.stringify({
      taskId: resumeTask.taskId,
      sourceSize: 10,
      sourceMtime: 42,
      sourceHead: 'aa',
      sourceTail: 'bb',
      totalBytes: 10,
      confirmedOffset: 5,
      destinationPath: '/uploads/resume.bin',
    })));

    await service.cancel('client-a', { taskId: resumeTask.taskId });
    const retried = await service.retry('client-a', { taskId: resumeTask.taskId });
    expect(retried.resumedFrom).toBe(5);
    await service.upload('client-a', resumeTask.taskId, requestLike([Buffer.from('world')], {
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '42',
      'x-sftp-source-head': 'aa',
      'x-sftp-source-tail': 'bb',
      'x-sftp-resume-offset': '5',
    }));
    expect(remoteFiles.get('/uploads/resume.bin')!.toString()).toBe('helloworld');
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === resumeTask.taskId).status,
    ).toBe('completed');

    // 源变化应失败并清理 partial。
    const changed = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'changed.bin', ref: 'web-file:changed', size: 4 }],
    }).tasks[0];
    const changedTemp = temporaryRemotePath('/uploads/changed.bin', changed.taskId);
    remoteFiles.set(changedTemp, Buffer.from('ab'));
    remoteFiles.set(checkpointRemotePath(changedTemp), Buffer.from(JSON.stringify({
      taskId: changed.taskId,
      sourceSize: 4,
      sourceMtime: 1,
      totalBytes: 4,
      confirmedOffset: 2,
      destinationPath: '/uploads/changed.bin',
    })));
    await expect(
      service.upload('client-a', changed.taskId, requestLike([Buffer.from('xx')], {
        'x-sftp-source-size': '4',
        'x-sftp-source-mtime': '999',
        'x-sftp-resume-offset': '2',
      })),
    ).rejects.toThrow(/Source file changed/);

    // 分片上传：complete=0 不提交，complete=1 提交
    const chunked = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'chunked.bin', ref: 'web-file:chunked', size: 10 }],
    }).tasks[0];
    const partial = await service.upload('client-a', chunked.taskId, requestLike([Buffer.from('hello')], {
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '7',
      'x-sftp-source-head': 'h1',
      'x-sftp-source-tail': 't1',
      'x-sftp-resume-offset': '0',
      'x-sftp-upload-complete': '0',
    }));
    expect(partial.status).toBe('queued');
    expect(partial.transferredBytes).toBe(5);
    expect(partial.progress).toBe(50);
    expect(remoteFiles.has('/uploads/chunked.bin')).toBe(false);
    expect(remoteFiles.get(temporaryRemotePath('/uploads/chunked.bin', chunked.taskId))!.toString()).toBe('hello');

    const done = await service.upload('client-a', chunked.taskId, requestLike([Buffer.from('world')], {
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '7',
      'x-sftp-source-head': 'h1',
      'x-sftp-source-tail': 't1',
      'x-sftp-resume-offset': '5',
      'x-sftp-upload-complete': '1',
    }));
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(remoteFiles.get('/uploads/chunked.bin')!.toString()).toBe('helloworld');
  });

  it('throttles intermediate transfer snapshots for fast large writes', async () => {
    const events: { clientId: string; type: string; payload: unknown }[] = [];
    const sftp = createSftp(new Map());
    const service = createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: (clientId: string, type: string, payload: unknown) => events.push({ clientId, type, payload }),
    });
    const size = 2 * 1024 * 1024;
    const task = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'throttled.bin', ref: 'web-file:throttled', size }],
    }).tasks[0];

    await service.upload('client-a', task.taskId, requestLike([Buffer.alloc(size, 3)], {
      'content-length': String(size),
      'x-sftp-source-size': String(size),
      'x-sftp-source-mtime': '1',
    }));

    const transferringSnapshots = events.filter((event) => {
      const payload = event.payload as { snapshot?: { taskId: string; status: string } };
      return payload.snapshot?.taskId === task.taskId && payload.snapshot.status === 'transferring';
    });
    expect(transferringSnapshots.length).toBeLessThanOrEqual(2);
    expect(service.list('client-a').tasks[0].status).toBe('completed');
  });


  it('removes partial and checkpoint files when an active upload is canceled', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const service = createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: () => {},
    });
    const task = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'cancel.bin', ref: 'web-file:cancel', size: 10 }],
    }).tasks[0];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* chunks() {
      yield Buffer.from('hello');
      await gate;
      yield Buffer.from('world');
    }
    const request: any = Readable.from(chunks());
    request.headers = {
      'content-length': '10',
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '1',
    };

    const upload = service.upload('client-a', task.taskId, request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.cancel('client-a', { taskId: task.taskId });
    release();
    await upload;

    const temporary = temporaryRemotePath('/uploads/cancel.bin', task.taskId);
    expect(remoteFiles.has(temporary)).toBe(false);
    expect(remoteFiles.has(checkpointRemotePath(temporary))).toBe(false);
    expect(service.list('client-a').tasks[0].status).toBe('canceled');
  });


  it('embeds the client identity in handed-off download urls', () => {
    const service = createSftpTransferService({
      getSftp: async () => createSftp(new Map()),
      emitEvent: () => {},
    });

    const handedOff = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zerui/nvr.pcap'],
      conflictPolicy: 'ask',
    }, '/api/sftp').tasks[0];

    expect(handedOff.status).toBe('handed-off');
    const url = new URL(handedOff.downloadUrl, 'https://example.test');
    expect(url.pathname).toBe('/api/sftp/connection-a/download');
    expect(url.searchParams.get('path')).toBe('/home/zerui/nvr.pcap');
    expect(url.searchParams.get('clientId')).toBe('client-a');

    // FSA 流式落盘走 fetch（带请求头），不需要 URL 上的 clientId，但保留也无害。
    const streaming = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zerui/nvr.pcap'],
      destination: { ref: 'web-dir:1', name: 'downloads' },
      conflictPolicy: 'ask',
    }, '/api/sftp').tasks[0];
    expect(streaming.status).toBe('queued');
    expect(new URL(streaming.downloadUrl, 'https://example.test').searchParams.get('clientId'))
      .toBe('client-a');
  });

  it('rejects uploads whose claimed resume offset exceeds the server trusted offset', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const service = createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: () => {},
    });
    const task = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'reset.bin', ref: 'web-file:reset', size: 10 }],
    }).tasks[0];
    const tempPath = temporaryRemotePath('/uploads/reset.bin', task.taskId);
    const metaPath = checkpointRemotePath(tempPath);
    // partial 已有 5 字节，但 checkpoint 只确认到 0（可信偏移 0）。
    remoteFiles.set(tempPath, Buffer.from('hello'));
    remoteFiles.set(metaPath, Buffer.from(JSON.stringify({
      taskId: task.taskId,
      sourceSize: 10,
      sourceMtime: 42,
      totalBytes: 10,
      confirmedOffset: 0,
      destinationPath: '/uploads/reset.bin',
    })));

    let caught: any;
    try {
      await service.upload('client-a', task.taskId, requestLike([Buffer.from('world')], {
        'x-sftp-source-size': '10',
        'x-sftp-source-mtime': '42',
        'x-sftp-resume-offset': '5',
        'x-sftp-upload-complete': '1',
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeTruthy();
    expect(caught.code).toBe('resume-offset-reset');
    expect(caught.confirmedOffset).toBe(0);
    expect(caught.task?.status).toBe('queued');
    expect(caught.task?.resumedFrom).toBe(0);
    // 不能把 “world” 写到偏移 0 并提交；目标文件不得被创建。
    expect(remoteFiles.has('/uploads/reset.bin')).toBe(false);
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === task.taskId).status,
    ).toBe('queued');

    // 按服务端确认的偏移 0 用完整内容重传应成功（helloworld，而不是 world）。
    await service.upload('client-a', task.taskId, requestLike([Buffer.from('helloworld')], {
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '42',
      'x-sftp-resume-offset': '0',
      'x-sftp-upload-complete': '1',
    }));
    expect(remoteFiles.get('/uploads/reset.bin')!.toString()).toBe('helloworld');
    expect(
      service.list('client-a').tasks.find((item: any) => item.taskId === task.taskId).status,
    ).toBe('completed');
  });

  it('keeps a valid upload resume (hello + world -> helloworld)', async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sftp = createSftp(remoteFiles);
    const service = createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: () => {},
    });
    const task = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'valid.bin', ref: 'web-file:valid', size: 10 }],
    }).tasks[0];
    const tempPath = temporaryRemotePath('/uploads/valid.bin', task.taskId);
    remoteFiles.set(tempPath, Buffer.from('hello'));
    remoteFiles.set(checkpointRemotePath(tempPath), Buffer.from(JSON.stringify({
      taskId: task.taskId,
      sourceSize: 10,
      sourceMtime: 7,
      totalBytes: 10,
      confirmedOffset: 5,
      destinationPath: '/uploads/valid.bin',
    })));

    const done = await service.upload('client-a', task.taskId, requestLike([Buffer.from('world')], {
      'x-sftp-source-size': '10',
      'x-sftp-source-mtime': '7',
      'x-sftp-resume-offset': '5',
      'x-sftp-upload-complete': '1',
    }));
    expect(done.status).toBe('completed');
    expect(remoteFiles.get('/uploads/valid.bin')!.toString()).toBe('helloworld');
  });

  it('reports browser-managed download status and allows retry after failure', async () => {
    const service = createSftpTransferService({
      getSftp: async () => createSftp(new Map()),
      emitEvent: () => {},
    });

    const started = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zero/a.bin'],
      destination: { ref: 'web-dir:1', name: 'downloads' },
      conflictPolicy: 'ask',
    }, '/api/sftp').tasks[0];
    expect(started.status).toBe('queued');
    expect(started.direction).toBe('download');

    // transferring 更新字节与进度
    const transferring = service.reportDownload('client-a', {
      taskId: started.taskId,
      attempt: started.attempt,
      status: 'transferring',
      transferredBytes: 50,
      totalBytes: 100,
    });
    expect(transferring.status).toBe('transferring');
    expect(transferring.transferredBytes).toBe(50);
    expect(transferring.progress).toBe(50);

    // completed 由浏览器代为完成，标记 browser-managed
    const completed = service.reportDownload('client-a', {
      taskId: started.taskId,
      attempt: started.attempt,
      status: 'completed',
      transferredBytes: 100,
      totalBytes: 100,
    });
    expect(completed.status).toBe('completed');
    expect(completed.progress).toBe(100);
    expect(completed.transferredBytes).toBe(100);
    expect(completed.commitGuarantee).toBe('browser-managed');

    // 已终态的任务忽略迟到的回报
    const ignored = service.reportDownload('client-a', {
      taskId: started.taskId,
      attempt: started.attempt,
      status: 'failed',
      error: { message: 'late report' },
    });
    expect(ignored.status).toBe('completed');

    // committed 状态的失败回报：status failed + retry 允许
    const failing = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zero/b.bin'],
      destination: { ref: 'web-dir:1', name: 'downloads' },
    }, '/api/sftp').tasks[0];
    const failed = service.reportDownload('client-a', {
      taskId: failing.taskId,
      attempt: failing.attempt,
      status: 'failed',
      transferredBytes: 10,
      totalBytes: 100,
      error: { code: 'io-error', message: 'network broke', retryable: true },
    });
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toBe('network broke');
    expect(failed.error?.retryable).toBe(true);

    const retried = await service.retry('client-a', { taskId: failing.taskId });
    expect(retried.status).toBe('queued');
    expect(retried.attempt).toBe(2);
    expect(retried.error).toBeUndefined();

    // 仍在 queued 的任务不可重试
    await expect(service.retry('client-a', { taskId: failing.taskId }))
      .rejects.toThrow(/not retryable/);

    // skipped 终态
    const skipping = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zero/c.bin'],
      destination: { ref: 'web-dir:1', name: 'downloads' },
    }, '/api/sftp').tasks[0];
    expect(service.reportDownload('client-a', { taskId: skipping.taskId, attempt: skipping.attempt, status: 'skipped' }).status)
      .toBe('skipped');

    // 非下载任务不能回报下载状态
    const upload = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'u.txt', ref: 'web-file:u', size: 1 }],
    }).tasks[0];
    expect(() => service.reportDownload('client-a', { taskId: upload.taskId, attempt: upload.attempt, status: 'transferring' }))
      .toThrow(/not a download/);

    // 不属于该客户端的任务不能回报
    expect(() => service.reportDownload('client-b', { taskId: failing.taskId, attempt: failing.attempt, status: 'transferring' }))
      .toThrow(/not found/);
  });

  it('ignores stale download reports from a previous attempt after retry', async () => {
    const service = createSftpTransferService({
      getSftp: async () => createSftp(new Map()),
      emitEvent: () => {},
    });
    const task = service.startDownload('client-a', {
      connectionId: 'connection-a',
      remotePaths: ['/home/zero/stale.bin'],
      destination: { ref: 'web-dir:1', name: 'downloads' },
    }, '/api/sftp').tasks[0];

    // attempt 1 失败 -> 可重试
    const failed = service.reportDownload('client-a', {
      taskId: task.taskId,
      attempt: task.attempt,
      status: 'failed',
      error: { message: 'boom' },
    });
    expect(failed.status).toBe('failed');

    const retried = await service.retry('client-a', { taskId: task.taskId });
    expect(retried.status).toBe('queued');
    expect(retried.attempt).toBe(2);

    // attempt 1 的迟到 canceled 不得影响 attempt 2
    const staleCanceled = service.reportDownload('client-a', {
      taskId: task.taskId,
      attempt: 1,
      status: 'canceled',
    });
    expect(staleCanceled.status).toBe('queued');
    expect(staleCanceled.attempt).toBe(2);

    // attempt 1 的迟到 transferring 也不能改写 attempt 2
    const staleTransferring = service.reportDownload('client-a', {
      taskId: task.taskId,
      attempt: 1,
      status: 'transferring',
      transferredBytes: 50,
      totalBytes: 100,
    });
    expect(staleTransferring.status).toBe('queued');
    expect(staleTransferring.transferredBytes).toBe(0);

    // 缺失 attempt 的回报同样忽略
    expect(service.reportDownload('client-a', { taskId: task.taskId, status: 'canceled' }).status)
      .toBe('queued');

    // 匹配 attempt 2 的 canceled 才真正取消
    const canceled = service.reportDownload('client-a', {
      taskId: task.taskId,
      attempt: 2,
      status: 'canceled',
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled.attempt).toBe(2);
  });
});
