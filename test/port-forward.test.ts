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

  it('活动连接数：一条转发连接关闭只递减一次', async () => {
    const manager = createPortForwardManager({ getClientForSession: () => fakeSession() });
    const rule = { id: 'count-1', type: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: echo.port };
    manager.start({ clientId: 'c5', connectionId: 'conn5', rule });
    const port = await waitForPort(manager, 'c5', 'conn5', 'count-1');

    const openConnection = async () => {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(Buffer.from('ping'));
      await readN(socket, 'ping'.length);
      return socket;
    };
    const socketA = await openConnection();
    const socketB = await openConnection();
    const count = () => manager.list({ clientId: 'c5', connectionId: 'conn5' })[0]?.connections ?? 0;
    // 两条都活跃时计数为 2（等计数稳定，forwardOut 是异步建立的）
    for (let attempt = 0; attempt < 100 && count() !== 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(count()).toBe(2);

    socketA.destroy();
    for (let attempt = 0; attempt < 100 && count() !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(count()).toBe(1);

    socketB.destroy();
    for (let attempt = 0; attempt < 100 && count() !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(count()).toBe(0);
    manager.stopAllForConnection('conn5', 'c5');
  });

  it('端口被占用时报错且记录可重试：错误记录从列表移除，释放端口后能重新启动', async () => {
    // 占住一个端口，制造 EADDRINUSE
    const blocker = await createEchoServer();
    try {
      const manager = createPortForwardManager({ getClientForSession: () => fakeSession() });
      const rule = { id: 'retry-1', type: 'local', bindHost: '127.0.0.1', bindPort: blocker.port, targetHost: '127.0.0.1', targetPort: echo.port };
      manager.start({ clientId: 'c4', connectionId: 'conn4', rule });
      // 等监听失败被登记（错误记录已从 active 移除）
      let errored = false;
      for (let attempt = 0; attempt < 100 && !errored; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        errored = !manager.list({ clientId: 'c4', connectionId: 'conn4' }).some((item: any) => item.ruleId === 'retry-1');
      }
      expect(errored).toBe(true);

      // 释放端口后同一规则可直接重试启动
      await blocker.close();
      manager.start({ clientId: 'c4', connectionId: 'conn4', rule });
      const port = await waitForPort(manager, 'c4', 'conn4', 'retry-1');
      expect(port).toBe(blocker.port);
      manager.stop({ clientId: 'c4', connectionId: 'conn4', ruleId: 'retry-1' });
    } finally {
      // blocker.close 可能已被上面调用，重复关闭是安全的（close 回调幂等等待）
      await blocker.close().catch(() => undefined);
    }
  });
});
