import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createSftpTransferService } from '../server/sftp-transfer.cjs';
import { ensureRemoteDirectory } from '../server/sftp-items.cjs';

function missing() {
  return Object.assign(new Error('missing'), { code: 2 });
}

/** 内存 SFTP：在 sftp-transfer 测试 mock 基础上增加 mkdir/目录跟踪。 */
function createSftp(files = new Map<string, Buffer>(), dirs = new Set<string>()) {
  const handles = new Map<string, { path: string; buffer: Buffer }>();
  let handleSeq = 0;
  const exists = (p: string) => files.has(p) || dirs.has(p);
  return {
    dirs,
    lstat(remotePath: string, callback: Function) {
      if (!exists(remotePath)) {
        callback(missing());
        return;
      }
      callback(null, { size: files.get(remotePath)?.length ?? 0 });
    },
    mkdir(remotePath: string, callback: Function) {
      if (exists(remotePath)) {
        callback(Object.assign(new Error('Failure'), { code: 4 }));
        return;
      }
      dirs.add(remotePath);
      callback(null);
    },
    open(remotePath: string, flags: string, callback: Function) {
      const id = `h${(handleSeq += 1)}`;
      if (flags === 'w' || flags === 'w+') {
        handles.set(id, { path: remotePath, buffer: Buffer.alloc(0) });
      } else {
        handles.set(id, { path: remotePath, buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)) });
      }
      callback(null, id);
    },
    write(handle: string, data: Buffer, offset: number, length: number, position: number, callback: Function) {
      const entry = handles.get(handle)!;
      const chunk = data.subarray(offset, offset + length);
      const next = Buffer.alloc(Math.max(entry.buffer.length, position + chunk.length));
      entry.buffer.copy(next);
      chunk.copy(next, position);
      entry.buffer = next;
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

describe('ensureRemoteDirectory', () => {
  it('recursively creates missing directories (mkdir -p)', async () => {
    const sftp = createSftp();
    await ensureRemoteDirectory(sftp, '/a/b/c');
    expect(sftp.dirs.has('/a')).toBe(true);
    expect(sftp.dirs.has('/a/b')).toBe(true);
    expect(sftp.dirs.has('/a/b/c')).toBe(true);
  });

  it('is idempotent for existing directories', async () => {
    const sftp = createSftp();
    sftp.dirs.add('/a');
    sftp.dirs.add('/a/b');
    await ensureRemoteDirectory(sftp, '/a/b/c');
    expect(sftp.dirs.has('/a/b/c')).toBe(true);
    // 已存在层级不重复 mkdir（mkdir 对已存在会抛 code 4，若误调会失败）
    await ensureRemoteDirectory(sftp, '/a/b/c');
    expect(sftp.dirs.size).toBe(3);
  });

  it('rejects path traversal', async () => {
    const sftp = createSftp();
    await expect(ensureRemoteDirectory(sftp, '/a/../b')).rejects.toThrow(/traversal/i);
  });
});

describe('folder upload (relativePath)', () => {
  function makeService(sftp: ReturnType<typeof createSftp>) {
    return createSftpTransferService({
      getSftp: async () => sftp,
      emitEvent: () => undefined,
    });
  }

  it('creates nested parents and commits the file at the nested path', async () => {
    const files = new Map<string, Buffer>();
    const sftp = createSftp(files);
    const service = makeService(sftp);
    const created = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'a.txt', ref: 'web-file:a', size: 5, relativePath: 'proj/sub/a.txt' }],
    });
    const task = created.tasks[0];
    expect(task.remotePath).toBe('/uploads/proj/sub/a.txt');
    await service.upload('client-a', task.taskId, requestLike([Buffer.from('hello')], {
      'content-length': '5',
      'x-sftp-source-size': '5',
      'x-sftp-source-mtime': '100',
    }));
    expect(files.get('/uploads/proj/sub/a.txt')!.toString()).toBe('hello');
    expect(sftp.dirs.has('/uploads/proj/sub')).toBe(true);
    expect(service.list('client-a').tasks[0].status).toBe('completed');
  });

  it('rejects relativePath with .. traversal', () => {
    const service = makeService(createSftp());
    expect(() => service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'a.txt', ref: 'web-file:a', size: 1, relativePath: '../evil.txt' }],
    })).toThrow(/relative upload path/i);
  });

  it('rejects absolute relativePath', () => {
    const service = makeService(createSftp());
    expect(() => service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'a.txt', ref: 'web-file:a', size: 1, relativePath: '/etc/passwd' }],
    })).toThrow(/relative upload path/i);
  });

  it('flat upload (no relativePath) does not create extra directories', async () => {
    const files = new Map<string, Buffer>();
    const sftp = createSftp(files);
    sftp.dirs.add('/uploads');
    const service = makeService(sftp);
    const created = service.startUpload('client-a', {
      connectionId: 'connection-a',
      remoteDirectory: '/uploads',
      files: [{ name: 'flat.txt', ref: 'web-file:flat', size: 2 }],
    });
    await service.upload('client-a', created.tasks[0].taskId, requestLike([Buffer.from('hi')], {
      'x-sftp-source-size': '2',
      'x-sftp-source-mtime': '1',
    }));
    expect(files.get('/uploads/flat.txt')!.toString()).toBe('hi');
    expect(sftp.dirs.size).toBe(1); // 仅预置的 /uploads，未额外 mkdir
  });
});