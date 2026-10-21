#!/usr/bin/env node
/**
 * AI SSH Client — MCP 服务（stdio）。
 *
 * 给 Claude Code / Cursor / DSH 等 MCP 客户端使用：把已保存的 SSH 连接
 * 暴露成只读的列目录/读文件工具，并在显式开启后提供非交互命令执行。
 *
 * 注意：stdout 是 JSON-RPC 通道，任何日志都必须走 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { createServices } = require('./services.cjs');
const packageJson = require('../../package.json');

let services;
try {
  services = createServices();
} catch (error) {
  console.error(`[mcp] 初始化失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const server = new McpServer({
  name: 'ai-ssh-client',
  version: packageJson.version,
});

/** 成功结果统一带上 ok:true，失败结果带 ok:false 与错误码，便于 agent 判断。 */
function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function fail(error) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error?.code || 'mcp-error',
        },
      }),
    }],
  };
}

async function run(action) {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}

const connectionIdSchema = z.string().min(1).describe(
  '已保存连接的 id（也可用唯一名称）。先用 list_connections 查询，不要猜。',
);

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

server.registerTool('list_connections', {
  title: '列出已保存的 SSH 连接',
  description:
    '列出 AI SSH Client 里已保存的连接：id、名称、主机、端口、用户名、认证方式、主机指纹是否已信任。'
    + '不返回任何密码/私钥。MCP 只允许使用这些已保存的连接，不能临时指定新主机。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => run(() => services.listConnections()));

server.registerTool('get_server_info', {
  title: '查看 MCP 服务状态',
  description:
    '返回 MCP 服务版本、读取的数据目录、当前策略（命令执行是否开启、超时与输出上限）和审计日志位置。'
    + '当工具因权限或策略被拒时，可先调用它确认原因。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => run(() => services.getServerInfo()));

server.registerTool('test_connection', {
  title: '测试 SSH 连接',
  description:
    '用已保存的凭据建立 SSH 连接并执行固定探测命令 echo，返回延迟与本次收到的主机指纹。'
    + '用于在读取文件或执行命令前确认连接可用；主机指纹未信任时会失败并说明原因。',
  inputSchema: {
    connection_id: connectionIdSchema,
  },
  annotations: { ...readOnlyAnnotations, openWorldHint: true },
}, async ({ connection_id: connectionId }) => run(
  () => services.testConnection({ connection_id: connectionId }),
));

server.registerTool('ssh_exec', {
  title: '执行远程命令',
  description:
    '在已保存连接上执行一条非交互命令（SSH exec 通道，不分配 PTY），返回 stdout、stderr、exitCode、耗时。'
    + '默认关闭，需以 MCP_ALLOW_EXEC=1 启动；rm -rf /、关机、分区、写块设备、curl|sh 等破坏性命令会被策略拦截。'
    + '不要用 sudo 或需要交互输入的命令；长任务请自行加 timeout 并拆小。',
  inputSchema: {
    connection_id: connectionIdSchema,
    command: z.string().min(1).max(65536).describe('要执行的 shell 命令，建议幂等、可重复执行'),
    timeout_ms: z.number().int().min(1000).max(300000).optional().describe(
      '超时毫秒数，默认 30000，最大 300000',
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
}, async (args) => run(() => services.execCommand(args)));

server.registerTool('sftp_list', {
  title: '列出远端目录',
  description:
    '通过 SFTP 列出远端目录内容（名称、类型、大小、权限、修改时间）。路径支持 ~ 表示家目录；默认当前家目录。'
    + '结果最多返回 1000 项，超出时 truncated=true。',
  inputSchema: {
    connection_id: connectionIdSchema,
    path: z.string().optional().describe('远端目录路径，例如 ~、/var/log；默认 .'),
  },
  annotations: readOnlyAnnotations,
}, async ({ connection_id: connectionId, path }) => run(
  () => services.listDirectory({ connection_id: connectionId, path }),
));

server.registerTool('sftp_stat', {
  title: '查看远端文件信息',
  description: '通过 SFTP 获取单个路径的类型、大小、权限、mtime、uid/gid，不读取内容。',
  inputSchema: {
    connection_id: connectionIdSchema,
    path: z.string().min(1).describe('远端文件或目录路径，支持 ~'),
  },
  annotations: readOnlyAnnotations,
}, async ({ connection_id: connectionId, path }) => run(
  () => services.statPath({ connection_id: connectionId, path }),
));

server.registerTool('sftp_read_text', {
  title: '读取远端文本文件',
  description:
    '通过 SFTP 读取远端 UTF-8 文本文件（日志、配置等）。'
    + '默认上限 256KB，可用 max_bytes 调整（仍受服务端上限约束）；文件过大或疑似二进制会直接报错。'
    + '这是只读操作，不会修改远端文件。',
  inputSchema: {
    connection_id: connectionIdSchema,
    path: z.string().min(1).describe('远端文本文件路径，支持 ~'),
    max_bytes: z.number().int().min(1024).max(1048576).optional().describe(
      '最多读取的字节数，默认 262144，最大 1048576',
    ),
  },
  annotations: readOnlyAnnotations,
}, async (args) => run(() => services.readFile(args)));

const transport = new StdioServerTransport();

try {
  await server.connect(transport);
} catch (error) {
  console.error(`[mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  services.close();
  process.exit(1);
}

console.error(
  `[mcp] ai-ssh-client MCP 已启动（data=${services.dataDir}，`
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