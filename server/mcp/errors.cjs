/**
 * 带错误码的工具错误。
 *
 * MCP 客户端只看到一条文本消息，但错误码要能让调用方（或人）区分
 * 「没开执行权限」和「命令被策略拦下」这类可自行修复的情况。
 */
function toolError(message, code = 'tool-error', details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

module.exports = { toolError };