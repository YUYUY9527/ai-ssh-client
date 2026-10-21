#!/usr/bin/env node
/**
 * AI SSH Client — MCP 服务（stdio）。
 *
 * 给 Claude Code / Cursor / DSH 等 MCP 客户端使用：把已保存的 SSH 连接
 * 暴露成只读的列目录/读文件工具，并在显式开启后提供非交互命令执行。
 *
 * 需要「服务端单一事实来源」时改用 Web 网关的 Streamable HTTP 端点（见 http.mjs
 * 与 docs/mcp.md），本文件只保留本地 stdio 通道，两者共用 server.mjs 的工具定义。
 *
 * 注意：stdout 是 JSON-RPC 通道，任何日志都必须走 stderr。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';

import { createAiSshMcpServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { createServices } = require('./services.cjs');

let services;
try {
  services = createServices();
} catch (error) {
  console.error(`[mcp] 初始化失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = createAiSshMcpServer(services);
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  console.error(`[mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  services.close();
  process.exit(1);
}

console.error(
  `[mcp] ai-ssh-client MCP 已启动（stdio，data=${services.dataDir}，`
  + `exec=${services.policy.execAllowed ? 'enabled' : 'disabled'}，`
  + `audit=${services.audit.enabled ? services.audit.file : 'disabled'}）`,
);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await server.close();
  } catch {
    // 关闭失败不影响退出；SSH 连接仍会在这里显式释放。
  }
  services.close();
  process.exit(code);
}

server.server.onclose = () => {
  shutdown(0);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));