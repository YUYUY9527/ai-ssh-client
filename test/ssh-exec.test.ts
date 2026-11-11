import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { execCommand } from '../server/ssh-exec.cjs';

function fakeChannel() {
  const stream: any = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => stream.emit('close', null);
  return stream;
}

describe('独立 exec 通道 execCommand', () => {
  it('收集 stdout 与退出码', async () => {
    const client = {
      exec(_command: string, cb: (error: null, stream: any) => void) {
        const stream = fakeChannel();
        cb(null, stream);
        setImmediate(() => {
          stream.emit('data', Buffer.from('hello '));
          stream.emit('data', Buffer.from('world'));
          stream.emit('close', 0);
        });
        return stream;
      },
    };
    const result = await execCommand(client as never, 'echo hi');
    expect(result.output).toBe('hello world');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('捕获 stderr', async () => {
    const client = {
      exec(_command: string, cb: (error: null, stream: any) => void) {
        const stream = fakeChannel();
        cb(null, stream);
        setImmediate(() => {
          stream.stderr.emit('data', Buffer.from('warn'));
          stream.emit('close', 1);
        });
        return stream;
      },
    };
    const result = await execCommand(client as never, 'cmd');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(1);
  });

  it('超过 maxBytes 截断并标记 truncated', async () => {
    const client = {
      exec(_command: string, cb: (error: null, stream: any) => void) {
        const stream = fakeChannel();
        cb(null, stream);
        setImmediate(() => {
          stream.emit('data', Buffer.alloc(100, 0x61));
          stream.emit('data', Buffer.alloc(100, 0x61));
          stream.emit('close', 0);
        });
        return stream;
      },
    };
    const result = await execCommand(client as never, 'cmd', { maxBytes: 150 });
    expect(result.truncated).toBe(true);
    // 软上限：最多超出一个 chunk（150 + 100），不会无界增长
    expect(result.output.length).toBeLessThanOrEqual(200);
  });

  it('超时拒绝并带 code=timeout', async () => {
    const client = {
      exec(_command: string, cb: (error: null, stream: any) => void) {
        const stream = fakeChannel();
        cb(null, stream);
        return stream; // 永不 close
      },
    };
    await expect(execCommand(client as never, 'sleep', { timeoutMs: 40 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('exec 回调错误直接拒绝', async () => {
    const client = {
      exec(_command: string, cb: (error: Error) => void) {
        cb(new Error('channel open failed'));
      },
    };
    await expect(execCommand(client as never, 'cmd')).rejects.toThrow('channel open failed');
  });
});