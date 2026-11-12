import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openProxySocket,
  openTransport,
  normalizeJumps,
  normalizeProxy,
} from '../server/ssh-transport.cjs';

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** 一个把收到的数据原样回写的小服务，用于验证隧道真的打通。 */
function startEchoServer(): Promise<number> {
  return listen(net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  }));
}

/** 最小 SOCKS5 服务端（仅无认证），握手成功后转成 echo。 */
function startSocks5Server(): Promise<number> {
  return listen(net.createServer((socket) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) return;
        buffer = buffer.subarray(2 + methodCount);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let offset = 4;
        if (atyp === 0x01) offset += 4;
        else if (atyp === 0x04) offset += 16;
        else {
          if (buffer.length < 5) return;
          offset += 1 + buffer[4];
        }
        offset += 2;
        if (buffer.length < offset) return;
        buffer = buffer.subarray(offset);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00]));
        stage = 2;
        if (buffer.length > 0) socket.write(buffer);
        buffer = Buffer.alloc(0);
      } else if (stage === 2 && buffer.length > 0) {
        socket.write(buffer);
        buffer = Buffer.alloc(0);
      }
    });
  }));
}

/** 最小 HTTP CONNECT 代理，成功响应后转成 echo。 */
function startHttpProxyServer(): Promise<number> {
  return listen(net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let established = false;
    socket.on('data', (chunk) => {
      if (established) {
        socket.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0) return;
      buffer = buffer.subarray(index + 4);
      established = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (buffer.length > 0) socket.write(buffer);
    });
  }));
}

function waitForEcho(socket: net.Socket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('echo timeout')), 3000);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString());
    });
    socket.write(payload);
  });
}

interface FakeClientOptions { sock?: net.Socket }

class FakeClient {
  static created: FakeClient[] = [];

  connected: any;

  ended = false;

  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor() {
    FakeClient.created.push(this);
  }

  on(event: string, callback: (...args: any[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
    return this;
  }

  connect(options: FakeClientOptions) {
    this.connected = options;
    setTimeout(() => {
      for (const callback of this.listeners.get('ready') ?? []) callback();
    }, 0);
    return this;
  }

  forwardOut(_srcHost: string, _srcPort: number, host: string, port: number, callback: (error: Error | null, stream?: any) => void) {
    callback(null, { via: this, host, port });
  }

  end() {
    this.ended = true;
    return this;
  }
}

describe('ssh-transport proxy handshakes', () => {
  it('negotiates a SOCKS5 tunnel and carries data', async () => {
    const proxyPort = await startSocks5Server();
    const socket = await openProxySocket(
      { type: 'socks5', host: '127.0.0.1', port: proxyPort },
      'example.internal',
      22,
    ) as net.Socket;
    await expect(waitForEcho(socket, 'hello-socks')).resolves.toBe('hello-socks');
    socket.destroy();
  });

  it('negotiates an HTTP CONNECT tunnel and carries data', async () => {
    const proxyPort = await startHttpProxyServer();
    const socket = await openProxySocket(
      { type: 'http', host: '127.0.0.1', port: proxyPort },
      'example.internal',
      22,
    ) as net.Socket;
    await expect(waitForEcho(socket, 'hello-http')).resolves.toBe('hello-http');
    socket.destroy();
  });

  it('rejects a proxy that is not reachable', async () => {
    await expect(openProxySocket(
      { type: 'socks5', host: '127.0.0.1', port: 1 },
      'example.internal',
      22,
    )).rejects.toBeTruthy();
  });
});

describe('ssh-transport jump chain', () => {
  it('returns no socket and a no-op dispose for a direct connection', async () => {
    const result = await openTransport({ connection: { host: 'h', port: 22 } });
    expect(result.sock).toBeNull();
    result.dispose();
  });

  it('chains hops in order and tunnels each hop to the next', async () => {
    FakeClient.created = [];
    const result = await openTransport({
      connection: {
        host: 'target',
        port: 2200,
        jumpHosts: [
          { host: 'jump1', port: 22, username: 'a' },
          { host: 'jump2', port: 2222, username: 'b' },
        ],
      },
      clientId: 'c1',
      createClient: () => new FakeClient() as any,
    });

    const [first, second] = FakeClient.created;
    expect(FakeClient.created).toHaveLength(2);
    // 第一跳直连（无代理），第二跳经由第一跳的隧道连到 jump2:2222
    expect(first.connected.sock).toBeUndefined();
    expect(second.connected.sock).toMatchObject({ via: first, host: 'jump2', port: 2222 });
    // 返回的最终 sock 是第二跳 forwardOut 到目标主机
    expect(result.sock).toMatchObject({ via: second, host: 'target', port: 2200 });

    result.dispose();
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
  });

  it('normalizes proxy and jump host input', () => {
    expect(normalizeProxy({ type: 'http', host: ' p ', port: '8080' })).toEqual({
      type: 'http', host: 'p', port: 8080, username: undefined, password: undefined,
    });
    expect(normalizeProxy({ type: 'ftp', host: 'p', port: 1 })).toBeNull();
    expect(normalizeJumps([{ host: ' a ', port: '2222', username: 'u' }, { host: '' }])).toEqual([
      { host: 'a', port: 2222, username: 'u', password: undefined, privateKey: undefined, passphrase: undefined },
    ]);
  });
});
