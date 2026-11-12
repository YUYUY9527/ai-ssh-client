'use strict';

/**
 * Anthropic Messages API 适配器。
 * 负责把统一的 messages/tools 转成 Anthropic 结构，并把响应/流式增量还原成统一形状。
 */

const { anthropicContent } = require('./multimodal.cjs');

function endpoint(baseUrl) {
  // Anthropic 官方与常见中转（new-api 等）的路径都是 /v1/messages；
  // provider.baseUrl 可能带或不带 /v1，这里统一补齐。
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function headers(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

function toAnthropicMessages(messages) {
  const systemParts = [];
  const result = [];
  for (const message of messages || []) {
    if (message.role === 'system') {
      systemParts.push(typeof message.content === 'string' ? message.content : '');
      continue;
    }
    if (message.role === 'tool') {
      result.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          let input = {};
          try {
            input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
        }
      }
      result.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    result.push({
      role: 'user',
      content: hasAttachments
        ? anthropicContent(typeof message.content === 'string' ? message.content : String(message.content ?? ''), message.attachments)
        : [{ type: 'text', text: typeof message.content === 'string' ? message.content : String(message.content ?? '') }],
    });
  }
  return { system: systemParts.filter(Boolean).join('\n\n'), messages: result };
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
  }));
}

function buildBody({ model, messages, stream = false, tools, temperature = 0.7 }) {
  const converted = toAnthropicMessages(messages);
  const body = {
    model,
    max_tokens: 4096,
    temperature,
    messages: converted.messages,
  };
  if (converted.system) body.system = converted.system;
  if (stream) body.stream = true;
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) body.tools = anthropicTools;
  return body;
}

function parseMessage(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    }));
  return {
    content: text,
    toolCalls,
    model: json?.model,
    finishReason: json?.stop_reason,
    usage: json?.usage
      ? {
          promptTokens: json.usage.input_tokens,
          completionTokens: json.usage.output_tokens,
          totalTokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
        }
      : undefined,
  };
}

function createStreamDecoder() {
  let content = '';
  let model;
  let finishReason;
  let usage;
  const callMap = new Map();

  return {
    ingest(payload) {
      if (!payload || payload === '[DONE]') return { done: payload === '[DONE]', events: [] };
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return { events: [] };
      }
      const events = [];
      if (event.type === 'message_start') {
        model = event.message?.model || model;
        if (event.message?.usage) {
          usage = { promptTokens: event.message.usage.input_tokens, completionTokens: 0 };
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          callMap.set(event.index, { id: block.id, name: block.name, arguments: '' });
          events.push({ type: 'tool_call_start', toolCall: { id: block.id, name: block.name } });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          content += delta.text;
          events.push({ type: 'delta', delta: delta.text });
        } else if (delta?.type === 'input_json_delta') {
          const current = callMap.get(event.index) || { id: '', name: '', arguments: '' };
          current.arguments += delta.partial_json || '';
          callMap.set(event.index, current);
        }
      } else if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (event.usage?.output_tokens != null) {
          usage = { ...(usage || {}), completionTokens: event.usage.output_tokens };
        }
        // Anthropic 的结束序列是 message_delta(stop_reason) → message_stop，
        // 且没有 [DONE]；部分中转可能只发其一，这里两处都视为流结束。
        if (event.delta?.stop_reason) return { done: true, events };
      } else if (event.type === 'message_stop') {
        return { done: true, events };
      }
      return { events };
    },
    result() {
      const toolCalls = [...callMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.arguments || '{}',
        }));
      if (usage) {
        usage.totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
      }
      return { content, toolCalls, model, finishReason, usage };
    },
  };
}

module.exports = { type: 'anthropic', endpoint, headers, buildBody, parseMessage, createStreamDecoder };
