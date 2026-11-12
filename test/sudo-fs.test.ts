import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  quoteShellArg,
  looksLikePasswordRequired,
  execCollect,
  sudoReadTextFile,
  sudoWriteTextFile,
} = require('../server/sudo-fs.cjs');

/** 构造一个假的 ssh2 client，按命令返回预设结果（stdout/stderr/code）。 */
function fakeClient(handler: (command: string, stdin: string) => { stdout?: string; stderr?: string; code: number }) {
  return {
    exec(command: string, callback: (error: Error | null, stream: any) => void) {
      const stream: any = new EventEmitter();
      stream.stderr = new EventEmitter();
      let stdin = '';
      let responded = false;
      const respond = () => {
        if (responded) return;
        responded = true;
        const result = handler(command, stdin);
        if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
        if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
        stream.emit('close', result.code);
      };
      stream.end = (payload?: string) => {
        stdin = payload || '';
        setImmediate(respond);
      };
      stream.close = () => {};
      callback(null, stream);
    },
  };
}

describe('sudo-fs', () => {
  it('quoteShellArg 转义单引号', () => {
    expect(quoteShellArg('/tmp/a b')).toBe("'/tmp/a b'");
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
  });

  it('looksLikePasswordRequired 识别常见提示', () => {
    expect(looksLikePasswordRequired('sudo: a password is required')).toBe(true);
    expect(looksLikePasswordRequired('sudo: no tty present and no askpass program specified')).toBe(true);
    expect(looksLikePasswordRequired('cat: /x: No such file or directory')).toBe(false);
  });

  it('免密 sudo 成功时直接返回内容', async () => {
    const client = fakeClient(() => ({ stdout: 'root-content', code: 0 }));
    const result = await sudoReadTextFile(client, '/etc/secret.conf');
    expect(result.content).toBe('root-content');
    expect(result.size).toBe(Buffer.byteLength('root-content'));
  });

  it('需要密码且未提供时报 SUDO_PASSWORD_REQUIRED', async () => {
    const client = fakeClient(() => ({ stderr: 'sudo: a password is required', code: 1 }));
    await expect(sudoReadTextFile(client, '/etc/secret.conf')).rejects.toMatchObject({
      code: 'sudo-password-required',
    });
  });

  it('提供密码后用 sudo -S 重试，密码写入 stdin 首行', async () => {
    const seen: string[] = [];
    const client = fakeClient((command, stdin) => {
      seen.push(command);
      if (command.includes('sudo -n')) return { stderr: 'sudo: a password is required', code: 1 };
      if (!stdin.startsWith('hunter2\n')) return { stderr: 'sudo: incorrect password attempt', code: 1 };
      return { stdout: 'ok-content', code: 0 };
    });
    const result = await sudoReadTextFile(client, '/etc/secret.conf', { password: 'hunter2' });
    expect(result.content).toBe('ok-content');
    expect(seen.some((command) => command.includes('sudo -S'))).toBe(true);
  });

  it('写入时把内容作为 stdin 传给 sudo tee', async () => {
    let captured = '';
    const client = fakeClient((command, stdin) => {
      if (command.includes('sudo -n')) return { stderr: 'sudo: a password is required', code: 1 };
      captured = stdin;
      return { code: 0 };
    });
    await sudoWriteTextFile(client, '/etc/secret.conf', 'new-body', { password: 'pw' });
    expect(captured.startsWith('pw\n')).toBe(true);
    expect(captured.endsWith('new-body')).toBe(true);
  });

  it('execCollect 按 Buffer 收集，多字节字符跨数据块不被劈开', async () => {
    const client = {
      exec(_command: string, callback: (error: null, stream: any) => void) {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        stream.end = () => {
          setImmediate(() => {
            // 'a中b' 的 UTF-8 字节被从“中”字中间劈开
            stream.emit('data', Buffer.from([0x61, 0xe4]));
            stream.emit('data', Buffer.from([0xb8, 0xad, 0x62]));
            stream.emit('close', 0);
          });
        };
        callback(null, stream);
      },
    };
    const result = await execCollect(client, 'cat x');
    expect(result.stdout).toBe('a中b');
  });

  it('sudoReadTextFile 超过 maxBytes 时提前中断命令并报 too-large', async () => {
    let closed = false;
    const client = {
      exec(_command: string, callback: (error: null, stream: any) => void) {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => { closed = true; };
        stream.end = () => {
          setImmediate(() => {
            stream.emit('data', Buffer.alloc(64 * 1024, 0x61));
            stream.emit('close', 0);
          });
        };
        callback(null, stream);
      },
    };
    await expect(sudoReadTextFile(client, '/etc/big', { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(closed).toBe(true);
  });

  it('sudoReadTextFile 遇到非法 UTF-8 字节时拒绝而不是静默替换', async () => {
    const client = {
      exec(_command: string, callback: (error: null, stream: any) => void) {
        const stream: any = new EventEmitter();
        stream.stderr = new EventEmitter();
        stream.close = () => {};
        stream.end = () => {
          setImmediate(() => {
            // 'ab' + 一个被截断的多字节序列（非法 UTF-8）
            stream.emit('data', Buffer.from([0x61, 0x62, 0xe4, 0xb8]));
            stream.emit('close', 0);
          });
        };
        callback(null, stream);
      },
    };
    await expect(sudoReadTextFile(client, '/etc/binary-ish')).rejects.toMatchObject({
      code: 'unsupported-encoding',
    });
  });

  it('sudoReadTextFile 拒绝包含空字节的文件', async () => {
    const client = fakeClient(() => ({ stdout: 'a\u0000b', code: 0 }));
    await expect(sudoReadTextFile(client, '/etc/with-nul')).rejects.toMatchObject({
      code: 'unsupported-encoding',
    });
  });
});
