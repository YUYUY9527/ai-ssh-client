'use strict';

/** 测试用假 ACP agent：换行 JSON-RPC，握手后在 prompt 里发起一次授权请求。 */

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf('\n');
  }
});

let pendingPromptId = null;
let pendingPermission = false;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    // 这是客户端对我们授权请求的回复
    const allowed = message.result?.outcome?.outcome === 'selected';
    if (pendingPromptId !== null) {
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: allowed ? 'end_turn' : 'cancelled', allowed } });
      pendingPromptId = null;
    }
    return;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1' } });
    return;
  }
  if (message.method === 'session/prompt') {
    pendingPromptId = message.id;
    if (pendingPermission) {
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
      pendingPromptId = null;
      return;
    }
    pendingPermission = true;
    send({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'session/request_permission',
      params: { toolCall: { name: 'write_file', arguments: { path: '/tmp/x' } } },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
  }
}
