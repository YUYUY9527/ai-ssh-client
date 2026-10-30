const path = require('node:path');

const packageJson = require('../../package.json');
const { createHostTrust } = require('../host-trust.cjs');
const { readSftpTextFile } = require('../sftp-items.cjs');
const { createAuditLog } = require('./audit.cjs');
const {
  createConfigStore,
  listConnectionSummaries,
  resolveConnection,
  resolveDataDir,
} = require('./config.cjs');
const { toolError } = require('./errors.cjs');
const { createPolicy, HARD_MAX_EXEC_TIMEOUT_MS } = require('./policy.cjs');
const { overriddenEnvVars, readPolicyFile } = require('./policy-file.cjs');
const { createSshPool } = require('./ssh.cjs');

const MAX_DIRECTORY_ENTRIES = 1000;

/** 拼接远端展示路径，保留 `~` 与 `.` 的语义（与 Web 网关的展示习惯一致）。 */
function joinRemotePath(parent, name) {
  const base = String(parent || '.').replace(/\/+$/, '') || '/';
  if (base === '/') {
    return `/${name}`;
  }
  return `${base}/${name}`;
}

function connectionRef(connection) {
  return {
    id: String(connection.id),
    name: String(connection.name || ''),
    host: String(connection.host || ''),
    port: Number(connection.port) || 22,
    username: String(connection.username || ''),
  };
}

function clampTimeout(value, fallback) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(requested), 1000), HARD_MAX_EXEC_TIMEOUT_MS);
}

/**
 * 把「配置 + 策略 + SSH 连接池 + 审计」组装成工具层。
 * 依赖可注入，单测不需要真的连 SSH。
 */
function createServices({ env = process.env, deps = {} } = {}) {
  const dataDir = resolveDataDir(env);
  // 策略文件在启动时读一次：文件损坏直接让 MCP 启动失败，不静默退回只读。
  const policyFileState = deps.policyFileState !== undefined
    ? deps.policyFileState
    : deps.policy
      ? null
      : readPolicyFile({ dataDir, env });
  const policy = deps.policy || createPolicy(env, { filePolicy: policyFileState?.policy });
  const config = deps.config || createConfigStore({
    dataDir,
    passphrase: env.WEB_AUTH_PASSWORD,
  });
  const audit = deps.audit || createAuditLog({
    file: env.MCP_AUDIT_LOG || path.join(dataDir, 'mcp-audit.log'),
    enabled: policy.auditEnabled ?? true,
  });
  const hostTrust = deps.hostTrust || createHostTrust({
    loadRecords: () => config.trustRecords(),
    saveRecords: (records) => config.saveTrustRecords(records),
    // stdio 场景没有前端可问：返回 0 让 host-trust 立即拒绝未知主机。
    emitPrompt: () => 0,
    trustOnFirstUse: policy.trustOnFirstUse,
  });
  // getConnection 每次 connect 都会被调用，且 config.read() 每次都读盘：
  // 因此用户在 Web 设置里改了 host/port/凭据后，无需重建 services，
  // 下一次请求就会按最新配置连接（连接池内部用配置指纹判断是否需要重连）。
  const pool = deps.pool || createSshPool({
    getConnection: (connectionId) => resolveConnection(config.read(), connectionId),
    hostTrust,
  });

  /** 兼容注入的假 policy（单测）：没有 modeFor 时按默认模式推断。 */
  function modeFor(connection) {
    if (typeof policy.modeFor === 'function') {
      return policy.modeFor(connection);
    }
    return policy.defaultMode || (policy.execAllowed ? 'exec' : 'read-only');
  }

  function listConnections() {
    const store = config.read();
    const connections = listConnectionSummaries(store, store.hostTrustRecords)
      .map((connection) => ({
        ...connection,
        mode: modeFor({ id: connection.id, name: connection.name }),
      }));
    return {
      dataDir,
      count: connections.length,
      execAllowed: policy.execAllowed,
      defaultMode: policy.defaultMode || 'read-only',
      connections,
    };
  }

  function getServerInfo() {
    return {
      name: 'ai-ssh-client',
      version: packageJson.version,
      dataDir,
      node: process.version,
      policy: policy.describe(),
      policyFile: policyFileState
        ? { path: policyFileState.path, exists: policyFileState.exists }
        : null,
      envOverrides: overriddenEnvVars(env),
      audit: { enabled: audit.enabled, file: audit.file },
    };
  }

  async function testConnection({ connection_id: connectionKey }) {
    const connection = resolveConnection(config.read(), connectionKey);
    const result = await pool.exec(connection.id, 'echo ai-ssh-client-mcp-ok', {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || !output.includes('ai-ssh-client-mcp-ok')) {
      audit.record({
        tool: 'test_connection',
        connection: connection.id,
        host: connection.host,
        outcome: 'failed',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
      throw toolError(
        `连接测试失败（exitCode=${result.exitCode}）：${result.stderr.trim() || result.stdout.trim() || '无输出'}`,
        'ssh-test-failed',
      );
    }
    audit.record({
      tool: 'test_connection',
      connection: connection.id,
      host: connection.host,
      outcome: 'ok',
      durationMs: result.durationMs,
    });
    return {
      ok: true,
      connection: connectionRef(connection),
      latencyMs: result.durationMs,
      hostKeyFingerprint: pool.observedFingerprint(connection.id),
    };
  }

  async function execCommand({ connection_id: connectionKey, command, timeout_ms: timeoutMs }) {
    // 先解析连接：连接级模式需要知道是哪台机器，未知连接也不能靠策略报错掩盖。
    const connection = resolveConnection(config.read(), connectionKey);
    const mode = modeFor(connection);
    const decision = policy.evaluateCommand(command, { connection });
    if (!decision.allowed) {
      audit.record({
        tool: 'ssh_exec',
        connection: connection.id,
        host: connection.host,
        command: String(command || ''),
        mode,
        outcome: 'blocked',
        code: decision.code,
        rule: decision.rule || null,
      });
      throw toolError(decision.reason, decision.code);
    }

    let result;
    try {
      result = await pool.exec(connection.id, command, {
        timeoutMs: clampTimeout(timeoutMs, policy.execTimeoutMs),
        maxOutputBytes: policy.maxOutputBytes,
      });
    } catch (error) {
      audit.record({
        tool: 'ssh_exec',
        connection: connection.id,
        host: connection.host,
        command,
        mode,
        outcome: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    audit.record({
      tool: 'ssh_exec',
      connection: connection.id,
      host: connection.host,
      command,
      mode,
      outcome: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'nonzero-exit',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
      exception: decision.rule === 'exception',
    });

    return {
      connection: connectionRef(connection),
      mode,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  }

  async function listDirectory({ connection_id: connectionKey, path: remotePath }) {
    const connection = resolveConnection(config.read(), connectionKey);
    const requested = String(remotePath || '.').trim() || '.';
    const entries = await pool.list(connection.id, requested);
    const sorted = entries
      .map((entry) => ({
        ...entry,
        path: joinRemotePath(requested, entry.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : b.type === 'directory' ? 1 : 0;
        }
        return a.name.localeCompare(b.name);
      });
    return {
      connection: connectionRef(connection),
      path: requested,
      count: sorted.length,
      truncated: sorted.length > MAX_DIRECTORY_ENTRIES,
      entries: sorted.slice(0, MAX_DIRECTORY_ENTRIES),
    };
  }

  async function statPath({ connection_id: connectionKey, path: remotePath }) {
    const connection = resolveConnection(config.read(), connectionKey);
    const requested = String(remotePath || '').trim();
    if (!requested) {
      throw toolError('path 不能为空', 'invalid-argument');
    }
    const attributes = await pool.stat(connection.id, requested);
    return {
      connection: connectionRef(connection),
      path: requested,
      ...attributes,
    };
  }

  async function readFile({ connection_id: connectionKey, path: remotePath, max_bytes: maxBytes }) {
    const connection = resolveConnection(config.read(), connectionKey);
    const requested = String(remotePath || '').trim();
    if (!requested) {
      throw toolError('path 不能为空', 'invalid-argument');
    }
    const requestedMax = Number(maxBytes);
    const limit = Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.round(requestedMax), policy.maxReadBytes)
      : policy.maxReadBytes;

    const file = await pool.withSftp(
      connection.id,
      // 复用 Web 网关的读取实现：它内部会做 ~ 转换、路径校验、大小限制与二进制粗检。
      (sftp) => readSftpTextFile(sftp, requested, limit),
    );
    return {
      connection: connectionRef(connection),
      path: requested,
      size: file.size,
      encoding: file.encoding,
      content: file.content,
    };
  }

  function close() {
    pool.closeAll();
  }

  return {
    dataDir,
    policy,
    audit,
    listConnections,
    getServerInfo,
    testConnection,
    execCommand,
    listDirectory,
    statPath,
    readFile,
    close,
  };
}

module.exports = {
  MAX_DIRECTORY_ENTRIES,
  joinRemotePath,
  createServices,
};