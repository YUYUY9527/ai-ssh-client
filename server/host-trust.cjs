const crypto = require('node:crypto');
const { utils } = require('ssh2');

/**
 * 等待前端确认指纹的超时时间。与桌面端 `HOST_TRUST_PROMPT_TIMEOUT_SECS = 90`
 * 保持一致，避免同一台主机在两端等待时长不同。
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 90 * 1000;

/**
 * OpenSSH 风格指纹：`SHA256:<base64 去 padding>`。
 *
 * 与桌面端 russh 的 `PublicKey::fingerprint(HashAlg::Sha256)` 输出格式一致，
 * 因此同一台主机在桌面端与 Web 端显示、落盘的字符串可直接互认，
 * 用户可交叉核对两端的记录是否相同。
 */
function fingerprintOf(key) {
  const digest = crypto.createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * 从握手阶段的公钥 blob 解析算法名（如 `ssh-ed25519`、`rsa-sha2-512`）。
 * 解析失败只记为 unknown：算法名仅用于展示与记录比对，不应因此放行握手。
 */
function algorithmOf(key) {
  try {
    const parsed = utils.parseKey(key);
    if (parsed && typeof parsed.type === 'string' && parsed.type) {
      return parsed.type;
    }
  } catch {
    // 交给调用方按 unknown 记录，用户仍会看到指纹并自行判断。
  }
  return 'unknown';
}

/**
 * 主机指纹信任（TOFU）服务。
 *
 * 语义与桌面端 `SshHandler::check_server_key` 对齐：
 * - 已信任且指纹、算法都一致 → 直接放行，不打扰用户；
 * - 首次连接 / 密钥变更 → 经 WebSocket 询问前端，确认后才写入信任记录并继续握手；
 * - 用户拒绝或等待超时 → 握手失败，绝不静默放行。
 *
 * @param {object} options
 * @param {() => Array} options.loadRecords 读取信任记录
 * @param {(records: Array) => void} options.saveRecords 覆盖写入信任记录
 * @param {(clientId: string, prompt: object) => number} options.emitPrompt
 *        向前端推送确认请求，返回实际送达的 socket 数（0 表示无人可问）
 * @param {boolean} [options.trustOnFirstUse] 无人值守模式：自动信任首次连接的主机
 *        （密钥变更仍然拒绝），供无前端的自动化调用使用
 * @param {number} [options.promptTimeoutMs] 等待确认的超时时间
 * @param {() => number} [options.now] 时间源，便于测试
 */
function createHostTrust({
  loadRecords,
  saveRecords,
  emitPrompt,
  trustOnFirstUse = false,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  // requestId -> settle(accepted)：等待前端确认的挂起请求
  const pending = new Map();

  const normalizePort = (port) => Number(port) || 22;
  const sameHost = (item, host, port) => (
    item.host === host && normalizePort(item.port) === port
  );

  function getRecord(host, port) {
    const target = normalizePort(port);
    return loadRecords().find((item) => sameHost(item, host, target)) || null;
  }

  /** 最近信任的排在前面，与桌面端列表顺序一致。 */
  function listRecords() {
    return loadRecords()
      .slice()
      .sort((a, b) => (Number(b.trustedAt) || 0) - (Number(a.trustedAt) || 0));
  }

  function upsertRecord(record) {
    const host = String(record?.host || '').trim();
    const fingerprint = String(record?.fingerprint || '').trim();
    if (!host) {
      throw new Error('Host is required');
    }
    if (!fingerprint) {
      throw new Error('Fingerprint is required');
    }
    const next = {
      host,
      port: normalizePort(record.port),
      algorithm: String(record.algorithm || 'unknown'),
      fingerprint,
      trustedAt: Number(record.trustedAt) || now(),
    };
    saveRecords([
      ...loadRecords().filter((item) => !sameHost(item, host, next.port)),
      next,
    ]);
    return next;
  }

  function deleteRecord(host, port) {
    const target = normalizePort(port);
    const before = loadRecords();
    const after = before.filter((item) => !sameHost(item, String(host || ''), target));
    saveRecords(after);
    return before.length !== after.length;
  }

  function clearRecords() {
    saveRecords([]);
  }

  /**
   * 响应前端确认。返回是否命中挂起请求：
   * false 表示该请求已超时或被重复响应（不视为错误，前端可能重复点击）。
   */
  function respond(requestId, accepted) {
    const settle = pending.get(String(requestId || ''));
    if (!settle) {
      return false;
    }
    settle(accepted === true);
    return true;
  }

  function pendingCount() {
    return pending.size;
  }

  /**
   * 构造 ssh2 的 `hostVerifier`。
   *
   * ssh2 的 hostVerifier 支持异步：函数返回 undefined 并稍后调用
   * `verify(true|false)` 即为异步确认（同样适用于 hostVerifier 未设置时自动接受）。
   */
  function createVerifier({ host, port, clientId }) {
    const targetPort = normalizePort(port);
    return (key, verify) => {
      let fingerprint;
      let algorithm;
      try {
        fingerprint = fingerprintOf(key);
        algorithm = algorithmOf(key);
      } catch {
        // 连指纹都算不出来说明密钥数据异常，直接拒绝。
        verify(false);
        return;
      }

      const existing = getRecord(host, targetPort);
      if (existing && existing.fingerprint === fingerprint && existing.algorithm === algorithm) {
        verify(true);
        return;
      }

      // 无人值守模式只自动信任"首次连接"：已记录过的主机出现密钥变更时仍然拒绝，
      // 否则中间人替换密钥就等同于自动放行。
      if (trustOnFirstUse && !existing) {
        upsertRecord({ host, port: targetPort, algorithm, fingerprint, trustedAt: now() });
        verify(true);
        return;
      }

      const requestId = crypto.randomUUID();
      let settled = false;
      let timer = null;
      const settle = (accepted) => {
        if (settled) {
          return;
        }
        settled = true;
        pending.delete(requestId);
        if (timer) {
          clearTimeout(timer);
        }
        if (accepted) {
          upsertRecord({ host, port: targetPort, algorithm, fingerprint, trustedAt: now() });
        }
        verify(accepted);
      };

      timer = setTimeout(() => settle(false), promptTimeoutMs);
      // 挂起等待不应拖住进程退出。
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      pending.set(requestId, settle);

      const delivered = emitPrompt(clientId, {
        requestId,
        host,
        port: targetPort,
        algorithm,
        fingerprint,
        kind: existing ? 'keyChanged' : 'firstConnect',
        ...(existing
          ? {
            previousAlgorithm: existing.algorithm,
            previousFingerprint: existing.fingerprint,
          }
          : {}),
      });

      // 没有任何 socket 能收到确认请求（页面尚未建立 WS / 纯 HTTP 客户端）：
      // 立即失败，而不是让 HTTP 连接空挂满整个超时窗口。
      if (delivered === 0) {
        settle(false);
      }
    };
  }

  return {
    getRecord,
    listRecords,
    upsertRecord,
    deleteRecord,
    clearRecords,
    respond,
    pendingCount,
    createVerifier,
  };
}

module.exports = {
  createHostTrust,
  fingerprintOf,
  algorithmOf,
  DEFAULT_PROMPT_TIMEOUT_MS,
};
