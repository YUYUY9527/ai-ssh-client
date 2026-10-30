const crypto = require('node:crypto');
const { Client } = require('ssh2');

const { fingerprintOf, algorithmOf } = require('../host-trust.cjs');
const { sftpProtocolPath } = require('../sftp-items.cjs');
const { toolError } = require('./errors.cjs');

/**
 * 带复用的 SSH 连接池。
 *
 * 每个 MCP 会话内按 connectionId 复用一条 SSH 连接，命令走 `exec` 通道
 * （不申请 PTY）：agent 拿到的是干净的 stdout/stderr/exitCode，
 * 不会因为交互式提示符、分页器或全屏程序把输出搅乱。
 * 需要 PTY 的命令（如 sudo 交互）本就不适合无人值守执行。
 */

function createBudget(limit) {
  let remaining = Math.max(0, Number(limit) || 0);
  return {
    take(requested) {
      const granted = Math.max(0, Math.min(remaining, requested));
      remaining -= granted;
      return granted;
    },
    get exhausted() {
      return remaining <= 0;
    },
    get remaining() {
      return remaining;
    },
  };
}

/** 有上限的字节收集器；超出预算只保留已经收到的部分并标记 truncated。 */
function createOutputCollector(budget) {
  const chunks = [];
  let truncated = false;
  return {
    append(chunk) {
      if (!chunk || chunk.length === 0) {
        return;
      }
      const granted = budget.take(chunk.length);
      if (granted > 0) {
        chunks.push(granted === chunk.length ? chunk : chunk.subarray(0, granted));
      }
      if (granted < chunk.length) {
        truncated = true;
      }
    },
    toString() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get truncated() {
      return truncated;
    },
    get bytes() {
      return chunks.reduce((total, chunk) => total + chunk.length, 0);
    },
  };
}

/**
 * 计算连接配置的指纹（sha256）。
 *
 * 连接池按 connectionId 复用，但用户可能在 Web 设置里改了 host/port/凭据后
 * 复用同一个连接 id。只看 id 会把请求继续发到旧主机，所以必须把「真正决定
 * 连到哪里、以谁的身份连」的字段一起纳入指纹。凭据参与哈希，但结果不可逆，
 * 不会泄漏明文（错误日志里也不要打印原文）。
 */
function connectionFingerprint(connection) {
  const material = JSON.stringify({
    host: String(connection?.host ?? ''),
    port: Number(connection?.port) || 22,
    username: String(connection?.username ?? ''),
    password: connection?.password ? String(connection.password) : '',
    privateKey: connection?.privateKey ? String(connection.privateKey) : '',
    passphrase: connection?.passphrase ? String(connection.passphrase) : '',
  });
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/** ssh2 的 attrs 是带方法的对象，转成可 JSON 化的普通对象。 */
function describeAttributes(attrs) {
  const isDirectory = typeof attrs?.isDirectory === 'function'
    ? attrs.isDirectory()
    : Boolean(attrs?.isDirectory);
  const isSymbolicLink = typeof attrs?.isSymbolicLink === 'function'
    ? attrs.isSymbolicLink()
    : Boolean(attrs?.isSymbolicLink);
  const mode = Number(attrs?.mode) || 0;
  return {
    type: isDirectory ? 'directory' : isSymbolicLink ? 'symlink' : 'file',
    size: Number(attrs?.size) || 0,
    mode: (mode & 0o777).toString(8).padStart(3, '0'),
    modifiedAt: attrs?.mtime ? new Date(Number(attrs.mtime) * 1000).toISOString() : null,
    uid: attrs?.uid ?? null,
    gid: attrs?.gid ?? null,
  };
}

/**
 * @param {object} options
 * @param {(connectionId: string) => object} options.getConnection 解析连接（含凭据）
 * @param {{ createVerifier: Function, getRecord: Function }} options.hostTrust
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.keepaliveIntervalMs]
 */
function createSshPool({
  getConnection,
  hostTrust,
  connectTimeoutMs = 20_000,
  keepaliveIntervalMs = 30_000,
}) {
  const clients = new Map();
  const fingerprints = new Map();

  function trustHint(connection, observed) {
    const record = hostTrust.getRecord(connection.host, connection.port);
    const actual = observed?.fingerprint ? `（服务器指纹 ${observed.fingerprint}）` : '';
    if (!record) {
      return `主机 ${connection.host}:${connection.port} 尚未被信任${actual}。`
        + '请先在 Web 界面里连接一次并在指纹提示中确认，'
        + '或以 MCP_TRUST_ON_FIRST_USE=1 启动 MCP 服务（密钥变更仍会被拒绝）。';
    }
    if (observed?.fingerprint && record.fingerprint !== observed.fingerprint) {
      return `主机 ${connection.host}:${connection.port} 的主机密钥已变更：`
        + `已记录 ${record.fingerprint}，本次收到 ${observed.fingerprint}。已拒绝连接。`;
    }
    return '';
  }

  function connect(connectionId) {
    // 先按最新配置解析连接：config.read() 每次都读盘，用户改完配置后
    // 下一次 connect 就能拿到新值（不需要等 services 重建）。
    let connection;
    try {
      connection = getConnection(connectionId);
    } catch (error) {
      return Promise.reject(error);
    }
    const fingerprint = connectionFingerprint(connection);

    const existing = clients.get(connectionId);
    if (existing && existing.fingerprint === fingerprint) {
      return existing.promise;
    }
    if (existing) {
      // 配置变了：旧的 client 与新配置无关，等它结算后断开，再用新配置重建。
      // 该 entry 随后会被新 entry 取代，下面的 isCurrent 守卫确保旧连接的
      // 迟到事件不会删掉新 entry 或覆盖新主机指纹。
      existing.promise.then((client) => {
        try { client.end(); } catch {}
      }).catch(() => {});
      fingerprints.delete(connectionId);
    }

    // entry 先建出来，供事件回调判断「自己还是不是当前生效的那条连接」。
    const entry = { fingerprint, promise: null };
    const isCurrent = () => clients.get(connectionId) === entry;

    const promise = new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let observed = null;
      const settle = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        handler(value);
      };
      const timer = setTimeout(() => {
        settle(reject, toolError(
          `连接 ${connection.name || connection.id} 超时（${connectTimeoutMs}ms）`,
          'ssh-timeout',
        ));
        client.destroy();
      }, connectTimeoutMs);

      client.once('ready', () => {
        // 只有仍是当前 entry 才记录指纹；被替换的连接不能污染新主机的观察结果。
        if (isCurrent()) {
          fingerprints.set(connectionId, observed);
        }
        settle(resolve, client);
      });
      client.once('error', (error) => {
        if (isCurrent()) {
          clients.delete(connectionId);
        }
        const hint = trustHint(connection, observed);
        const message = hint ? `${error.message}；${hint}` : error.message;
        settle(reject, toolError(message, 'ssh-connect-failed'));
      });
      client.on('close', () => {
        if (isCurrent()) {
          clients.delete(connectionId);
          fingerprints.delete(connectionId);
        }
        settle(reject, toolError(
          `连接 ${connection.name || connection.id} 在建立前已关闭`,
          'ssh-closed',
        ));
      });

      try {
        client.connect({
          host: connection.host,
          port: Number(connection.port) || 22,
          username: connection.username,
          password: connection.password || undefined,
          privateKey: connection.privateKey || undefined,
          passphrase: connection.passphrase || undefined,
          readyTimeout: connectTimeoutMs,
          keepaliveInterval: keepaliveIntervalMs,
          keepaliveCountMax: 3,
          // 包装 hostTrust 的校验器只为记录本次实际收到的指纹，便于在错误里展示；
          // 是否放行仍完全由 hostTrust 决定（未知主机默认拒绝）。
          hostVerifier: (key, verify) => {
            try {
              observed = { fingerprint: fingerprintOf(key), algorithm: algorithmOf(key) };
            } catch {
              observed = null;
            }
            hostTrust.createVerifier({
              host: connection.host,
              port: connection.port,
              clientId: 'mcp',
            })(key, verify);
          },
        });
      } catch (error) {
        settle(reject, toolError(
          `无法建立 SSH 连接：${error instanceof Error ? error.message : String(error)}`,
          'ssh-connect-failed',
        ));
      }
    });

    entry.promise = promise;
    clients.set(connectionId, entry);
    promise.catch(() => {
      if (clients.get(connectionId) === entry) {
        clients.delete(connectionId);
      }
    });
    return promise;
  }

  function exec(connectionId, command, { timeoutMs, maxOutputBytes } = {}) {
    const startedAt = Date.now();
    return connect(connectionId).then((client) => new Promise((resolve, reject) => {
      const budget = createBudget(maxOutputBytes);
      let settled = false;
      let timedOut = false;
      let timer = null;
      let hardTimer = null;
      let stdout;
      let stderr;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        client.removeListener('close', handleClientClose);
      };
      const finish = (exitCode, signal, error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve({
          exitCode: exitCode === undefined ? null : exitCode,
          signal: signal || null,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          truncated: stdout.truncated || stderr.truncated,
        });
      };
      const handleClientClose = () => finish(null, null, toolError('SSH 连接在命令执行期间断开', 'ssh-closed'));

      client.exec(command, (error, stream) => {
        if (error) {
          finish(null, null, error);
          return;
        }
        stdout = createOutputCollector(budget);
        stderr = createOutputCollector(budget);

        stream.on('data', (chunk) => stdout.append(chunk));
        stream.stderr.on('data', (chunk) => stderr.append(chunk));
        stream.once('close', (code, signal) => finish(code, signal));
        stream.once('error', (streamError) => finish(null, null, streamError));
        client.once('close', handleClientClose);

        timer = setTimeout(() => {
          timedOut = true;
          try { stream.signal('KILL'); } catch {}
          try { stream.close(); } catch {}
          // 远端不配合关闭通道时兜底结算，避免工具调用无限挂起。
          hardTimer = setTimeout(() => finish(null, 'KILL'), 2_000);
        }, Number(timeoutMs) || 30_000);
      });
    }));
  }

  function withSftp(connectionId, task) {
    return connect(connectionId).then((client) => new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(error);
          return;
        }
        Promise.resolve()
          .then(() => task(sftp))
          .then(resolve, reject)
          .finally(() => {
            try { sftp.end(); } catch {}
          });
      });
    }));
  }

  async function list(connectionId, remotePath) {
    return withSftp(connectionId, async (sftp) => {
      const protocolPath = sftpProtocolPath(remotePath || '.');
      const entries = await new Promise((resolve, reject) => {
        sftp.readdir(protocolPath, (error, value) => {
          if (error) reject(error);
          else resolve(value || []);
        });
      });
      return entries.map((entry) => ({
        name: entry.filename,
        ...describeAttributes(entry.attrs),
      }));
    });
  }

  async function stat(connectionId, remotePath) {
    return withSftp(connectionId, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(sftpProtocolPath(remotePath || '.'), (error, attrs) => {
        if (error) reject(error);
        else resolve(describeAttributes(attrs));
      });
    }));
  }

  function observedFingerprint(connectionId) {
    return fingerprints.get(connectionId)?.fingerprint || null;
  }

  function closeAll() {
    for (const [connectionId, entry] of clients) {
      clients.delete(connectionId);
      fingerprints.delete(connectionId);
      entry.promise.then((client) => {
        try { client.end(); } catch {}
      }).catch(() => {});
    }
  }

  return {
    connect,
    exec,
    withSftp,
    list,
    stat,
    observedFingerprint,
    closeAll,
  };
}

module.exports = {
  createSshPool,
  connectionFingerprint,
  createBudget,
  createOutputCollector,
  describeAttributes,
};