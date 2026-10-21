const fs = require('node:fs');
const path = require('node:path');

const { createSecretStore } = require('../secret-store.cjs');
const { toolError } = require('./errors.cjs');

/**
 * 读取 Web 网关的连接配置（`data/config.json`）。
 *
 * 为什么只支持这一份数据：桌面端凭据在系统钥匙串里，独立 Node 进程读不到。
 * 这里刻意**只读**：MCP 不新增/修改连接，避免 agent 自己造一个连接绕开用户授权。
 * 唯一会写盘的情况是显式的 MCP_TRUST_ON_FIRST_USE 首次信任记录，
 * 且只改 hostTrustRecords，原样保留已加密的凭据字段。
 */
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = 'config.json';
const BACKUP_FILE = 'config.json.bak';

function resolveDataDir(env = process.env) {
  const configured = String(env.AI_SSH_DATA_DIR || env.DATA_DIR || '').trim();
  return path.resolve(configured || DEFAULT_DATA_DIR);
}

function normalizePort(port) {
  return Number(port) || 22;
}

/** 从连接对象推断认证方式；不返回任何凭据内容。 */
function authTypeOf(connection) {
  if (connection?.privateKey) {
    return 'private-key';
  }
  if (connection?.password) {
    return 'password';
  }
  return 'none';
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function createConfigStore({ dataDir, passphrase } = {}) {
  const resolvedDir = path.resolve(dataDir || DEFAULT_DATA_DIR);
  const storePath = path.join(resolvedDir, CONFIG_FILE);
  const backupPath = path.join(resolvedDir, BACKUP_FILE);
  const secretStore = createSecretStore({
    dataDir: resolvedDir,
    passphrase,
  });

  /**
   * 读原始（仍是密文）配置。文件不存在返回 null；损坏时尝试 `.bak`。
   * 两份都不可用时抛错——静默当成空配置会让用户误以为连接没了。
   */
  function readRaw() {
    try {
      return readJson(storePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      try {
        const backup = readJson(backupPath);
        console.error(`[mcp] ${storePath} 读取失败，已改用备份 ${backupPath}：${error.message}`);
        return backup;
      } catch (backupError) {
        throw toolError(
          `无法读取配置文件 ${storePath}：${error.message}；备份也不可用：${backupError.message}`,
          'config-unreadable',
        );
      }
    }
  }

  /** 读并解密配置。返回副本，调用方修改它不会影响磁盘。 */
  function read() {
    const raw = readRaw() || {};
    return secretStore.decryptStore({
      connections: [],
      settings: {},
      aiProviders: [],
      commandHistory: [],
      quickCommands: [],
      quickCommandGroups: [],
      agentTasks: [],
      hostTrustRecords: [],
      ...raw,
      connections: Array.isArray(raw.connections) ? raw.connections : [],
      hostTrustRecords: Array.isArray(raw.hostTrustRecords) ? raw.hostTrustRecords : [],
    });
  }

  function trustRecords() {
    const raw = readRaw();
    return Array.isArray(raw?.hostTrustRecords) ? raw.hostTrustRecords : [];
  }

  /**
   * 覆盖写 hostTrustRecords。只动这一个字段，避免把解密后的凭据写回磁盘：
   * 原始文件里的 password/privateKey 保持原有密文形态。
   */
  function saveTrustRecords(records) {
    const raw = readRaw() || {};
    const payload = { ...raw, hostTrustRecords: Array.isArray(records) ? records : [] };
    fs.mkdirSync(resolvedDir, { recursive: true });
    const tempPath = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      if (fs.existsSync(storePath)) {
        fs.copyFileSync(storePath, backupPath);
      }
      fs.renameSync(tempPath, storePath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      throw error;
    }
  }

  return {
    dataDir: resolvedDir,
    storePath,
    read,
    readRaw,
    trustRecords,
    saveTrustRecords,
  };
}

/** 连接摘要：只暴露定位与认证方式，绝不带 password / privateKey / passphrase。 */
function connectionSummary(connection, trustRecords = []) {
  const record = trustRecords.find(
    (item) => item?.host === connection.host
      && normalizePort(item?.port) === normalizePort(connection.port),
  );
  return {
    id: String(connection.id),
    name: String(connection.name || connection.host || ''),
    host: String(connection.host || ''),
    port: normalizePort(connection.port),
    username: String(connection.username || ''),
    authType: authTypeOf(connection),
    trusted: Boolean(record),
    trustedAt: record ? Number(record.trustedAt) || null : null,
  };
}

function listConnectionSummaries(store, trustRecords = []) {
  const connections = Array.isArray(store?.connections) ? store.connections : [];
  return connections
    .map((connection) => connectionSummary(connection, trustRecords))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 按 id 或唯一名称解析连接；找不到时把可选 id/名称列出来，方便 agent 自我纠正。 */
function resolveConnection(store, key) {
  const wanted = String(key ?? '').trim();
  if (!wanted) {
    throw toolError('connection_id 不能为空', 'invalid-argument');
  }
  const connections = Array.isArray(store?.connections) ? store.connections : [];

  let connection = connections.find((item) => String(item.id) === wanted);
  if (!connection) {
    const byName = connections.filter(
      (item) => String(item.name || '').toLowerCase() === wanted.toLowerCase(),
    );
    if (byName.length > 1) {
      throw toolError(
        `连接名称 "${wanted}" 不唯一，请改用 id：${byName.map((item) => item.id).join(', ')}`,
        'ambiguous-connection',
      );
    }
    connection = byName[0];
  }

  if (!connection) {
    const known = connections
      .slice(0, 20)
      .map((item) => `${item.id} (${item.name || item.host})`)
      .join(', ');
    throw toolError(
      `未知连接 "${wanted}"。可用连接：${known || '（配置里没有任何连接）'}`,
      'unknown-connection',
    );
  }

  if (authTypeOf(connection) === 'none') {
    throw toolError(
      `连接 "${connection.name || connection.id}" 没有保存密码或私钥，请先在 Web 界面里补上凭据`,
      'missing-credential',
    );
  }

  return connection;
}

module.exports = {
  DEFAULT_DATA_DIR,
  CONFIG_FILE,
  BACKUP_FILE,
  resolveDataDir,
  createConfigStore,
  connectionSummary,
  listConnectionSummaries,
  resolveConnection,
};