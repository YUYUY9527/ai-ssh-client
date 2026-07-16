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

    service.cancel('client-a', { taskId: resumeTask.taskId });
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
  });
});
