'use strict';

/**
 * 极简 ACP（Agent Client Protocol 风格）客户端：起本机 CLI 子进程，走换行分隔 JSON-RPC。
 *
 * 安全边界（必须遵守）：
 * - 环境变量白名单：不把 SSH_AUTH_SOCK / 各类 token 传给外部 agent。
 * - 外部 agent 的任何「总是允许 / 绕过」请求都不作数；每次工具请求都要经过我们传入的 gate 决策。
 * - 默认不启用；由调用方显式创建。
 */

const { spawn } = require('node:child_process');

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
];

const DEFAULT_TIMEOUT_MS = 30000;

function buildSafeEnv(baseEnv = process.env) {
  const result = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof baseEnv[key] === 'string') result[key] = baseEnv[key];
  }
  return result;
}

/**
 * @param {object} options
 * @param {string} options.command 可执行文件
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {(request:{tool:string,args:unknown,raw:unknown})=>Promise<{allow:boolean,reason?:string}>|{allow:boolean,reason?:string}} [options.gate]
 */
function createAcpClient({ command, args = [], cwd, gate, timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  if (!command) throw new Error('ACP command is required');

  const child = spawn(command, args, {
    cwd,
    env: buildSafeEnv(env || process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notificationHandlers = new Set();

  function settle(id, payload) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (payload.error) entry.reject(new Error(payload.error.message || 'ACP error'));
    else entry.resolve(payload.result);
  }

  function handleMessage(message) {
    if (message && typeof message.id !== 'undefined' && (message.result !== undefined || message.error !== undefined)) {
      settle(message.id, message);
      return;
    }
    if (message && message.method) {
      for (const handler of notificationHandlers) handler(message);
      if (message.id !== undefined) handleServerRequest(message);
    }
  }

  async function handleServerRequest(message) {
    try {
      if (message.method === 'session/request_permission') {
        const toolRequest = message.params?.toolCall || message.params || {};
        const decision = gate
          ? await gate({ tool: toolRequest.name || toolRequest.kind || 'unknown', args: toolRequest.arguments ?? toolRequest.input ?? null, raw: message.params })
          : { allow: false, reason: 'no gate configured' };
        if (decision && decision.allow) {
          send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
        } else {
          send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        }
        return;
      }
      // 其它服务端请求一律拒绝，避免外部 agent 越权。
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // 忽略非 JSON 输出（日志等）
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  child.on('exit', () => {
    closed = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('ACP process exited'));
      pending.delete(id);
    }
  });

  function send(payload) {
    if (closed) throw new Error('ACP process is closed');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  return {
    request,
    notify,
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    initialize(params = { protocolVersion: 1 }) {
      return request('initialize', params);
    },
    newSession(params) {
      return request('session/new', params);
    },
    prompt(params) {
      return request('session/prompt', params);
    },
    cancel(sessionId) {
      notify('session/cancel', { sessionId });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* 忽略 */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }, 200).unref?.();
    },
    get closed() {
      return closed;
    },
    child,
  };
}

module.exports = { createAcpClient, buildSafeEnv, ENV_ALLOWLIST };
