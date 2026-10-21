/**
 * MCP 的 Streamable HTTP 端点（挂到 Web 网关的 `/mcp`）。
 *
 * 设计取舍：
 * - **stateless**：不维护 session id。工具都是「一问一答」，没有服务端主动推送，
 *   省掉会话清理与过期问题；客户端（DSH / Claude Code 等）每次请求独立。
 * - **服务端单一事实来源**：连接与策略都从网关自己的 data 目录读，
 *   客户端配置里不再需要 AI_SSH_DATA_DIR 之类的本地路径。
 * - **策略热生效**：每次请求前 stat 策略文件的 mtime/size，变化就重建 services。
 *   新建失败（例如 JSON 写坏）时保留旧实例，保证端点不至于整体不可用。
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

  let services = null;
  let stamp = null;

  function dispose(instance) {
    try {
      instance?.close?.();
    } catch (error) {
      logger.warn?.(`[mcp-http] 关闭旧 services 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 按策略文件指纹懒加载 / 重建 services。 */
  function ensureServices() {
    const nextStamp = policyStamp(policyPath);
    if (services && nextStamp === stamp) {
      return services;
    }
    // 先建新实例再替换：策略文件写坏时抛错，旧的继续服务。
    const next = createServices({ env: servicesEnv });
    const previous = services;
    services = next;
    stamp = nextStamp;
    if (previous) {
      dispose(previous);
    }
    return next;
  }

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
      active = ensureServices();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`[mcp-http] 初始化失败（策略文件 ${policyPath}）：${message}`);
      sendJsonRpcError(response, 500, `MCP 初始化失败：${message}`);
      return;
    }

    const server = createAiSshMcpServer(active);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      // 响应已结束：transport 与 server 都是一次性的，必须释放，否则监听器会累积。
      Promise.resolve(transport.close())
        .catch(() => {})
        .finally(() => {
          Promise.resolve(server.close()).catch(() => {});
        });
    };
    response.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`[mcp-http] 请求处理失败：${message}`);
      sendJsonRpcError(response, 500, `MCP 请求处理失败：${message}`);
    }
  }

  /** 关闭当前 services（进程退出时调用，释放 SSH 连接池）。 */
  function close() {
    const current = services;
    services = null;
    stamp = null;
    dispose(current);
  }

  return {
    handle,
    close,
    /** 供测试/诊断：当前生效的策略文件路径。 */
    policyPath,
  };
}