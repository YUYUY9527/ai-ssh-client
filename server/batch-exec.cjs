'use strict';

/**
 * 多机批量任务执行与文件分发（Batch Ops）：
 * - 基于已保存连接列表，受控并发地建立独立 SSH 连接执行非交互命令或 SFTP 写入文件
 * - 复用 ssh-keys.cjs 的凭据解析、ssh-transport.cjs 的代理/跳板与 host-trust.cjs 指纹校验
 * - 每台主机独立超时、独立回收连接，单机失败不影响其余主机
 */

const { Client } = require('ssh2');
const { execCommand } = require('./ssh-exec.cjs');
const { openTransport } = require('./ssh-transport.cjs');
const { resolveConnectionCredentials } = require('./ssh-keys.cjs');

const MAX_CONCURRENCY = 20;
const MAX_BATCH_FILE_BYTES = 10 * 1024 * 1024; // 单次批量分发上限 10 MiB

async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || 5));
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

async function connectEphemeral(connection, { clientId, createVerifier, timeoutMs = 20000 }) {
  const { sock, dispose } = await openTransport({
    connection,
    clientId,
    createVerifier,
  });
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const cleanup = () => {
      try { client.end(); } catch { /* ignore */ }
      try { dispose(); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('SSH connect timed out'));
    }, Math.max(5000, Math.min(timeoutMs, 30000)));

    client
      .on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ client, cleanup });
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      })
      .connect({
        host: connection.host,
        port: connection.port || 22,
        username: connection.username,
        password: connection.password || undefined,
        privateKey: connection.privateKey || undefined,
        passphrase: connection.passphrase || undefined,
        readyTimeout: Math.max(5000, Math.min(timeoutMs, 30000)),
        sock: sock || undefined,
        hostVerifier: createVerifier
          ? createVerifier({ host: connection.host, port: connection.port || 22, clientId })
          : undefined,
      });
  });
}

function writeSftpBuffer(client, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(remotePath, buffer, (writeErr) => {
        try { sftp.end(); } catch { /* ignore */ }
        if (writeErr) return reject(writeErr);
        resolve();
      });
    });
  });
}

/** 批量在多台已保存主机上执行同一命令。 */
async function runBatchCommand({
  connectionIds,
  command,
  store,
  clientId = '',
  concurrency = 5,
  timeoutMs = 30000,
  createVerifier,
}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');
  if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
    throw new Error('At least one connectionId is required');
  }
  const all = Array.isArray(store?.connections) ? store.connections : [];
  const connMap = new Map(all.map((item) => [item.id, item]));
  const targets = connectionIds.map((id) => ({ id, raw: connMap.get(id) || null }));
  const execTimeout = Math.max(3000, Math.min(Number(timeoutMs) || 30000, 300000));

  const results = await runWithConcurrency(targets, concurrency, async ({ id, raw }) => {
    const startedAt = Date.now();
    if (!raw) {
      return {
        connectionId: id,
        name: id,
        host: '',
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: 'Connection not found',
      };
    }
    const resolved = resolveConnectionCredentials(raw, store);
    let handle = null;
    try {
      handle = await connectEphemeral(resolved, { clientId, createVerifier, timeoutMs: execTimeout });
      const res = await execCommand(handle.client, cmd, {
        timeoutMs: execTimeout,
        maxBytes: 256 * 1024,
      });
      return {
        connectionId: raw.id,
        name: raw.name,
        host: `${raw.username}@${raw.host}:${raw.port || 22}`,
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        durationMs: Date.now() - startedAt,
        stdout: res.output || '',
        stderr: res.stderr || '',
        error: res.exitCode === 0 ? undefined : (String(res.stderr || '').trim() || `Exit code ${res.exitCode}`),
      };
    } catch (error) {
      return {
        connectionId: raw.id,
        name: raw.name,
        host: `${raw.username}@${raw.host}:${raw.port || 22}`,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      handle?.cleanup();
    }
  });

  return {
    command: cmd,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/** 批量分发单个文件到多台已保存主机的指定远端路径。 */
async function runBatchDistribute({
  connectionIds,
  remotePath,
  contentBase64,
  store,
  clientId = '',
  concurrency = 5,
  timeoutMs = 30000,
  createVerifier,
}) {
  const targetPath = String(remotePath || '').trim();
  if (!targetPath || targetPath.includes('\0')) throw new Error('Valid remotePath is required');
  if (!Array.isArray(connectionIds) || connectionIds.length === 0) {
    throw new Error('At least one connectionId is required');
  }
  const buffer = Buffer.from(String(contentBase64 || ''), 'base64');
  if (buffer.length > MAX_BATCH_FILE_BYTES) {
    throw new Error(`File exceeds batch distribution limit (${MAX_BATCH_FILE_BYTES} bytes)`);
  }
  const all = Array.isArray(store?.connections) ? store.connections : [];
  const connMap = new Map(all.map((item) => [item.id, item]));
  const targets = connectionIds.map((id) => ({ id, raw: connMap.get(id) || null }));

  const results = await runWithConcurrency(targets, concurrency, async ({ id, raw }) => {
    const startedAt = Date.now();
    if (!raw) {
      return {
        connectionId: id,
        name: id,
        host: '',
        ok: false,
        remotePath: targetPath,
        bytes: 0,
        durationMs: 0,
        error: 'Connection not found',
      };
    }
    const resolved = resolveConnectionCredentials(raw, store);
    let handle = null;
    try {
      handle = await connectEphemeral(resolved, { clientId, createVerifier, timeoutMs });
      await writeSftpBuffer(handle.client, targetPath, buffer);
      return {
        connectionId: raw.id,
        name: raw.name,
        host: `${raw.username}@${raw.host}:${raw.port || 22}`,
        ok: true,
        remotePath: targetPath,
        bytes: buffer.length,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        connectionId: raw.id,
        name: raw.name,
        host: `${raw.username}@${raw.host}:${raw.port || 22}`,
        ok: false,
        remotePath: targetPath,
        bytes: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      handle?.cleanup();
    }
  });

  return {
    remotePath: targetPath,
    bytes: buffer.length,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  runBatchCommand,
  runBatchDistribute,
  MAX_BATCH_FILE_BYTES,
};
