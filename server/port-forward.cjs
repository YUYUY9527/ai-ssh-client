/**
 * 端口转发：本地转发（-L）、远程转发（-R）与动态 SOCKS5（-D）。
 *
 * - 本地转发 / 动态 SOCKS5：基于 ssh2 `client.forwardOut`，本地起 TCP 监听，经 SSH 通道连远端目标。
 * - 远程转发（-R）：基于 ssh2 `client.forwardIn`，远端起 TCP 监听，收到 `tcp connection` 后连本地/网关侧目标。
 *
 * 安全默认：监听地址缺省 127.0.0.1，避免把内网服务暴露到所有网卡。
 */

const net = require('node:net');

function normalizeBindHost(rule) {
  const host = String(rule?.bindHost || '').trim();
  return host || '127.0.0.1';
}

function ruleKey(clientId, connectionId, ruleId) {
  return `${clientId}::${connectionId}::${ruleId}`;
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

/** 读取本地 SOCKS 客户端握手所需字节。 */
function readBytes(socket, n, state) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
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
      attempt();
    };
    const onClose = () => { cleanup(); reject(new Error('SOCKS client closed')); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    if (attempt()) return;
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function readSocksConnectRequest(socket, state) {
  const greeting = await readBytes(socket, 2, state);
  if (greeting[0] !== 0x05) throw new Error('Unsupported SOCKS version');
  const methodCount = greeting[1];
  await readBytes(socket, methodCount, state);
  socket.write(Buffer.from([0x05, 0x00])); // 仅支持无认证（只监听本机）

  const header = await readBytes(socket, 4, state);
  if (header[0] !== 0x05 || header[1] !== 0x01) throw new Error('Unsupported SOCKS command');
  const atyp = header[3];
  let host;
  if (atyp === 0x01) {
    host = Array.from(await readBytes(socket, 4, state)).join('.');
  } else if (atyp === 0x03) {
    const length = (await readBytes(socket, 1, state))[0];
    host = (await readBytes(socket, length, state)).toString('utf8');
  } else if (atyp === 0x04) {
    const raw = await readBytes(socket, 16, state);
    const groups = [];
    for (let index = 0; index < 16; index += 2) groups.push(raw.readUInt16BE(index).toString(16));
    host = groups.join(':');
  } else {
    throw new Error('Unsupported SOCKS address type');
  }
  const portBytes = await readBytes(socket, 2, state);
  const port = portBytes.readUInt16BE(0);
  return { host, port };
}

function createPortForwardManager({ getClientForSession } = {}) {
  const active = new Map();

  function describe(entry) {
    return {
      ruleId: entry.rule.id,
      type: entry.rule.type,
      status: entry.error ? 'error' : 'running',
      bindHost: entry.bindHost,
      bindPort: entry.bindPort,
      address: entry.rule.type === 'dynamic'
        ? `socks5://${entry.bindHost}:${entry.bindPort}`
        : `${entry.bindHost}:${entry.bindPort}`,
      targetHost: entry.rule.targetHost,
      targetPort: entry.rule.targetPort,
      connections: entry.connections,
      error: entry.error,
    };
  }

  function forward(session, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
      session.client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
  }

  function attachBridge(entry, socket, targetHost, targetPort) {
    forward(entry.session, targetHost, targetPort)
      .then((stream) => {
        entry.connections += 1;
        let counted = true;
        const done = () => {
          if (!counted) return;
          counted = false;
          entry.connections = Math.max(0, entry.connections - 1);
        };
        socket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
        stream.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
        socket.on('close', done);
        stream.on('close', done);
        socket.pipe(stream).pipe(socket);
      })
      .catch((error) => {
        entry.lastError = error.message;
        try { socket.destroy(); } catch { /* ignore */ }
      });
  }

  function handleDynamic(entry, socket) {
    const state = { buffer: Buffer.alloc(0) };
    readSocksConnectRequest(socket, state)
      .then(({ host, port }) => {
        if (state.buffer.length > 0 && typeof socket.unshift === 'function') {
          socket.unshift(state.buffer);
          state.buffer = Buffer.alloc(0);
        }
        return forward(entry.session, host, port).then((stream) => ({ stream, host, port }));
      })
      .then(({ stream }) => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x00]));
        entry.connections += 1;
        let counted = true;
        const done = () => {
          if (!counted) return;
          counted = false;
          entry.connections = Math.max(0, entry.connections - 1);
        };
        socket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
        stream.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
        socket.on('close', done);
        stream.on('close', done);
        socket.pipe(stream).pipe(socket);
      })
      .catch((error) => {
        entry.lastError = error.message;
        try { socket.destroy(); } catch { /* ignore */ }
      });
  }

  function stopEntry(entry) {
    if (typeof entry.dispose === 'function') {
      try { entry.dispose(); } catch { /* ignore */ }
    } else {
      try { entry.server?.close(); } catch { /* ignore */ }
    }
  }

  function startRemote(entry, key) {
    const client = entry.session.client;
    if (typeof client.forwardIn !== 'function') {
      throw new Error('SSH client does not support remote port forwarding');
    }
    const targetHost = String(entry.rule.targetHost || '127.0.0.1').trim();
    const targetPort = parsePort(entry.rule.targetPort);

    const onTcpConnection = (info, accept, reject) => {
      if (info.destPort !== entry.bindPort) return;
      if (entry.bindHost !== '0.0.0.0' && entry.bindHost !== '::' && info.destIP && info.destIP !== entry.bindHost) {
        return;
      }
      const localSocket = net.createConnection({ host: targetHost, port: targetPort });
      let stream = null;
      let counted = false;
      const done = () => {
        if (!counted) return;
        counted = false;
        entry.connections = Math.max(0, entry.connections - 1);
      };
      localSocket.once('connect', () => {
        stream = accept();
        if (!stream) {
          localSocket.destroy();
          return;
        }
        counted = true;
        entry.connections += 1;
        localSocket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
        stream.on('error', () => { try { localSocket.destroy(); } catch { /* ignore */ } });
        localSocket.on('close', done);
        stream.on('close', done);
        stream.pipe(localSocket).pipe(stream);
      });
      localSocket.once('error', (error) => {
        entry.lastError = error.message;
        if (!stream) {
          try { reject?.(); } catch { /* ignore */ }
        }
        try { localSocket.destroy(); } catch { /* ignore */ }
      });
    };

    entry.dispose = () => {
      try { client.off?.('tcp connection', onTcpConnection); } catch { /* ignore */ }
      try {
        if (typeof client.unforwardIn === 'function' && entry.bindPort > 0) {
          client.unforwardIn(entry.bindHost, entry.bindPort, () => {});
        }
      } catch { /* ignore */ }
    };

    client.on('tcp connection', onTcpConnection);
    client.forwardIn(entry.bindHost, entry.bindPort, (error, assignedPort) => {
      if (error) {
        entry.error = error.message;
        try { client.off?.('tcp connection', onTcpConnection); } catch { /* ignore */ }
        if (active.get(key) === entry) {
          active.delete(key);
        }
        return;
      }
      if (typeof assignedPort === 'number' && assignedPort > 0) {
        entry.bindPort = assignedPort;
      }
    });
    active.set(key, entry);
    return describe(entry);
  }

  function start({ clientId, connectionId, rule }) {
    if (!rule || !rule.id) throw new Error('Port forward rule is required');
    const key = ruleKey(clientId, connectionId, rule.id);
    if (active.has(key)) {
      const existing = active.get(key);
      if (!existing.error) return describe(existing);
      stopEntry(existing);
      active.delete(key);
    }
    if (rule.type !== 'local' && rule.type !== 'remote' && rule.type !== 'dynamic') {
      throw new Error(`Unsupported port forward type: ${rule.type}`);
    }
    const requestedPort = Number(rule?.bindPort);
    const bindPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
      ? requestedPort
      : NaN;
    if (!Number.isInteger(bindPort)) throw new Error('Invalid bind port');
    if (rule.type === 'local' || rule.type === 'remote') {
      if (!rule.targetHost || !parsePort(rule.targetPort)) {
        throw new Error(`${rule.type === 'remote' ? 'Remote' : 'Local'} forward requires target host and port`);
      }
    }
    const session = typeof getClientForSession === 'function'
      ? getClientForSession(connectionId, clientId)
      : null;
    if (!session?.client) throw new Error('SSH session is not connected');

    const entry = {
      rule,
      session,
      bindHost: normalizeBindHost(rule),
      bindPort,
      connections: 0,
      error: null,
      lastError: null,
      server: null,
      dispose: null,
    };

    if (rule.type === 'remote') {
      return startRemote(entry, key);
    }

    const server = net.createServer((socket) => {
      if (rule.type === 'dynamic') {
        handleDynamic(entry, socket);
      } else {
        attachBridge(entry, socket, rule.targetHost, parsePort(rule.targetPort));
      }
    });
    entry.server = server;
    server.on('error', (error) => {
      entry.error = error.message;
      try { server.close(); } catch { /* ignore */ }
      for (const [k, v] of active.entries()) {
        if (v === entry) {
          active.delete(k);
          break;
        }
      }
    });
    server.on('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        entry.bindPort = address.port;
      }
    });
    server.listen(bindPort, entry.bindHost);
    active.set(key, entry);
    return describe(entry);
  }

  function stop({ clientId, connectionId, ruleId }) {
    const key = ruleKey(clientId, connectionId, ruleId);
    const entry = active.get(key);
    if (!entry) return false;
    active.delete(key);
    stopEntry(entry);
    return true;
  }

  function list({ clientId, connectionId }) {
    const result = [];
    for (const [key, entry] of active.entries()) {
      if (!key.startsWith(`${clientId}::${connectionId}::`)) continue;
      result.push(describe(entry));
    }
    return result;
  }

  function stopAllForConnection(connectionId, clientId) {
    for (const [key, entry] of Array.from(active.entries())) {
      if (!key.startsWith(`${clientId}::${connectionId}::`)) continue;
      active.delete(key);
      stopEntry(entry);
    }
  }

  return { start, stop, list, stopAllForConnection };
}

module.exports = { createPortForwardManager };
