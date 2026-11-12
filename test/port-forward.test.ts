import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPortForwardManager } = require('../server/port-forward.cjs');

/** 起一个把收到的字节原样回写的 TCP 服务，充当「SSH 可达的目标」。 */
function createEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** 假 SSH 会话：forwardOut 直接连到真实目标，模拟服务端发起连接。 */
function fakeSession() {
  return {
    client: {
      forwardOut: (
        _srcHost: string,
        _srcPort: number,
        dstHost: string,
        dstPort: number,
        callback: (error: Error | null, stream?: net.Socket) => void,
      ) => {
        const socket = net.connect(dstPort, dstHost, () => callback(null, socket));
        socket.on('error', (error) => callback(error));
      },
    },
  };
}

async function waitForPort(manager: any, clientId: string, connectionId: string, ruleId: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = manager.list({ clientId, connectionId }).find((item: any) => item.ruleId === ruleId);
    if (found && found.bindPort > 0) return found.bindPort;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('forward port not ready');
}

function readN(socket: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= n) {
        socket.off('data', onData);
        resolve(buffer.subarray(0, n));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

describe('port-forward manager', () => {
  let echo: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    echo = await createEchoServer();
  });

  afterAll(async () => {
    await echo.close();
  });

  it('local 转发：本地监听 → forwardOut → 目标，字节双向搬运', async () => {
    const manager = createPortForwardManager({ getClientForSession: () => fakeSession() });
    const rule = { id: 'local-1', type: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: echo.port };
    const started = manager.start({ clientId: 'c1', connectionId: 'conn1', rule });
    expect(started.type).toBe('local');
    const port = await waitForPort(manager, 'c1', 'conn1', 'local-1');

    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(Buffer.from('ping-local'));
    const echoed = await readN(socket, 'ping-local'.length);
    expect(echoed.toString()).toBe('ping-local');
    socket.destroy();

    expect(manager.stop({ clientId: 'c1', connectionId: 'conn1', ruleId: 'local-1' })).toBe(true);
    expect(manager.list({ clientId: 'c1', connectionId: 'conn1' })).toHaveLength(0);
  });

  it('dynamic 转发：本地 SOCKS5 握手后转发到目标', async () => {
    const manager = createPortForwardManager({ getClientForSession: () => fakeSession() });
    const rule = { id: 'dyn-1', type: 'dynamic', bindHost: '127.0.0.1', bindPort: 0 };
    manager.start({ clientId: 'c2', connectionId: 'conn2', rule });
    const port = await waitForPort(manager, 'c2', 'conn2', 'dyn-1');

    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    // 问候：版本 5，1 种方法（无认证）
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const methodReply = await readN(socket, 2);
    expect(Array.from(methodReply)).toEqual([0x05, 0x00]);

    // CONNECT 到 echo 服务（IPv4）
    const request = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, echo.port >> 8, echo.port & 0xff]);
    socket.write(request);
    const reply = await readN(socket, 10);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x00);

    socket.write(Buffer.from('ping-socks'));
    const echoed = await readN(socket, 'ping-socks'.length);
    expect(echoed.toString()).toBe('ping-socks');
    socket.destroy();
    manager.stopAllForConnection('conn2', 'c2');
  });

  it('未知规则 / 非法目标时报错', () => {
    const manager = createPortForwardManager({ getClientForSession: () => fakeSession() });
    expect(() => manager.start({ clientId: 'c3', connectionId: 'conn3', rule: { id: 'bad', type: 'local', bindPort: 0 } }))
      .toThrow(/target host/);
    expect(() => manager.start({ clientId: 'c3', connectionId: 'conn3', rule: { id: 'bad2', type: 'weird', bindPort: 0 } }))
      .toThrow(/Unsupported port forward type/);
    expect(manager.stop({ clientId: 'c3', connectionId: 'conn3', ruleId: 'missing' })).toBe(false);
    const offline = createPortForwardManager({ getClientForSession: () => null });
    expect(() => offline.start({ clientId: 'c3', connectionId: 'conn3', rule: { id: 'x', type: 'local', bindPort: 0, targetHost: 'h', targetPort: 1 } }))
      .toThrow(/session is not connected/);
  });
});
