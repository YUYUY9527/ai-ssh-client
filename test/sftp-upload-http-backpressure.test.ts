import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { createSftpTransferService } from '../server/sftp-transfer.cjs';

/**
 * 真实 HTTP + 背压回归测试。
 *
 * 背景：看门狗曾用 `request.socket.on('data', markActivity)` 采集活动信号。上传在
 * writePipelined 开始消费前有若干 SFTP 往返（lstat/读 checkpoint/open），期间请求体已
 * 在途，Node 会因背压暂停 socket；额外的 socket 'data' 监听破坏解析器的 pause/resume
 * 簿记，socket 暂停后不再恢复，请求体只交付第一块就永久断流——表现为上传卡 0%、目标锁
 * 被占。修复改为在“字节被消费处”（包一层异步生成器）采集活动。
 *
 * 既有的 lifecycle/speed 测试用合成 Readable（无 socket），测不到这条路径。本测试起一个
 * 真实 http.Server，把真实 IncomingMessage 交给 service.upload，并故意延迟 open，让请求体
 * 在消费开始前就堆满缓冲、触发 socket 暂停。旧实现会在此卡死（测试超时失败），修复后应顺利
 * 完成。
 */

function missing() {
  return Object.assign(new Error('missing'), { code: 2 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 内存 SFTP；open 故意延迟，模拟前置 SFTP 往返，使请求体在消费前触发背压暂停。 */
function createDelayedSftp(openDelayMs: number, files = new Map<string, Buffer>()) {
  const handles = new Map<string, { path: string; buffer: Buffer }>();
  let handleSeq = 0;
  return {
    files,
    lstat(remotePath: string, callback: Function) {
      if (!files.has(remotePath)) return callback(missing());
      callback(null, { size: files.get(remotePath)!.length });
    },
    async open(remotePath: string, flags: string, callback: Function) {
      await sleep(openDelayMs);
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
      if (!files.has(source)) return callback(missing());
      if (files.has(destination)) return callback(Object.assign(new Error('Failure'), { code: 4 }));
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
        if (!files.has(remotePath)) return stream.emit('error', missing());
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

interface Harness {
  baseUrl: string;
  service: any;
  sftp: ReturnType<typeof createDelayedSftp>;
  close: () => Promise<void>;
}

async function startHarness(openDelayMs: number): Promise<Harness> {
  const sftp = createDelayedSftp(openDelayMs);
  const service = createSftpTransferService({
    getSftp: async () => sftp,
    emitEvent: () => undefined,
  });
  const server = http.createServer(async (req, res) => {
    try {
      const taskId = String(req.url || '').split('/').pop();
      const snapshot = await service.upload('client-a', taskId, req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, task: snapshot }));
    } catch (error: any) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, code: error?.code, error: error?.message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    service,
    sftp,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function putChunk(
  baseUrl: string,
  taskId: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/content/${taskId}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('web upload over real HTTP with backpressure', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
  });

  it('completes a large upload even when the body pauses the socket before consumption starts', async () => {
    // open 延迟 300ms：客户端 8MiB 请求体在消费开始前堆满缓冲，socket 被背压暂停。
    harness = await startHarness(300);
    const { service, sftp, baseUrl } = harness;
    const started = service.startUpload('client-a', {
      connectionId: 'conn-a',
      remoteDirectory: '/remote',
      files: [{ name: 'big.bin', ref: 'f0', size: 8 * 1024 * 1024 }],
    });
    const task = started.tasks[0];
    const payload = Buffer.alloc(8 * 1024 * 1024, 7);

    const result = await putChunk(baseUrl, task.taskId, payload, {
      'x-sftp-source-size': String(payload.length),
      'x-sftp-source-mtime': '1700000000000',
      'x-sftp-upload-complete': '1',
    });

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.task.status).toBe('completed');
    expect(result.body.task.transferredBytes).toBe(payload.length);
    // 远端落盘内容完整。
    expect(sftp.files.get('/remote/big.bin')?.equals(payload)).toBe(true);
  }, 20000);

  it('completes a chunked upload (two PUTs) over real HTTP with backpressure', async () => {
    harness = await startHarness(200);
    const { service, sftp, baseUrl } = harness;
    const total = 6 * 1024 * 1024;
    const started = service.startUpload('client-a', {
      connectionId: 'conn-a',
      remoteDirectory: '/remote',
      files: [{ name: 'chunked.bin', ref: 'f0', size: total }],
    });
    const task = started.tasks[0];
    const first = Buffer.alloc(4 * 1024 * 1024, 1);
    const second = Buffer.alloc(2 * 1024 * 1024, 2);

    const r1 = await putChunk(baseUrl, task.taskId, first, {
      'x-sftp-source-size': String(total),
      'x-sftp-source-mtime': '1700000000000',
      'x-sftp-upload-complete': '0',
    });
    expect(r1.status).toBe(200);
    expect(r1.body.task.transferredBytes).toBe(first.length);

    const r2 = await putChunk(baseUrl, task.taskId, second, {
      'x-sftp-source-size': String(total),
      'x-sftp-source-mtime': '1700000000000',
      'x-sftp-resume-offset': String(first.length),
      'x-sftp-upload-complete': '1',
    });
    expect(r2.status).toBe(200);
    expect(r2.body.task.status).toBe('completed');
    expect(r2.body.task.transferredBytes).toBe(total);
    expect(sftp.files.get('/remote/chunked.bin')?.equals(Buffer.concat([first, second]))).toBe(true);
  }, 20000);
});