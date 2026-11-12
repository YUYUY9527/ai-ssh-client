import type { AIToolDefinition } from '../../../shared/ipc-types';

/**
 * Agent 暴露给模型的结构化工具（原生 tool calling）。
 *
 * 设计取舍：保留 run_command 作为万能兜底，其余四个是「只读优先」的结构化文件工具，
 * 让模型在浏览/搜索/改写文件时不必拼 shell，减少注入与转义问题。
 */
export const AGENT_RUN_COMMAND_TOOL = 'run_command';

export const AGENT_TOOL_DEFINITIONS: AIToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: AGENT_RUN_COMMAND_TOOL,
      description: '在当前 SSH 会话执行一条 shell 命令并返回输出。用于系统运维、服务管理、任意 CLI 操作。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令；可用 && 串联，避免交互式命令' },
          timeoutSeconds: { type: 'number', description: '可选超时秒数，长命令建议 30~120' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出远端目录内容（名称/类型/大小/修改时间），用于探索文件系统。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径，省略则为当前工作目录' },
          limit: { type: 'number', description: '最多返回条目数，默认 200' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取远端文本文件内容（受大小上限约束）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          maxBytes: { type: 'number', description: '最多读取字节数' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在远端目录递归按文件名或文件内容搜索（深度与结果数受限）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '搜索起点目录，省略为当前目录' },
          query: { type: 'string', description: '文件名匹配片段（可为空）' },
          contentQuery: { type: 'string', description: '文件内容匹配片段（可为空）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '覆盖写入远端文本文件。建议先传 dryRun:true 获取 diff 预览，再正式写入。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '新的完整文件内容' },
          dryRun: { type: 'boolean', description: '仅预览 unified diff，不落盘' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

/** 只读工具集合：不需要审批。 */
export const AGENT_READ_ONLY_TOOLS = new Set(['list_dir', 'read_file', 'search_files']);

/** 写操作工具：需要审批（写文件）。 */
export const AGENT_WRITE_TOOLS = new Set(['write_file']);

export function isKnownAgentTool(name: string): boolean {
  return AGENT_TOOL_DEFINITIONS.some((tool) => tool.function.name === name);
}
