const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const posixPath = require('node:path').posix;
const { StringDecoder } = require('node:string_decoder');

const express = require('express');
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');
const {
  formatAgentCommandEcho,
  makeSentinelMarker,
  parseSentinel,
  stripCompleteSentinelArtifacts,
  stripVisibleAgentArtifacts,
  wrapCommandWithSentinel,
} = require('./sentinel.cjs');
const {
  createSftpDirectory,
  deleteSftpItem,
  deleteSftpItems,
  readSftpTextFile,
  renameSftpItem,
  setSftpPermissions,
  sftpProtocolPath,
  writeSftpTextFile,
} = require('./sftp-items.cjs');
const { createSftpTransferService } = require('./sftp-transfer.cjs');
const { createAuth } = require('./auth.cjs');
const { createHostTrust } = require('./host-trust.cjs');
const { createSecretStore } = require('./secret-store.cjs');
const { sessionKeyOf, clientKeysOf } = require('./session-key.cjs');
const { resolveTlsOptions } = require('./tls.cjs');
const {
  probeInteractivePwd,
  stripPwdProbeArtifacts,
} = require('./shell-cwd-probe.cjs');

const PORT = Number(process.env.WEB_PORT || 5080);
// 默认仅监听 127.0.0.1，避免凭据暴露到局域网；Docker 需在容器内监听 0.0.0.0（见 compose）。
const HOST = process.env.WEB_HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'config.json');
const AI_DEBUG_LOG_FILE = process.env.AI_DEBUG_LOG_FILE || '';
const AI_DEBUG_LOG_STDOUT = process.env.AI_DEBUG_LOG === '1';

function redactAiDebugText(value) {
  return String(value || '')
    .replace(/(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[redacted]')
    .slice(0, 4000);
}

function writeAiDebug(kind, requestId, providerId, content, extra = {}) {
  if (!AI_DEBUG_LOG_FILE && !AI_DEBUG_LOG_STDOUT) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    kind,
    requestId: requestId || '',
    providerId: providerId || '',
    content: redactAiDebugText(content),
    ...extra,
  });
  if (AI_DEBUG_LOG_STDOUT) console.warn(`[ai-debug] ${line}`);
  if (AI_DEBUG_LOG_FILE) {
    const file = path.isAbsolute(AI_DEBUG_LOG_FILE)
      ? AI_DEBUG_LOG_FILE
      : path.join(DATA_DIR, AI_DEBUG_LOG_FILE);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`);
    } catch (error) {
      console.warn(`[ai-debug] failed to write log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
const STATIC_DIR = path.join(__dirname, '..', 'dist', 'renderer');
// HTTPS（可选）：浏览器会拦截纯 HTTP 页面上的不安全下载（.pcap/.zip 等），
// 局域网部署建议用 WEB_TLS=1 自签名证书或 WEB_TLS_CERT/WEB_TLS_KEY 接入正式证书。
const TLS_OPTIONS = (() => {
  try {
    return resolveTlsOptions(process.env, { dataDir: DATA_DIR, log: console.info });
  } catch (error) {
    console.error(`TLS configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();

const defaultSettings = {
  language: 'zh-CN',
  theme: 'dark',
  fontSize: 14,
  fontFamily: "Consolas, 'Courier New', monospace",
  keepaliveInterval: 60,
  keepaliveCountMax: 3,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  showTerminalOutputPrompt: true,
  terminalTheme: 'dark',
  terminalScrollback: 3000,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalCopyOnSelect: false,
  terminalShellIntegration: true,
  agentSemanticSummaryContextLength: 12000,
  maxPersistedSessions: 8,
  maxScrollbackBytesPerSession: 150 * 1024,
};

// 会话表：key 为 sessionKeyOf(connectionId, clientId) 复合键（格式见 session-key.cjs）。
// Web 多客户端隔离：同一连接配置可被多台浏览器同时打开，每个客户端拥有独立 SSH shell 会话，
// 防止两台电脑（或同一浏览器两个标签页）共享同一会话互相串命令。
const sessions = new Map();
const sockets = new Set();
const activeAiRequests = new Map();
// 在途 agent 执行：key = sessionKeyOf(connectionId, clientId)。
// 必须按客户端区分：多客户端连同一台主机时，若只按 connectionId 索引，
// 后发起的执行会覆盖前一个的取消句柄，导致"取消/暂停"误伤别的客户端。
const activeAgentExecs = new Map();
const AGENT_INTERRUPT_SETTLE_MS = 250;
// clientId → 延迟清理定时器（WS 断开后宽限期内可被重连取消）
const pendingSessionCleanup = new Map();
// 幽灵会话宽限期：WS 断开（关标签/崩溃/断网）后延迟释放 SSH 会话，
// 同 clientId 的新 socket 重连（网络瞬断秒级恢复）可取消清理，不误杀 vim 等现场。
const SESSION_CLEANUP_GRACE_MS = 20 * 1000;
// 前端 pagehide 通知后的快清宽限期：F5 刷新重挂需保留现场，因此不立即清，
// 只把宽限缩短到 5s（刷新后新页面秒级重连会取消；真关闭则 5s 后释放）。
const SESSION_CLEANUP_FAST_MS = 5 * 1000;
// WS 发送背压阈值：目标 socket 缓冲超高水位 → 暂停 shell 输出，排空到低水位 → 恢复。
const WS_HIGH_WATER = 512 * 1024;
const WS_LOW_WATER = 128 * 1024;

/** SSH 路由的客户端标识：优先 x-ssh-client-id，兼容旧版 x-sftp-client-id。 */
function requestClientId(request) {
  return String(request.get('x-ssh-client-id') || request.get('x-sftp-client-id') || '').slice(0, 200);
}

/** 关闭某连接配置下所有客户端的会话（删除连接时兜底清理）。 */
function closeSessionsForConnection(connectionId) {
  const prefix = `${connectionId}::`;
  Array.from(sessions.keys())
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => closeSessionByKey(key));
}

function success(data) {
  return data === undefined ? { success: true } : { success: true, data };
}

function failure(error) {
  const payload = {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
  // 透传业务/系统错误码，便于前端区分冲突、中断与 IO 失败
  if (error && typeof error === 'object' && error.code != null && error.code !== '') {
    payload.code = String(error.code);
  }
  if (error?.task) {
    payload.task = error.task;
  }
  return payload;
}

function normalizeSettings(settings) {
  const normalized = { ...defaultSettings, ...(settings || {}) };
  delete normalized.agentMaxExecutionSteps;
  return normalized;
}

/**
 * 凭据加解密：env 模式（WEB_AUTH_PASSWORD）从口令派生密钥且不落盘，
 * 否则使用 data/secret.key（0600）。威胁模型见 secret-store.cjs。
 */
const secretStore = createSecretStore({
  dataDir: DATA_DIR,
  passphrase: process.env.WEB_AUTH_PASSWORD,
});

function readStore() {
  try {
    const stored = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return secretStore.decryptStore({
      connections: [],
      settings: defaultSettings,
      commandHistory: [],
      quickCommands: [],
      quickCommandGroups: [],
      aiProviders: [],
      agentTasks: [],
      hostTrustRecords: [],
      ...stored,
      settings: normalizeSettings(stored.settings),
    });
  } catch {
    return {
      connections: [],
      settings: defaultSettings,
      commandHistory: [],
      quickCommands: [],
      quickCommandGroups: [],
      aiProviders: [],
      agentTasks: [],
      hostTrustRecords: [],
    };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 落盘前加密 SSH 密码/私钥/passphrase 与 AI apiKey；历史明文字段在本次写入时被一并加密。
  const payload = secretStore.encryptStore(store);
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function updateStore(update) {
  const store = readStore();
  update(store);
  writeStore(store);
  return store;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConnections(input) {
  return asArray(input).map((connection) => ({
    id: String(connection.id || Date.now()),
    name: String(connection.name || connection.host || 'SSH Connection'),
    host: String(connection.host || ''),
    port: Number(connection.port || 22),
    username: String(connection.username || ''),
    password: connection.password || undefined,
    privateKey: connection.privateKey || connection.private_key || undefined,
    passphrase: connection.passphrase || undefined,
  })).filter((connection) => connection.host && connection.username);
}

function normalizeImportData(input) {
  const data = input?.data || input || {};

  return {
    connections: normalizeConnections(
      data.connections || data.sshConnections || data.ssh_connections,
    ),
    settings: data.settings,
    commandHistory: asArray(data.commandHistory || data.command_history),
    quickCommands: asArray(data.quickCommands || data.quick_commands),
    quickCommandGroups: asArray(data.quickCommandGroups || data.quick_command_groups),
    aiProviders: asArray(data.aiProviders || data.ai_providers),
    hostTrustRecords: asArray(data.hostTrustRecords || data.host_trust_records),
  };
}

function maskSecret(secret) {
  if (!secret) {
    return undefined;
  }
  if (secret.length <= 8) {
    return '*'.repeat(secret.length);
  }

  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function providerToSummary(provider) {
  const apiKey = provider.apiKey || '';

  return {
    ...provider,
    apiKey: undefined,
    hasApiKey: apiKey.trim().length > 0,
    maskedApiKey: apiKey.trim() ? maskSecret(apiKey.trim()) : undefined,
  };
}

function getProvider(providerId) {
  return readStore().aiProviders.find((provider) => (
    provider.id === providerId && provider.isActive
  ));
}

function defaultBaseUrl(provider) {
  const baseUrl = provider.baseUrl?.trim();
  if (baseUrl) {
    return baseUrl.replace(/\/+$/, '');
  }

  switch (provider.type) {
    case 'ollama':
      return 'http://host.docker.internal:11434/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openai':
    case 'openai-compatible':
    default:
      return 'https://api.openai.com/v1';
  }
}

function defaultModel(provider) {
  if (provider.model?.trim()) {
    return provider.model.trim();
  }

  switch (provider.type) {
    case 'ollama':
      return 'llama3.1';
    case 'gemini':
      return 'gemini-2.0-flash';
    case 'anthropic':
      return 'claude-3-5-sonnet-latest';
    case 'openai':
    case 'openai-compatible':
    default:
      return 'gpt-4o-mini';
  }
}

async function chatWithProvider(provider, messages, requestId) {
  if (!provider) {
    throw new Error('Provider not found or not active');
  }

  const apiKey = provider.apiKey?.trim() || '';
  if (provider.type !== 'ollama' && !apiKey) {
    throw new Error('缺少 API Key');
  }

  const controller = new AbortController();
  const effectiveRequestId = requestId || `${provider.id}-${Date.now()}`;
  activeAiRequests.set(effectiveRequestId, controller);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${defaultBaseUrl(provider)}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: defaultModel(provider),
        temperature: 0.7,
        messages: messages.map((message) => ({
          role: ['system', 'assistant', 'user'].includes(message.role) ? message.role : 'user',
          content: message.content,
        })),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`AI service error ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error('AI 响应格式无效');
    }

    const result = {
      content: choice.message.content || '',
      model: data.model || defaultModel(provider),
      finishReason: choice.finish_reason,
      requestId: effectiveRequestId,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
    writeAiDebug('response', effectiveRequestId, provider.id, result.content, {
      model: result.model,
      finishReason: result.finishReason,
    });
    return result;
  } finally {
    activeAiRequests.delete(effectiveRequestId);
  }
}

async function streamChatWithProvider(provider, messages, requestId, sendEvent) {
  if (!provider) throw new Error('Provider not found or not active');
  const apiKey = provider.apiKey?.trim() || '';
  if (provider.type !== 'ollama' && !apiKey) throw new Error('缺少 API Key');
  if (!requestId) throw new Error('Missing AI request ID');
  if (activeAiRequests.has(requestId)) throw new Error('AI request ID is already active');

  const controller = new AbortController();
  activeAiRequests.set(requestId, controller);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${defaultBaseUrl(provider)}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: defaultModel(provider),
        temperature: 0.7,
        stream: true,
        messages: messages.map((message) => ({
          role: ['system', 'assistant', 'user'].includes(message.role) ? message.role : 'user',
          content: message.content,
        })),
      }),
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`AI service error ${response.status}: ${body.slice(0, 500)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let model = defaultModel(provider);
    let finishReason;
    let usage;
    let responseContent = '';
    let providerDone = false;
    while (!providerDone) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() || '';
      for (const record of records) {
        const data = record.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          providerDone = true;
          break;
        }
        const chunk = JSON.parse(data);
        model = chunk.model || model;
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
          responseContent += choice.delta.content;
          sendEvent({ type: 'delta', requestId, delta: choice.delta.content });
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }
      if (done) break;
    }
    if (!providerDone) throw new Error('AI stream disconnected before completion');
    writeAiDebug('stream_response', requestId, provider.id, responseContent, {
      model,
      finishReason,
      usage,
    });
    sendEvent({ type: 'done', requestId, model, finishReason, usage });
  } catch (error) {
    if (controller.signal.aborted) sendEvent({ type: 'canceled', requestId });
    else sendEvent({ type: 'error', requestId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    activeAiRequests.delete(requestId);
  }
}

function runSshCommand(connectionId, command, options = {}, clientId = '') {
  const session = getSession(connectionId, clientId);
  const stream = session.stream;
  const runId = options.runId || `${connectionId}-${Date.now()}`;
  const timeoutMs = Number(options.timeoutMs || 45000);
  const marker = makeSentinelMarker(runId);
  const execKey = sessionKeyOf(connectionId, clientId);

  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    let timeout = null;
    // 中断原因（canceled / timeout）。一旦主动发过 Ctrl-C，就必须由它决定 reason：
    // 被中断的 shell 往往会紧接着打印 sentinel（退出码 130），若让 handleData
    // 抢先结算就会报成 "done"，与桌面端"取消即 canceled"的语义不一致。
    let interruptReason = null;

    const finish = (reason, exitCode = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      stream.off('data', handleData);
      stream.off('close', handleClose);
      activeAgentExecs.delete(execKey);
      const output = stripCompleteSentinelArtifacts(buffer);
      resolve(success({ output, exitCode, reason: interruptReason || reason }));
    };

    const handleData = (data) => {
      const text = data.toString('utf8');
      buffer += text;
      const parsed = parseSentinel(buffer, marker);
      if (parsed) {
        buffer = parsed.output;
        finish('done', parsed.exitCode);
      }
    };

    const handleClose = () => finish('closed');
    const interruptAndFinish = (reason) => {
      interruptReason = reason;
      stream.write('\x03');
      setTimeout(() => finish(reason), AGENT_INTERRUPT_SETTLE_MS);
    };

    activeAgentExecs.get(execKey)?.();
    activeAgentExecs.set(execKey, () => interruptAndFinish('canceled'));

    stream.on('data', handleData);
    stream.on('close', handleClose);
    timeout = setTimeout(() => interruptAndFinish('timeout'), timeoutMs);

    emitToClient(clientId, 'ssh-data', { connectionId, data: formatAgentCommandEcho(command) });
    session.agentEchoPending = true;
    stream.write(wrapCommandWithSentinel(command, runId));
  });
}

/**
 * 中止指定连接上、属于指定客户端的在途 agent 执行。
 * 返回是否命中（false 表示当前没有在跑的执行，属正常情况）。
 */
function cancelAgentExec(connectionId, clientId = '') {
  const key = sessionKeyOf(connectionId, clientId);
  const cancel = activeAgentExecs.get(key);
  if (!cancel) {
    return false;
  }
  cancel();
  activeAgentExecs.delete(key);
  return true;
}

/**
 * 中止某客户端全部在途 agent 执行，返回被中止的数量。
 * 对应桌面端 `agent_pause_task` → `cancel_all_execs()`：暂停时真正掐断远端命令，
 * 而不仅仅是前端停止等待。
 */
function cancelAgentExecsForClient(clientId = '') {
  let canceled = 0;
  clientKeysOf(Array.from(activeAgentExecs.keys()), clientId).forEach((key) => {
    activeAgentExecs.get(key)?.();
    activeAgentExecs.delete(key);
    canceled += 1;
  });
  return canceled;
}

/**
 * 定向推送：仅发送给指定客户端的 socket（SSH 事件按客户端隔离）。
 * 返回实际送达的 socket 数，供调用方判断"是否有人能收到"。
 */
function emitToClient(clientId, type, payload) {
  const data = JSON.stringify({ type, payload });
  let delivered = 0;
  sockets.forEach((socket) => {
    const matches = socket.clientId === clientId || socket.sshClientId === clientId;
    if (matches && socket.readyState === socket.OPEN) {
      socket.send(data);
      delivered += 1;
    }
  });
  return delivered;
}

/**
 * 主机指纹信任：Web 端此前完全不校验主机密钥（ssh2 不传 hostVerifier 时自动接受），
 * 属于中间人风险。此处对齐桌面端 TOFU 语义：首次连接/密钥变更都要用户确认。
 */
const hostTrust = createHostTrust({
  loadRecords: () => readStore().hostTrustRecords || [],
  saveRecords: (records) => updateStore((store) => {
    store.hostTrustRecords = records;
  }),
  emitPrompt: (clientId, prompt) => emitToClient(clientId, 'ssh-host-trust-prompt', prompt),
  // 无前端的自动化场景（纯 HTTP 调用、脚本导入后直连）可显式开启：
  // 自动信任未记录过的主机，但密钥变更依旧拒绝。
  trustOnFirstUse: process.env.WEB_SSH_TRUST_ON_FIRST_USE === 'true',
  promptTimeoutMs: Math.max(5000, Number(process.env.WEB_SSH_HOST_TRUST_TIMEOUT_MS) || 90000),
});

const sftpTransfers = createSftpTransferService({
  getSftp,
  emitEvent: emitToClient,
});

function stateFor(connectionId, clientId, patch = {}) {
  const session = sessions.get(sessionKeyOf(connectionId, clientId));

  return {
    connectionId,
    isConnected: Boolean(session?.ready),
    isConnecting: Boolean(session && !session.ready),
    reconnectAttempts: 0,
    ...patch,
  };
}

/** 单会话输出环形缓冲上限：刷新重挂时回放 MOTD/提示符；1MB 避免 vim 大文件滚动频繁截断。 */
const MAX_SSH_OUTPUT_BUFFER = 1024 * 1024;

/** 进入/退出 alt screen 的常见序列族（1049/1047/47）。 */
const ALT_SWITCH_RE = /\x1b\[\?(?:1049|1047|47)([hl])/g;
const ALT_ENTER_SEQUENCE = '\x1b[?1049h';

function scanAltScreenState(text) {
  let last = null;
  ALT_SWITCH_RE.lastIndex = 0;
  let match;
  while ((match = ALT_SWITCH_RE.exec(text)) !== null) {
    last = match[1];
  }
  return last === 'h';
}

function detectAltSwitch(text) {
  let last = null;
  ALT_SWITCH_RE.lastIndex = 0;
  let match;
  while ((match = ALT_SWITCH_RE.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

/** CSI 终止字节范围（0x40-0x7E，参数中间字节为 0x20-0x3F）。 */
function isCsiFinalByte(code) {
  return code >= 0x40 && code <= 0x7E;
}

/** OSC/DCS/APC/PM/SOS 序列族的第二字节（均以 ST 或 BEL 终止）。 */
const STRING_SEQUENCE_TAILS = new Set([']', 'P', 'X', '^', '_']);

/** 2 字节 ESC 序列族的第二字节（后跟单个终结字节）。 */
const TWO_BYTE_PREFIX = new Set(['(', ')', '*', '+', '-', '.', '/', '#', '%']);

/** 单字节 ESC 序列：ESC + 1 字节即完成（C1 控制/单字节命令）。 */
const SINGLE_BYTE_TAILS = new Set([
  '7', '8', '9', '=', '>', 'D', 'E', 'F', 'G', 'H', 'K', 'M', 'N',
  'O', 'Z', 'c',
]);

/** 扫描 content 中从 escIndex 开始的转义序列，返回结束后的下标；畸形返回 -1。 */
function escapeSequenceEndAt(content, escIndex) {
  const next = content[escIndex + 1];
  if (next === undefined) {
    return -1;
  }
  if (next === '[') {
    let j = escIndex + 2;
    while (j < content.length) {
      const code = content.charCodeAt(j);
      j += 1;
      if (isCsiFinalByte(code)) {
        return j;
      }
    }
    return -1;
  }
  if (STRING_SEQUENCE_TAILS.has(next)) {
    let j = escIndex + 2;
    while (j < content.length) {
      const ch = content[j];
      if (ch === '\x07') {
        return j + 1;
      }
      if (ch === '\x1b' && content[j + 1] === '\\') {
        return j + 2;
      }
      j += 1;
    }
    return -1;
  }
  if (TWO_BYTE_PREFIX.has(next)) {
    return escIndex + 3 <= content.length ? escIndex + 3 : -1;
  }
  if (SINGLE_BYTE_TAILS.has(next)) {
    return escIndex + 2 <= content.length ? escIndex + 2 : -1;
  }
  return escIndex + 2 <= content.length ? escIndex + 2 : -1;
}

/**
 * 截断窗口起点对齐到转义序列边界：
 * nano/vim 在 alt screen 内的重绘流无 LF/CRLF 行边界（全用 CUP/VPA
 * 绝对定位），行边界对齐失效，窗口起点极易落在 `\x1b[8;1H` 这类 CSI
 * 序列内部——ESC 被丢在窗口外，序列残余（如 `8;1H`）被 xterm 当作
 * 普通文本绘制在行尾 → 行号与内容重叠粘连、画面错乱。
 */
function alignToEscapeBoundary(content, cut) {
  if (cut <= 0 || cut >= content.length) {
    return cut;
  }
  const esc = content.lastIndexOf('\x1b', cut - 1);
  if (esc === -1) {
    return cut;
  }
  const seqEnd = escapeSequenceEndAt(content, esc);
  if (seqEnd === -1 || seqEnd > content.length) {
    return cut;
  }
  return cut >= seqEnd ? cut : seqEnd;
}

/**
 * 将 shell 输出写入会话缓冲（丢弃时仍可 HTTP 拉取）。
 * 超限时按行边界截断 + 转义序列边界对齐：重放/合并时 chunk 从完整行
 * 开始，且绝不切断转义序列（nano/vim alt 流内无行边界，行边界对齐失效，
 * 必须再按序列边界对齐，否则 `\x1b[8;1H` 残片会被当文本绘制）。
 * 同时保持 alt screen 状态：vim/nano 的 1049h 只在进入时发送一次
 * 且位于流头部，截断会滑掉它；若截断前处于 alt screen，在截断窗口
 * 头部补写进入序列，刷新重挂回放后终端状态机才不致错位。
 */
function appendSessionOutput(session, text) {
  if (!session || !text) {
    return;
  }
  const next = `${session.outputBuffer || ''}${text}`;
  if (next.length <= MAX_SSH_OUTPUT_BUFFER) {
    session.outputBuffer = next;
    return;
  }
  // 1) 尾部窗口，切点对齐到转义序列边界（alt 流内无行边界，防止切碎序列）。
  const cut = alignToEscapeBoundary(next, next.length - MAX_SSH_OUTPUT_BUFFER);
  let truncated = next.slice(cut);
  // 2) 行边界对齐：普通 shell 流（含 LF/CRLF）从完整行开始，避免行首残片。
  const lineStart = truncated.search(/[\r\n]/);
  if (lineStart > 0) {
    truncated = truncated.slice(lineStart);
  }
  // 3) 截断前在 alt screen 而窗口内无任何切换序列 → 补 1049h 头，
  //    保证任何以该窗口开头的回放都从 alt 状态开始。
  if (scanAltScreenState(next) && detectAltSwitch(truncated) === null) {
    truncated = ALT_ENTER_SEQUENCE + truncated;
  }
  session.outputBuffer = truncated;
}

/**
 * 应用终端窗口尺寸：session 未就绪（连接握手期）时缓存到 pendingResize，
 * shell 建立后立即套用（见 connectSsh 中 session.ready = true 分支）。
 * 防止 PTY 卡在 connect 请求的初始 200x50，导致 top/vim 按错误行列绘制。
 */
function applySessionResize(session, cols, rows) {
  if (!session) {
    return;
  }
  const c = Math.max(2, Math.min(1000, Number(cols) || 0));
  const r = Math.max(2, Math.min(1000, Number(rows) || 0));
  if (!c || !r) {
    return;
  }
  if (session.ready && session.stream) {
    session.stream.setWindow(r, c);
  } else {
    session.pendingResize = { cols: c, rows: r };
  }
}

/** 按复合 key 关闭会话，仅通知该会话归属的客户端。 */
function closeSessionByKey(key) {  const session = sessions.get(key);
  if (!session) {
    return;
  }

  sessions.delete(key);
  session.sftp?.end?.();
  session.stream?.end();
  session.client.end();
  if (session.clientId) {
    emitToClient(session.clientId, 'ssh-close', session.connectionId);
  }
}

function closeSession(connectionId, clientId) {
  closeSessionByKey(sessionKeyOf(connectionId, clientId));
}

/** 延迟清理：WS 断开后按 clientId 宽限清理其全部会话；同 clientId 重连（瞬断）可取消。 */
function scheduleSessionCleanup(clientId, graceMs = SESSION_CLEANUP_GRACE_MS) {
  if (!clientId) {
    return;
  }
  const existing = pendingSessionCleanup.get(clientId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    pendingSessionCleanup.delete(clientId);
    for (const [key, session] of sessions) {
      if (session.clientId === clientId) {
        closeSessionByKey(key);
      }
    }
  }, graceMs);
  pendingSessionCleanup.set(clientId, timer);
}

function cancelSessionCleanup(clientId) {
  if (!clientId) {
    return;
  }
  const existing = pendingSessionCleanup.get(clientId);
  if (existing) {
    clearTimeout(existing);
    pendingSessionCleanup.delete(clientId);
  }
}

/** WS 发送缓冲排空后，恢复该 client 下被背压暂停的 shell 输出流。 */
function resumeStreamsForClient(clientId) {
  if (!clientId) {
    return;
  }
  for (const session of sessions.values()) {
    if (session.clientId === clientId && session.paused && session.stream) {
      session.stream.resume();
      session.paused = false;
    }
  }
}

function emitSessionClose(connectionId, clientId) {
  const key = sessionKeyOf(connectionId, clientId);
  const session = sessions.get(key);
  if (sessions.delete(key)) {
    emitToClient(session?.clientId || clientId, 'ssh-close', connectionId);
  }
}

function connectSsh(connection, cols, rows, settings = defaultSettings, clientId = '') {
  return new Promise((resolve, reject) => {
    // 只关闭自己 clientId 的旧会话，绝不顶掉其他客户端的会话
    closeSession(connection.id, clientId);

    const client = new Client();
    const session = {
      client,
      stream: null,
      sftp: null,
      sftpPromise: null,
      ready: false,
      clientId,
      connectionId: connection.id,
      outputBuffer: '',
      // 跨 chunk 拼 UTF-8，避免多字节字符被 TCP 分片切断成乱码
      outputDecoder: new StringDecoder('utf8'),
    };
    sessions.set(sessionKeyOf(connection.id, clientId), session);
    emitToClient(clientId, 'ssh-data', {
      connectionId: connection.id,
      data: '',
      type: 'state',
      state: stateFor(connection.id, clientId),
    });

    let settled = false;
    // TCP 黑洞（SYN 无应答）时 ssh2 既不 ready 也不 error/close，HTTP 请求会挂起数分钟，
    // 前端永远停在"重新连接中"。硬超时兜底，保证及时失败并进入下一轮重试。
    const hardTimeoutMs = Math.max(10000, Number(process.env.SSH_CONNECT_TIMEOUT_MS ?? 30000));
    const hardTimeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        client.end();
      } catch {
        // ignore
      }
      sessions.delete(sessionKeyOf(connection.id, clientId));
      reject(new Error('SSH connect timed out'));
    }, hardTimeoutMs);
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(hardTimeout);
      resolve(result);
    };

    /** 解码并广播一帧 shell 输出（含 agent / pwd 探测伪影剥离）。 */
    const publishShellOutput = (raw) => {
      const decoded = typeof raw === 'string'
        ? raw
        : session.outputDecoder.write(raw);
      const text = stripPwdProbeArtifacts(
        stripVisibleAgentArtifacts(session, decoded),
      );
      if (!text) {
        return;
      }
      // 先缓冲再推送：WS 未就绪时刷新后仍可回放
      appendSessionOutput(session, text);
      // 单次构造双事件帧：避免同一内容重复 JSON.stringify + 重复遍历 sockets
      const payload = { connectionId: connection.id, data: text };
      const frameAgent = JSON.stringify({ type: 'agent-terminal-output', payload });
      const frameData = JSON.stringify({ type: 'ssh-data', payload });
      const targets = [...sockets].filter((socket) =>
        (socket.clientId === clientId || socket.sshClientId === clientId)
        && socket.readyState === socket.OPEN,
      );
      for (const socket of targets) {
        socket.send(frameAgent);
        socket.send(frameData);
      }
      // 背压：目标 WS 缓冲超水位 → 暂停 shell 输出；排空后由 drain 事件恢复。
      // 无目标 socket（WS 全断）时不 pause：输出继续进 outputBuffer，重连后回放。
      if (targets.length === 0) {
        return;
      }
      if (targets.some((socket) => socket.bufferedAmount > WS_HIGH_WATER)) {
        if (!session.paused) {
          session.stream?.pause();
          session.paused = true;
        }
      } else if (session.paused && targets.every((socket) => socket.bufferedAmount <= WS_LOW_WATER)) {
        session.stream?.resume();
        session.paused = false;
      }
    };

    client
      .on('ready', () => {
        client.shell(
          {
            term: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 32,
          },
          (error, stream) => {
            if (error) {
              if (!settled) {
                clearTimeout(hardTimeout);
                reject(error);
              }
              return;
            }

            session.stream = stream;
            session.ready = true;
            // 握手期缓存的 resize（连接未 ready 时前端已发出真实尺寸）：
            // shell 建立后立即应用，避免 PTY 卡在 connect 请求的初始 200x50，
            // top/vim 按错误行列绘制（折行、头部挤出可视区）。
            if (session.pendingResize) {
              const { cols: prCols, rows: prRows } = session.pendingResize;
              session.pendingResize = null;
              try {
                stream.setWindow(prRows, prCols);
              } catch {
                // ignore
              }
            }
            stream
              .on('data', (data) => {
                publishShellOutput(data);
              })
              .on('close', () => {
                // 冲刷解码器尾部残留字节
                const tail = session.outputDecoder.end();
                if (tail) {
                  publishShellOutput(tail);
                }
                emitSessionClose(connection.id, clientId);
              })
              .stderr.on('data', (data) => {
                emitToClient(clientId, 'ssh-error', {
                  connectionId: connection.id,
                  error: data.toString('utf8'),
                });
              });

            emitToClient(clientId, 'ssh-data', {
              connectionId: connection.id,
              data: '',
              type: 'state',
              state: stateFor(connection.id, clientId),
            });
            // 稍等首包 MOTD/提示符进入缓冲，随 connect 响应一并返回
            setTimeout(() => {
              finish(success({
                sessionId: connection.id,
                initialOutput: session.outputBuffer || '',
              }));
            }, 120);
          },
        );
      })
      .on('error', (error) => {
        sessions.delete(sessionKeyOf(connection.id, clientId));
        emitToClient(clientId, 'ssh-error', { connectionId: connection.id, error: error.message });
        if (!settled) {
          clearTimeout(hardTimeout);
          reject(error);
        }
      })
      .on('close', () => {
        emitSessionClose(connection.id, clientId);
      })
      .connect({
        host: connection.host,
        port: connection.port || 22,
        username: connection.username,
        password: connection.password || undefined,
        privateKey: connection.privateKey || undefined,
        passphrase: connection.passphrase || undefined,
        keepaliveInterval: Math.max(0, Number(settings.keepaliveInterval || 0)) * 1000,
        keepaliveCountMax: settings.keepaliveCountMax || 3,
        readyTimeout: 20000,
        // 主机密钥校验（TOFU）：不传则 ssh2 默认自动接受任意主机密钥。
        hostVerifier: hostTrust.createVerifier({
          host: connection.host,
          port: connection.port,
          clientId,
        }),
      });
  });
}

function getSession(connectionId, clientId) {
  const session = sessions.get(sessionKeyOf(connectionId, clientId));
  if (!session?.ready) {
    throw new Error('SSH session is not connected');
  }
  return session;
}

/** 拼接远端展示路径，保持 ~ 前缀语义。/home 是真实目录，不按家目录处理。 */
function joinRemoteDisplayPath(parent, name) {
  const base = String(parent || '').replace(/\/+$/, '') || '/';
  if (base === '~' || base === '.' || base === './') {
    return `~/${name}`;
  }
  if (base === '/') {
    return `/${name}`;
  }
  return posixPath.join(base, name);
}

function getSftp(connectionId, clientId) {
  const session = getSession(connectionId, clientId);
  if (session.sftp) {
    return Promise.resolve(session.sftp);
  }
  if (session.sftpPromise) {
    return session.sftpPromise;
  }

  session.sftpPromise = new Promise((resolve, reject) => {
    session.client.sftp((error, sftp) => {
      session.sftpPromise = null;
      if (error) {
        reject(error);
        return;
      }
      const invalidate = () => {
        if (session.sftp === sftp) {
          session.sftp = null;
        }
      };
      sftp.on?.('close', invalidate);
      sftp.on?.('end', invalidate);
      sftp.on?.('error', invalidate);
      session.sftp = sftp;
      resolve(sftp);
    });
  });
  return session.sftpPromise;
}

function route(handler) {
  return async (request, response) => {
    try {
      response.json(await handler(request, response));
    } catch (error) {
      response.json(failure(error));
    }
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// 初始化密码鉴权：所有 /api 与页面请求都需通过校验。
const auth = createAuth(DATA_DIR);

// 健康检查无需鉴权，供容器探针使用。
app.get('/api/health', (_request, response) => response.json(success({ ok: true })));

// 登录/登出/状态端点，登录页与前端调用它们建立或清除会话。
app.post('/api/login', auth.handleLogin);
app.post('/api/logout', auth.handleLogout);
app.get('/api/auth-status', (request, response) => (
  response.json(success({
    authenticated: auth.isAuthed(request),
    usingDefaultPassword: auth.isUsingDefaultPassword(),
    passwordManaged: auth.isEnvManaged,
  }))
));

// 登录页需按当前语言渲染：把 settings.language 挂到请求上供中间件读取。
app.use((request, _response, next) => {
  try {
    request.__loginLang = readStore().settings.language;
  } catch {
    request.__loginLang = undefined;
  }
  next();
});

// 鉴权网关：放行上述端点，其余一律拦截。
app.use(auth.middleware);

// 修改密码：已通过鉴权后调用，校验旧密码并保持当前会话登录。
app.post('/api/change-password', auth.changePassword);

app.get('/api/export', route((request) => {
  const store = readStore();
  const includeSecrets = request.query.includeSecrets !== 'false';
  const connections = includeSecrets
    ? store.connections
    : store.connections.map((item) => ({
      ...item,
      password: undefined,
      privateKey: undefined,
      passphrase: undefined,
    }));
  const aiProviders = includeSecrets
    ? store.aiProviders
    : store.aiProviders.map((item) => ({
      ...item,
      apiKey: undefined,
    }));

  return success({
    data: {
      version: 'ai-ssh-client-1',
      exportedAt: Date.now(),
      includeSecrets,
      connections,
      aiProviders,
      settings: store.settings,
      commandHistory: store.commandHistory,
      quickCommands: store.quickCommands,
      quickCommandGroups: store.quickCommandGroups,
      hostTrustRecords: store.hostTrustRecords || [],
    },
  });
}));

app.post('/api/import', route((request) => {
  const imported = normalizeImportData(request.body);
  const merge = request.query.merge !== 'false';

  updateStore((store) => {
    store.connections = merge
      ? [
          ...store.connections.filter((item) => (
            !imported.connections.some((next) => next.id === item.id)
          )),
          ...imported.connections,
        ]
      : imported.connections;

    if (imported.settings && Object.keys(imported.settings).length > 0) {
      store.settings = { ...defaultSettings, ...store.settings, ...imported.settings };
    }

    if (imported.commandHistory.length > 0) {
      store.commandHistory = merge
        ? [...imported.commandHistory, ...store.commandHistory].slice(0, 500)
        : imported.commandHistory.slice(0, 500);
    }
    if (imported.quickCommands.length > 0) {
      store.quickCommands = merge
        ? [
            ...store.quickCommands.filter((item) => (
              !imported.quickCommands.some((next) => next.id === item.id)
            )),
            ...imported.quickCommands,
          ]
        : imported.quickCommands;
    }
    if (imported.quickCommandGroups.length > 0) {
      store.quickCommandGroups = merge
        ? [
            ...store.quickCommandGroups.filter((item) => (
              !imported.quickCommandGroups.some((next) => next.id === item.id)
            )),
            ...imported.quickCommandGroups,
          ]
        : imported.quickCommandGroups;
    }
    if (imported.aiProviders.length > 0) {
      store.aiProviders = merge
        ? [
            ...store.aiProviders.filter((item) => (
              !imported.aiProviders.some((next) => next.id === item.id)
            )),
            ...imported.aiProviders,
          ]
        : imported.aiProviders;
    }
    if (imported.hostTrustRecords.length > 0) {
      store.hostTrustRecords = merge
        ? [
            ...(store.hostTrustRecords || []).filter((item) => (
              !imported.hostTrustRecords.some((next) => (
                next.host === item.host && Number(next.port) === Number(item.port)
              ))
            )),
            ...imported.hostTrustRecords,
          ]
        : imported.hostTrustRecords;
    }
  });

  return success({
    imported: {
      connections: imported.connections.length,
      aiProviders: imported.aiProviders.length,
      settings: imported.settings ? 1 : 0,
      quickCommands: imported.quickCommands.length,
      quickCommandGroups: imported.quickCommandGroups.length,
      hostTrustRecords: imported.hostTrustRecords.length,
    },
    skipped: [],
  });
}));

app.get('/api/connections', route(() => success({ connections: readStore().connections })));
app.post('/api/connections', route((request) => {
  updateStore((store) => {
    const next = request.body.connection;
    const index = store.connections.findIndex((item) => item.id === next.id);
    // 更新时保留原位置，避免编辑后跳到列表末尾
    if (index >= 0) {
      store.connections[index] = next;
    } else {
      store.connections.push(next);
    }
  });
  return success();
}));
// 按 id 数组重排连接列表并持久化
app.put('/api/connections/order', route((request) => {
  const connectionIds = Array.isArray(request.body?.connectionIds)
    ? request.body.connectionIds.map(String)
    : [];
  updateStore((store) => {
    const byId = new Map(store.connections.map((item) => [item.id, item]));
    const ordered = [];
    connectionIds.forEach((id) => {
      const item = byId.get(id);
      if (item) {
        ordered.push(item);
        byId.delete(id);
      }
    });
    byId.forEach((item) => ordered.push(item));
    store.connections = ordered;
  });
  return success();
}));
app.delete('/api/connections/:id', route((request) => {
  updateStore((store) => {
    store.connections = store.connections.filter((item) => item.id !== request.params.id);
  });
  closeSessionsForConnection(request.params.id);
  return success();
}));

app.get('/api/settings', route(() => success({ settings: readStore().settings })));
app.post('/api/settings', route((request) => {
  updateStore((store) => {
    store.settings = normalizeSettings(request.body.settings);
  });
  return success();
}));

app.get('/api/command-history', route(() => success({ history: readStore().commandHistory })));
app.post('/api/command-history', route((request) => {
  updateStore((store) => {
    store.commandHistory = [request.body.item, ...store.commandHistory].slice(0, 500);
  });
  return success();
}));
app.delete('/api/command-history', route(() => {
  updateStore((store) => {
    store.commandHistory = [];
  });
  return success();
}));

app.get('/api/quick-commands', route(() => success({ commands: readStore().quickCommands })));
app.post('/api/quick-commands', route((request) => {
  updateStore((store) => {
    const next = request.body.command;
    store.quickCommands = [
      ...store.quickCommands.filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/quick-commands/:id', route((request) => {
  updateStore((store) => {
    store.quickCommands = store.quickCommands.filter((item) => item.id !== request.params.id);
  });
  return success();
}));

app.get('/api/quick-command-groups', route(() => success({ groups: readStore().quickCommandGroups })));
app.post('/api/quick-command-groups', route((request) => {
  updateStore((store) => {
    const next = request.body.group;
    store.quickCommandGroups = [
      ...store.quickCommandGroups.filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/quick-command-groups/:id', route((request) => {
  updateStore((store) => {
    store.quickCommandGroups = store.quickCommandGroups.filter((item) => item.id !== request.params.id);
  });
  return success();
}));

// 主机指纹信任记录：与桌面端 ssh_*_host_trust_record 六个命令一一对应。
// 必须注册在 /api/ssh/:id/* 之前，避免 "host-trust" 被当成连接 ID 匹配。
app.get('/api/ssh/host-trust', route(() => success({ records: hostTrust.listRecords() })));
app.get('/api/ssh/host-trust/record', route((request) => success({
  record: hostTrust.getRecord(String(request.query.host || ''), Number(request.query.port)),
})));
app.post('/api/ssh/host-trust', route((request) => {
  hostTrust.upsertRecord(request.body?.record || request.body || {});
  return success();
}));
app.delete('/api/ssh/host-trust', route((request) => {
  hostTrust.deleteRecord(String(request.query.host || ''), Number(request.query.port));
  return success();
}));
app.post('/api/ssh/host-trust/clear', route(() => {
  hostTrust.clearRecords();
  return success();
}));
// 前端确认主机指纹；accepted=false 会让对应握手立即以失败结束。
app.post('/api/ssh/host-trust/respond', route((request) => success({
  handled: hostTrust.respond(request.body?.requestId, request.body?.accepted === true),
})));
app.post('/api/ssh/connect', route((request) => (
  connectSsh(
    request.body.connection,
    request.body.cols,
    request.body.rows,
    request.body.settings,
    requestClientId(request),
  )
)));
app.post('/api/ssh/:id/disconnect', route((request) => {
  closeSession(request.params.id, requestClientId(request));
  return success();
}));
// 浏览器 pagehide 时 sendBeacon 调用：自定义 header 带不了，clientId 走 query。
// 关闭标签页时主动缩短清理宽限期；F5 刷新重挂可在快清前重连取消，不丢现场。
app.post('/api/ssh/cleanup', route((request) => {
  const clientId = String(request.query.clientId || request.body?.clientId || '');
  if (clientId) {
    scheduleSessionCleanup(clientId, SESSION_CLEANUP_FAST_MS);
  }
  return success();
}));
app.post('/api/ssh/:id/write', route((request) => {
  getSession(request.params.id, requestClientId(request)).stream.write(request.body.command || '');
  return success();
}));
// 探测交互 shell 的真实 PWD（与 SFTP 家目录无关），供终端右键打开传输
app.post('/api/ssh/:id/pwd', route(async (request) => {
  const session = getSession(request.params.id, requestClientId(request));
  const cwd = await probeInteractivePwd(session, {
    timeoutMs: Number(request.body?.timeoutMs) || 2500,
  });
  return success({ cwd });
}));
app.post('/api/ssh/:id/resize', route((request) => {
  const { cols, rows } = request.body;
  applySessionResize(
    sessions.get(sessionKeyOf(request.params.id, requestClientId(request))),
    cols,
    rows,
  );
  return success();
}));
// 拉取会话输出缓冲：页面刷新重挂 live session 时补齐提示符
app.get('/api/ssh/:id/output-buffer', route((request) => {
  const session = sessions.get(sessionKeyOf(request.params.id, requestClientId(request)));
  if (!session?.ready) {
    throw new Error('SSH session is not connected');
  }
  return success({
    connectionId: request.params.id,
    data: session.outputBuffer || '',
  });
}));
app.get('/api/ssh/sessions', route((request) => success({
  // 只返回当前客户端的会话：多客户端部署下互不可见、互不干扰
  sessions: Array.from(sessions.values())
    .filter((session) => session.clientId === requestClientId(request))
    .map((session) => stateFor(session.connectionId, session.clientId)),
})));
app.post('/api/ssh/test', route((request) => new Promise((resolve) => {
  const client = new Client();
  client
    .on('ready', () => {
      client.end();
      resolve(success());
    })
    .on('error', (error) => resolve(failure(error)))
    .connect({
      host: request.body.connection.host,
      port: request.body.connection.port || 22,
      username: request.body.connection.username,
      password: request.body.connection.password || undefined,
      privateKey: request.body.connection.privateKey || undefined,
      passphrase: request.body.connection.passphrase || undefined,
      readyTimeout: 20000,
      // 与正式连接同等严格：测试连接也校验主机密钥（桌面端 ssh_test_connection 同样会弹确认）。
      hostVerifier: hostTrust.createVerifier({
        host: request.body.connection.host,
        port: request.body.connection.port,
        clientId: requestClientId(request),
      }),
    });
})));

app.get('/api/sftp/:id/list', route(async (request) => {
  const requestedPath = String(request.query.path || '~');
  const protocolPath = sftpProtocolPath(requestedPath);
  const sftp = await getSftp(request.params.id, requireClientId(request));

  // realpath 把 ~ / . / ~/foo 解析成绝对路径；/home 保持为真实目录，不映射成家目录
  const resolvedPath = await new Promise((resolve) => {
    if (typeof sftp.realpath !== 'function') {
      resolve(requestedPath);
      return;
    }
    sftp.realpath(protocolPath, (error, absolute) => {
      if (!error && absolute) {
        resolve(String(absolute));
        return;
      }
      resolve(requestedPath);
    });
  });

  return new Promise((resolve, reject) => {
    sftp.readdir(protocolPath, (error, list) => {
      if (error) {
        reject(error);
        return;
      }

      const displayPath = resolvedPath;
      const files = list.map((item) => ({
        name: item.filename,
        path: joinRemoteDisplayPath(displayPath, item.filename),
        size: item.attrs.size,
        isDirectory: typeof item.attrs.isDirectory === 'function'
          ? item.attrs.isDirectory()
          : Boolean(item.attrs.isDirectory),
        isSymbolicLink: typeof item.attrs.isSymbolicLink === 'function'
          ? item.attrs.isSymbolicLink()
          : Boolean(item.attrs.isSymbolicLink),
        mode: String(item.attrs.mode),
        mtime: item.attrs.mtime * 1000,
        atime: item.attrs.atime * 1000,
        fileType: (typeof item.attrs.isDirectory === 'function'
          ? item.attrs.isDirectory()
          : Boolean(item.attrs.isDirectory)) ? 'directory' : 'file',
      })).sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

      // path 为规范化后的当前目录，供前端地址栏与 store 同步
      resolve(success({ files, path: displayPath }));
    });
  });
}));

app.post('/api/sftp/:id/rename', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  await renameSftpItem(sftp, request.body.remotePath, request.body.newName);
  return success();
}));

app.delete('/api/sftp/:id/item', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  await deleteSftpItem(sftp, request.body.remotePath);
  return success();
}));

// 创建单层远程目录
app.post('/api/sftp/:id/directory', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  await createSftpDirectory(sftp, request.body.remotePath);
  return success();
}));

// 修改远端权限（chmod）
app.post('/api/sftp/:id/permissions', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  const remotePath = String(request.body?.remotePath || '');
  const mode = request.body?.mode;
  return success(await setSftpPermissions(sftp, remotePath, mode));
}));

// 读取远端文本（在线编辑，有大小上限）
app.get('/api/sftp/:id/text', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  const remotePath = String(request.query.path || '');
  return success(await readSftpTextFile(sftp, remotePath));
}));

// 覆盖写入远端文本
app.put('/api/sftp/:id/text', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  const remotePath = String(request.body?.remotePath || '');
  const content = String(request.body?.content ?? '');
  await writeSftpTextFile(sftp, remotePath, content);
  return success();
}));

// 批量删除文件/目录，返回逐项结果
app.delete('/api/sftp/:id/items', route(async (request) => {
  const sftp = await getSftp(request.params.id, requireClientId(request));
  return success(await deleteSftpItems(sftp, request.body.remotePaths || []));
}));

app.get('/api/sftp/:id/download', async (request, response) => {
  try {
    const remotePath = sftpProtocolPath(String(request.query.path || ''));
    const filename = posixPath.basename(String(request.query.path || remotePath));
    const sftp = await getSftp(request.params.id, resolveClientId(request));
    // 尽量带上 content-length，并支持 Range 续传下载。
    let size = 0;
    try {
      const stats = await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (error, attrs) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(attrs);
        });
      });
      size = Number(stats.size || 0);
    } catch {
      size = 0;
    }

    let start = 0;
    let end = size > 0 ? size - 1 : undefined;
    const rangeHeader = String(request.headers.range || '');
    const rangeMatch = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader);
    if (rangeMatch && size > 0) {
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] != null ? Number(rangeMatch[2]) : size - 1;
      if (Number.isNaN(start) || start < 0 || start >= size) {
        response.status(416).setHeader('Content-Range', `bytes */${size}`).end();
        return;
      }
      end = Math.min(end, size - 1);
      response.status(206);
      response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      response.setHeader('Content-Length', String(end - start + 1));
    } else if (size > 0) {
      response.setHeader('Content-Length', String(size));
    }

    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Accept-Ranges', 'bytes');

    const streamOptions = start > 0 || (end != null && size > 0 && end < size - 1)
      ? { start, end }
      : undefined;
    const readStream = sftp.createReadStream(remotePath, streamOptions);
    // 客户端断开时销毁 SFTP 读流，避免空转占用会话。
    request.on('close', () => {
      if (!response.writableEnded) {
        readStream.destroy();
      }
    });
    readStream.on('error', (error) => {
      if (!response.headersSent) {
        response.status(500).json(failure(error));
        return;
      }
      response.destroy(error);
    });
    readStream.pipe(response);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json(failure(error));
    }
  }
});

function requireClientId(request) {
  const clientId = request.get('x-sftp-client-id');
  if (!clientId || clientId.length > 200) {
    throw new Error('Missing SFTP client identity');
  }
  return clientId;
}

/**
 * 下载接口的客户端标识解析：请求头优先，其次 URL 上的 clientId。
 *
 * handed-off 下载是浏览器下载管理器发起的顶层导航（<a download>），无法自定义请求头，
 * 只能把 clientId 拼在 query 上（见 sftp-transfer.cjs 的 startDownload）。
 * 该标识仅用于定位本客户端在服务端的 SFTP 会话，鉴权依旧依赖会话 Cookie，
 * 因此在 URL 上传递不会带来额外权限（能改 URL 的调用方本来也能自定义请求头）。
 */
function resolveClientId(request) {
  const header = request.get('x-sftp-client-id') || request.get('x-ssh-client-id');
  if (header && header.length <= 200) {
    return header;
  }
  const fromQuery = String(request.query?.clientId || '');
  if (fromQuery && fromQuery.length <= 200) {
    return fromQuery;
  }
  throw new Error('Missing SFTP client identity');
}

app.post('/api/sftp/transfers/upload', route((request) => {
  const clientId = requireClientId(request);
  return success(sftpTransfers.startUpload(clientId, request.body));
}));

app.post('/api/sftp/transfers/download', route((request) => {
  const clientId = requireClientId(request);
  return success(sftpTransfers.startDownload(clientId, request.body, '/api/sftp'));
}));

app.get('/api/sftp/transfers', route((request) => {
  const clientId = requireClientId(request);
  return success(sftpTransfers.list(clientId, request.query.connectionId));
}));

app.post('/api/sftp/transfers/:taskId/conflict', route((request) => {
  const clientId = requireClientId(request);
  sftpTransfers.resolveConflict(clientId, { ...request.body, taskId: request.params.taskId });
  return success();
}));

app.post('/api/sftp/transfers/:taskId/cancel', route((request) => {
  const clientId = requireClientId(request);
  sftpTransfers.cancel(clientId, { taskId: request.params.taskId });
  return success();
}));

app.post('/api/sftp/transfers/:taskId/retry', route(async (request) => {
  const clientId = requireClientId(request);
  return success(await sftpTransfers.retry(clientId, { taskId: request.params.taskId }));
}));

app.delete('/api/sftp/transfers/:taskId', route(async (request) => {
  const clientId = requireClientId(request);
  await sftpTransfers.discard(clientId, { taskId: request.params.taskId });
  return success();
}));

app.put('/api/sftp/transfers/:taskId/content', async (request, response) => {
  try {
    const clientId = requireClientId(request);
    // 单次分片也可能较久：关闭 socket 空闲超时，避免传输中被掐断
    request.setTimeout?.(0);
    response.setTimeout?.(0);
    const snapshot = await sftpTransfers.upload(clientId, request.params.taskId, request);
    response.json(success({ task: snapshot }));
  } catch (error) {
    const status = error?.code === 'not-found'
      ? 404
      : error?.code === 'conflict'
        ? 409
        : 400;
    response.status(status).json(failure(error));
  }
});

app.get('/api/ai/providers', route(() => success({
  providers: readStore().aiProviders.map(providerToSummary),
})));
app.post('/api/ai/providers', route((request) => {
  updateStore((store) => {
    const next = request.body.provider;
    const existing = store.aiProviders.find((item) => item.id === next.id);
    const saved = {
      ...existing,
      ...next,
      apiKey: next.apiKey || existing?.apiKey,
    };
    store.aiProviders = [
      ...store.aiProviders
        .map((item) => (saved.isActive ? { ...item, isActive: false } : item))
        .filter((item) => item.id !== saved.id),
      saved,
    ];
  });
  return success();
}));
app.post('/api/ai/providers/:id/active', route((request) => {
  updateStore((store) => {
    store.aiProviders = store.aiProviders.map((provider) => ({
      ...provider,
      isActive: provider.id === request.params.id,
    }));
  });
  return success();
}));
app.delete('/api/ai/providers/:id', route((request) => {
  updateStore((store) => {
    store.aiProviders = store.aiProviders.filter((item) => item.id !== request.params.id);
  });
  return success();
}));
app.get('/api/ai/providers/:id/secret-status', route((request) => {
  const provider = readStore().aiProviders.find((item) => item.id === request.params.id);
  const apiKey = provider?.apiKey?.trim() || '';

  return success({
    providerId: request.params.id,
    hasApiKey: apiKey.length > 0,
    maskedApiKey: maskSecret(apiKey),
  });
}));
app.post('/api/ai/chat/stream', async (request, response) => {
  const { providerId, messages, options } = request.body;
  const requestId = options?.requestId;
  if (!requestId) {
    response.status(400).send('Missing AI request ID');
    return;
  }
  response.status(200);
  response.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  let closed = false;
  response.on('close', () => {
    if (response.writableEnded) return;
    closed = true;
    activeAiRequests.get(requestId)?.abort();
  });
  const sendEvent = (event) => {
    if (!closed && !response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await streamChatWithProvider(getProvider(providerId), messages || [], requestId, sendEvent);
  } catch (error) {
    sendEvent({
      type: 'error',
      requestId: requestId || '',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!closed && !response.writableEnded) response.end();
});
app.post('/api/ai/chat', route(async (request) => {
  const { providerId, messages, options } = request.body;
  const provider = getProvider(providerId);

  return success(await chatWithProvider(provider, messages || [], options?.requestId));
}));
app.post('/api/ai/test', route(async (request) => {
  const provider = request.body.provider;
  return success(await chatWithProvider(
    provider,
    [{
      role: 'user',
      content: '你好，请回复“连接成功”',
    }],
    `test-${Date.now()}`,
  ));
}));
app.post('/api/ai/cancel/:id', route((request) => {
  activeAiRequests.get(request.params.id)?.abort();
  activeAiRequests.delete(request.params.id);
  return success();
}));

app.post('/api/agent/:id/start', route(() => success()));
app.post('/api/agent/:id/stop', route((request) => success({
  canceled: cancelAgentExec(request.params.id, requestClientId(request)),
})));
app.post('/api/agent/:id/exec-await', route((request) => (
  runSshCommand(
    request.params.id,
    request.body.command || '',
    request.body.options,
    requestClientId(request),
  )
)));
app.post('/api/agent/:id/cancel-exec', route((request) => success({
  canceled: cancelAgentExec(request.params.id, requestClientId(request)),
})));
// 暂停：中止该客户端全部在途远端执行（前端本地暂停由 agent store 驱动）。
// 对应桌面端 agent_pause_task → cancel_all_execs()，避免"界面已暂停、远端命令仍在跑"。
app.post('/api/agent/pause', route((request) => success({
  canceled: cancelAgentExecsForClient(requestClientId(request)),
})));
app.get('/api/agent/tasks', route(() => success({ tasks: readStore().agentTasks })));
app.post('/api/agent/tasks', route((request) => {
  updateStore((store) => {
    const task = request.body.task;
    store.agentTasks = [
      task,
      ...store.agentTasks.filter((item) => item.id !== task.id),
    ].slice(0, 50);
  });
  return success();
}));
app.delete('/api/agent/tasks', route(() => {
  updateStore((store) => {
    store.agentTasks = [];
  });
  return success();
}));
app.delete('/api/agent/tasks/:id', route((request) => {
  updateStore((store) => {
    store.agentTasks = store.agentTasks.filter((item) => item.id !== request.params.id);
  });
  return success();
}));

/**
 * 静态资源缓存策略：
 * - index.html 每次重新获取（no-store）：保证部署后浏览器立即拿到最新入口，
 *   从而引用最新 hash 的构建产物，无需手动强刷；
 * - /assets/ 下带 hash 的构建产物永久缓存（immutable）：内容变化文件名必变，
 *   旧条目永不命中，避免重复下载；
 * - 其余资源（favicon 等非 hash 文件）协商缓存。
 */
app.use(express.static(STATIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(response, filePath) {
    if (filePath.endsWith('.html')) {
      response.setHeader('Cache-Control', 'no-store');
    } else if (filePath.split(path.sep).includes('assets')) {
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      response.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use((request, response) => {
  // 未匹配的 /api/* 必须返回 JSON 404：否则会落到下面的 SPA 兜底，
  // 把 index.html 以 200 返回，前端 response.json() 抛 "Unexpected token '<'"，
  // 拼错路径或调用已移除的端点时极难定位。
  if (request.path.startsWith('/api/')) {
    response.status(404).json({
      success: false,
      error: `Unknown API endpoint: ${request.method} ${request.path}`,
      code: 'NOT_FOUND',
    });
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(STATIC_DIR, 'index.html'));
});

const server = TLS_OPTIONS
  ? https.createServer(TLS_OPTIONS, app)
  : http.createServer(app);
// Node 默认 requestTimeout=300s：大文件经 SFTP 慢速落盘时，整包 PUT 会在 ~5 分钟被断开（3GB≈16%）。
// 0 表示禁用；可用 WEB_REQUEST_TIMEOUT_MS 覆盖（毫秒）。
const requestTimeoutMs = Number(process.env.WEB_REQUEST_TIMEOUT_MS ?? 0);
server.requestTimeout = Number.isFinite(requestTimeoutMs) ? Math.max(0, requestTimeoutMs) : 0;
server.headersTimeout = server.requestTimeout === 0
  ? 0
  : Math.max(server.requestTimeout + 60_000, 60_000);
server.timeout = 0;
// 手动处理升级，先校验会话 Cookie 再放行 WebSocket，防止未鉴权连接。
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname !== '/api/events') {
    socket.destroy();
    return;
  }
  if (!auth.verifyUpgrade(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'sftp-identify') {
        if (typeof message.clientId !== 'string' || !message.clientId || message.clientId.length > 200) {
          throw new Error('Invalid SFTP client identity');
        }
        socket.clientId = message.clientId;
        // 独立的 SSH 客户端标识：每浏览器标签页一个，用于会话隔离
        if (typeof message.sshClientId === 'string' && message.sshClientId && message.sshClientId.length <= 200) {
          socket.sshClientId = message.sshClientId;
        } else {
          socket.sshClientId = message.clientId;
        }
        // 同 clientId 重连（网络瞬断自动恢复）：取消上一轮 WS 断开触发的延迟清理
        cancelSessionCleanup(socket.sshClientId);
      } else if (message.type === 'ssh-resize') {
        // 终端 resize 有序通道：与 ssh-write 同走 WS，替代乱序的 HTTP POST。
        // 首次 fit 会连发多次尺寸（RAF/50ms/200ms/ResizeObserver），HTTP 无顺序保证，
        // 旧尺寸后到会覆盖新尺寸且不再有后续 SIGWINCH → vim 按错误行列绘制，底部缺行。
        const cols = Math.max(2, Math.min(1000, Number(message.cols) || 0));
        const rows = Math.max(2, Math.min(1000, Number(message.rows) || 0));
        if (cols && rows) {
          applySessionResize(
            sessions.get(sessionKeyOf(
              message.connectionId,
              socket.sshClientId || socket.clientId || '',
            )),
            cols,
            rows,
          );
        }
      } else if (message.type === 'ssh-write') {
        // 终端输入热路径：与 HTTP /write 等价，但经 WS 保序低延迟
        const data = typeof message.data === 'string' ? message.data : '';
        if (data) {
          const session = sessions.get(sessionKeyOf(
            message.connectionId,
            socket.sshClientId || socket.clientId || '',
          ));
          if (!session) {
            // 会话完全不存在（网络/超时/服务端重启后已清理）：立即通知前端
            // 关闭并自动重连，避免 UI 停留在"已连接"但输入全部静默失败（假死）。
            socket.send(JSON.stringify({ type: 'ssh-close', payload: message.connectionId }));
          } else if (session.ready) {
            // 仅就绪后写入；连接握手期间的输入静默丢弃，绝不误发 ssh-close，
            // 否则会把"正在建立连接"误判为"会话已死"，触发重连风暴。
            session.stream.write(data);
          }
        }
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', payload: failure(error) }));
    }
  });
  socket.on('drain', () => {
    // 发送缓冲排空：恢复被背压暂停的 shell 输出流（该 client 的全部会话）
    resumeStreamsForClient(socket.sshClientId || socket.clientId);
  });
  socket.on('close', () => {
    sockets.delete(socket);
    // WS 断开 ≠ 用户意图断开：宽限期内同 clientId 重连可取消清理，
    // 真关闭标签/崩溃/断网后 20s 内释放 SSH 会话，避免幽灵 vim 占文件、连接泄漏。
    scheduleSessionCleanup(socket.sshClientId || socket.clientId || '');
  });
});

server.listen(PORT, HOST, () => {
  const scheme = TLS_OPTIONS ? 'https' : 'http';
  console.info(`AI SSH Client web server listening on ${scheme}://${HOST}:${PORT}`);
  if (!TLS_OPTIONS && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    // 明确提示：非 HTTPS 访问时浏览器会拦截部分下载，避免误判为 SFTP 功能故障。
    console.warn(
      'Plain HTTP mode: browsers (Chrome) block "insecure downloads" (.pcap/.zip/...). '
      + 'Set WEB_TLS=1 for a self-signed HTTPS listener, or WEB_TLS_CERT/WEB_TLS_KEY for a real certificate.',
    );
  }
  // 提示登录方式；仍为默认密码时建议尽快修改。
  if (auth.isEnvManaged) {
    console.info('Web login: password provided via WEB_AUTH_PASSWORD.');
  } else if (auth.isUsingDefaultPassword()) {
    console.info('Web login: using default password "admin". Please change it in Settings after signing in.');
  } else {
    console.info('Web login: password authentication enabled.');
  }
});
