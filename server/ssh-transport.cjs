/**
 * SSH 连接传输层：把「HTTP/SOCKS5 代理」和「多级跳板机」统一成一条到目标主机的
 * TCP 流（sock），交给 ssh2 的 Client.connect({ sock }) 使用。
 *
 * 设计要点：
 * - 代理只作用于「第一跳」：有跳板机时是第一台跳板机，没有跳板机时就是目标主机。
 * - 跳板链逐跳建连：第 N 跳连接时，sock 取第 N-1 跳 client.forwardOut(...) 出来的隧道。
 * - 每一跳都独立做主机密钥 TOFU 校验（host/port 各自对应）。
 * - 任一跳失败立即回收已经建立的连接，避免僵尸客户端。
 *
 * 本模块不新增任何依赖：HTTP CONNECT 与 SOCKS5 握手均为最小实现。
 */

const net = require('node:net');
const { Client } = require('ssh2');

const PROXY_HANDSHAKE_TIMEOUT_MS = 15000;
const HOP_READY_TIMEOUT_MS = 20000;

function normalizeProxy(proxy) {
  if (!proxy || !proxy.type) return null;
  if (proxy.type !== 'http' && proxy.type !== 'socks5') return null;
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return {
    type: proxy.type,
    host,
    port,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

function normalizeJumps(jumpHosts) {
  if (!Array.isArray(jumpHosts)) return [];
  return jumpHosts
    .map((hop) => ({
      host: String(hop?.host || '').trim(),
      port: Number(hop?.port) || 22,
      username: hop?.username || '',
      password: hop?.password || undefined,
      privateKey: hop?.privateKey || undefined,
      passphrase: hop?.passphrase || undefined,
    }))
    .filter((hop) => hop.host);
}

/** 从 socket 精确读取 n 字节；对端提前关闭时报错。 */
function readExactly(socket, n, state) {
  return new Promise((resolve, reject) => {
    const tryConsume = () => {
      if (state.buffer.length >= n) {
        const out = state.buffer.subarray(0, n);
        state.buffer = state.buffer.subarray(n);
        cleanup();
        resolve(out);
        return true;
      }
      return false;
    };
    const onData = (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      tryConsume();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Proxy connection closed during handshake'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    if (tryConsume()) return;
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

/** 读取直到出现分隔符（用于解析 HTTP 响应头），返回 {head, rest}。 */
function readUntil(socket, delimiter, state, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const tryConsume = () => {
      const index = state.buffer.indexOf(delimiter);
      if (index >= 0) {
        const head = state.buffer.subarray(0, index);
        const rest = state.buffer.subarray(index + delimiter.length);
        cleanup();
        resolve({ head, rest });
        return true;
      }
      if (state.buffer.length > limit) {
        cleanup();
        reject(new Error('Proxy response header too large'));
        return true;
      }
      return false;
    };
    const onData = (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      tryConsume();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Proxy connection closed during handshake'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    if (tryConsume()) return;
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function connectTcp(host, port, timeoutMs = PROXY_HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy connect timed out (${host}:${port})`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 给代理握手（HTTP CONNECT / SOCKS5）加超时：TCP 连上之后如果对端一直不应答，
 * 到时销毁 socket 并报错，避免读取 Promise 永远挂起。
 */
function raceHandshake(socket, handshake, timeoutMs = PROXY_HANDSHAKE_TIMEOUT_MS) {
  let timer = null;
  return Promise.race([
    handshake,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Proxy handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 通过 HTTP CONNECT 代理建立到 targetHost:targetPort 的隧道。 */
async function openHttpProxySocket(proxy, targetHost, targetPort) {
  const socket = await connectTcp(proxy.host, proxy.port);
  try {
    return await raceHandshake(socket, (async () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Proxy-Connection: Keep-Alive',
      ];
      if (proxy.username) {
        const token = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      const state = { buffer: Buffer.alloc(0) };
      const { head, rest } = await readUntil(socket, Buffer.from('\r\n\r\n'), state);
      state.buffer = rest;
      const statusLine = head.toString('latin1').split('\r\n')[0] || '';
      const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
      if (!match) throw new Error(`Unexpected HTTP proxy response: ${statusLine}`);
      const status = Number(match[1]);
      if (status !== 200) throw new Error(`HTTP proxy CONNECT failed with status ${status}`);
      // 响应头之后若还有缓冲数据，先塞回 socket，避免吞掉首包。
      if (state.buffer.length > 0) socket.unshift(state.buffer);
      return socket;
    })());
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** 通过 SOCKS5 代理（可选用户名/密码认证）建立到目标主机的隧道。 */
async function openSocks5Socket(proxy, targetHost, targetPort) {
  const socket = await connectTcp(proxy.host, proxy.port);
  const state = { buffer: Buffer.alloc(0) };
  try {
    return await raceHandshake(socket, (async () => {
      const wantsAuth = Boolean(proxy.username);
      socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
      const greeting = await readExactly(socket, 2, state);
      if (greeting[0] !== 0x05) throw new Error('Invalid SOCKS5 version from proxy');
      const method = greeting[1];
      if (method === 0x02) {
        const user = Buffer.from(String(proxy.username || ''), 'utf8');
        const pass = Buffer.from(String(proxy.password || ''), 'utf8');
        const auth = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
        socket.write(auth);
        const authReply = await readExactly(socket, 2, state);
        if (authReply[1] !== 0x00) throw new Error('SOCKS5 username/password authentication failed');
      } else if (method !== 0x00) {
        throw new Error('SOCKS5 proxy rejected all offered authentication methods');
      }

      // 目标地址：域名优先（atyp=0x03），IPv4 字面量用 0x01。
      const isIpv4 = net.isIPv4(targetHost);
      const hostBytes = isIpv4
        ? Buffer.from(targetHost.split('.').map((part) => Number(part)))
        : Buffer.concat([Buffer.from([targetHost.length]), Buffer.from(targetHost, 'utf8')]);
      const portBytes = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, isIpv4 ? 0x01 : 0x03]),
        hostBytes,
        portBytes,
      ]));

      const header = await readExactly(socket, 4, state);
      if (header[0] !== 0x05) throw new Error('Invalid SOCKS5 reply version');
      if (header[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code ${header[1]}`);
      const atyp = header[3];
      const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await readExactly(socket, 1, state))[0];
      await readExactly(socket, addressLength + 2, state);
      if (state.buffer.length > 0) socket.unshift(state.buffer);
      return socket;
    })());
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function openProxySocket(proxy, targetHost, targetPort) {
  return proxy.type === 'http'
    ? openHttpProxySocket(proxy, targetHost, targetPort)
    : openSocks5Socket(proxy, targetHost, targetPort);
}

function connectHop(hop, options = {}) {
  const { sock = null, hostVerifier, createClient = () => new Client() } = options;
  const client = createClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      reject(error);
    };
    client
      .on('ready', () => {
        if (settled) return;
        settled = true;
        resolve(client);
      })
      .on('error', fail)
      .on('close', () => fail(new Error('SSH hop closed before ready')))
      .connect({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        password: hop.password || undefined,
        privateKey: hop.privateKey || undefined,
        passphrase: hop.passphrase || undefined,
        readyTimeout: HOP_READY_TIMEOUT_MS,
        keepaliveInterval: 0,
        hostVerifier,
        sock: sock || undefined,
      });
  });
}

function forwardOut(client, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * 打开到 connection.host:connection.port 的底层 TCP 流。
 * @returns {Promise<{sock: import('node:stream').Duplex|null, dispose: () => void}>}
 *   sock 为 null 时表示直连（无需代理/跳板），dispose 为空操作。
 */
async function openTransport({ connection, clientId, createVerifier, createClient } = {}) {
  const proxyConfig = connection?.proxy;
  const proxy = normalizeProxy(proxyConfig);
  // 配了代理但字段残缺（类型/主机/端口不全）时明确报错，
  // 绝不能静默退回直连——那会让流量绕过预期的网络路径。
  if (proxyConfig && !proxy) {
    throw new Error('Proxy configuration is incomplete: type, host and port are required');
  }
  const jumps = normalizeJumps(connection?.jumpHosts);
  if (!proxy && jumps.length === 0) {
    return { sock: null, dispose: () => {} };
  }

  const targetHost = String(connection.host || '').trim();
  const targetPort = Number(connection.port) || 22;
  const hopClients = [];
  let proxySocket = null;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const client of hopClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    if (proxySocket) {
      try { proxySocket.destroy(); } catch { /* ignore */ }
    }
  };

  try {
    // 第一跳的目标：有跳板机时是第一台跳板机，否则就是最终目标。
    const firstHost = jumps.length > 0 ? jumps[0].host : targetHost;
    const firstPort = jumps.length > 0 ? jumps[0].port : targetPort;

    if (proxy) {
      proxySocket = await openProxySocket(proxy, firstHost, firstPort);
    }

    let sock = proxySocket;
    for (let index = 0; index < jumps.length; index += 1) {
      const hop = jumps[index];
      const client = await connectHop(hop, {
        sock,
        createClient,
        hostVerifier: createVerifier ? createVerifier({ host: hop.host, port: hop.port, clientId }) : undefined,
      });
      hopClients.push(client);
      // 为下一跳（或最终目标）开一条隧道。
      const nextHost = index + 1 < jumps.length ? jumps[index + 1].host : targetHost;
      const nextPort = index + 1 < jumps.length ? jumps[index + 1].port : targetPort;
      sock = await forwardOut(client, nextHost, nextPort);
      // 已建立的隧道流由下一跳的 ssh2 客户端持有，本模块只保留跳板 client 用于回收。
    }

    return { sock: sock || null, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = {
  openTransport,
  openProxySocket,
  openHttpProxySocket,
  openSocks5Socket,
  normalizeProxy,
  normalizeJumps,
};
