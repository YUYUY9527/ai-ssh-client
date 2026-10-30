/**
 * MCP 的 Streamable HTTP 端点（挂到 Web 网关的 `/mcp`）。
 *
 * 设计取舍：
 * - **stateless**：不维护 session id。工具都是「一问一答」，没有服务端主动推送，
 *   省掉会话清理与过期问题；客户端（DSH / Claude Code 等）每次请求独立。
 * - **服务端单一事实来源**：连接与策略都从网关自己的 data 目录读，
 *   客户端配置里不再需要 AI_SSH_DATA_DIR 之类的本地路径。
 * - **策略热生效**：每次请求前 stat 策略文件的 mtime/size，变化就重建 services。
 *   被替换的旧 services 不立即销毁，而是等它在途请求归零后再释放（引用计数），
 *   避免策略保存的瞬间打断正在执行的命令；新建失败（例如 JSON 写坏）时保留旧
 *   实例，保证端点不至于整体不可用。
 * - **连接配置热生效**：连接配置在每次 connect 时重新读取（见 ssh.cjs 的配置指纹），
 *   所以只改 host/port/凭据不会触发 services 重建，也让新请求自动用上最新配置。
 *
 * 鉴权不在这里做：调用方必须传入 authorize(request)，由网关复用 Web 登录密码实现。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createAiSshMcpServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { createServices } = require('./services.cjs');
const { resolvePolicyPath } = require('./policy-file.cjs');

/** 策略文件指纹：大小 + mtime；文件不存在时也要和「后来才创建」区分开。 */
function policyStamp(policyPath) {
  try {
    const stat = fs.statSync(policyPath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing';
    }
    return `error:${error?.code || 'unknown'}`;
  }
}

function sendJsonRpcError(response, status, message, { retryAfter } = {}) {
  if (response.headersSent || response.writableEnded) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (retryAfter) {
    response.setHeader('retry-after', String(retryAfter));
  }
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  }));
}

/**
 * services 实例的生命周期管理：策略变化时换新实例，但不立刻销毁旧实例。
 * 旧实例可能仍被在途请求使用（请求一开始就抓住了它），必须等引用计数归零
 * （最后一个请求结束）后再 dispose；新请求总是拿最新实例。
 */
export function createServicesHolder({
  createServices: createInstance = createServices,
  policyPath,
  logger = console,
} = {}) {
  if (typeof createInstance !== 'function') {
    throw new Error('createServicesHolder 需要 createServices 工厂');
  }

  let current = null;
  const instances = new Set();

  function dispose(handle) {
    if (!handle || handle.disposed) {
      return;
    }
    handle.disposed = true;
    instances.delete(handle);
    try {
      handle.services?.close?.();
    } catch (error) {
      logger.warn?.(`[mcp-http] 关闭 services 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function retire(handle) {
    handle.retired = true;
    if (handle.active === 0) {
      dispose(handle);
    }
  }

  /** 取当前实例并登记一个在途请求；策略文件指纹变化时先换新实例。 */
  function acquire() {
    const nextStamp = policyStamp(policyPath);
    if (!current || nextStamp !== current.stamp) {
      // 先建新实例再替换：策略文件写坏时抛错，旧的继续服务（不误杀在途请求）。
      const next = createInstance();
      const previous = current;
      current = {
        services: next,
        stamp: nextStamp,
        active: 0,
        retired: false,
        disposed: false,
      };
      instances.add(current);
      if (previous) {
        retire(previous);
      }
    }
    current.active += 1;
    return current;
  }

  /** 请求结束：引用计数减一；被替换的实例在归零时销毁。 */
  function release(handle) {
    if (!handle || handle.disposed || handle.active <= 0) {
      return;
    }
    handle.active -= 1;
    if (handle.retired && handle.active === 0) {
      dispose(handle);
    }
  }

  /** 进程退出：销毁所有仍存在的实例（含因在途请求尚未归零的旧实例）。 */
  function close() {
    current = null;
    for (const handle of [...instances]) {
      dispose(handle);
    }
  }

  return { acquire, release, close };
}

/**
 * 创建 `/mcp` 请求处理器。
 *
 * @param {object} options
 * @param {string} options.dataDir 网关的数据目录（与 Web 设置页同一个）
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(request: import('node:http').IncomingMessage) => {ok: boolean, status?: number, message?: string}} options.authorize
 * @param {Console} [options.logger]
 */
export function createMcpHttpHandler({
  dataDir,
  env = process.env,
  authorize,
  logger = console,
} = {}) {
  if (typeof authorize !== 'function') {
    throw new Error('createMcpHttpHandler 需要 authorize(request) 回调');
  }

  const policyPath = resolvePolicyPath({ dataDir, env });
  // 显式钉住数据目录：网关进程可能只设了 DATA_DIR，而 MCP 侧优先读 AI_SSH_DATA_DIR。
  const servicesEnv = { ...env, AI_SSH_DATA_DIR: dataDir };

  const holder = createServicesHolder({
    createServices: () => createServices({ env: servicesEnv }),
    policyPath,
    logger,
  });

  async function handle(request, response) {
    const verdict = authorize(request);
    if (!verdict?.ok) {
      sendJsonRpcError(
        response,
        verdict?.status || 401,
        verdict?.message || 'Unauthorized',
        { retryAfter: verdict?.status === 429 ? 60 : undefined },
      );
      return;
    }

    if (request.method !== 'POST') {
      if (!response.headersSent) {
        response.setHeader('allow', 'POST');
      }
      sendJsonRpcError(response, 405, 'Method Not Allowed: /mcp 只接受 POST');
      return;
    }

    let active;
    try {
      active = holder.acquire();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`[mcp-http] 初始化失败（策略文件 ${policyPath}）：${message}`);
      sendJsonRpcError(response, 500, `MCP 初始化失败：${message}`);
      return;
    }

    let server;
    let transport;
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      // 响应已结束：transport 与 server 都是一次性的，必须释放，否则监听器会累积。
      Promise.resolve(transport?.close?.())
        .catch(() => {})
        .finally(() => {
          Promise.resolve(server?.close?.()).catch(() => {});
        });
      // 请求结束才归还 services 引用：被策略变更替换掉的旧实例要等最后一个
      // 在途请求归零后才会真正关闭，避免中途杀掉正在用的连接池。
      holder.release(active);
    };

    try {
      server = createAiSshMcpServer(active.services);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on('close', cleanup);
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`[mcp-http] 请求处理失败：${message}`);
      sendJsonRpcError(response, 500, `MCP 请求处理失败：${message}`);
    }
  }

  /** 关闭所有 services（进程退出时调用，释放 SSH 连接池）。 */
  function close() {
    holder.close();
  }

  return {
    handle,
    close,
    /** 供测试/诊断：当前生效的策略文件路径。 */
    policyPath,
  };
}