'use strict';

/**
 * OpenAI 兼容适配器（openai / openai-compatible / ollama / gemini-openai）。
 * 只负责「请求体构造 / 响应解析 / 流式增量解析」，网络请求由上层完成。
 */

const { openaiContent } = require('./multimodal.cjs');

function endpoint(baseUrl) {  return `${baseUrl}/chat/completions`;
}

function headers(apiKey) {
  const result = { 'Content-Type': 'application/json' };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
}

function toWireMessages(messages) {
  return (messages || []).map((message) => {
    const role = ['system', 'assistant', 'user', 'tool'].includes(message.role) ? message.role : 'user';
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    const wire = {
      role,
      content: hasAttachments ? openaiContent(message.content ?? '', message.attachments) : (message.content ?? ''),
    };
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
    if (message.tool_calls) wire.tool_calls = message.tool_calls;
    if (message.name) wire.name = message.name;
    return wire;
  });
}

function buildBody({ model, messages, stream = false, tools, temperature = 0.7 }) {
  const body = {
    model,
    temperature,
    messages: toWireMessages(messages),
  };
  if (stream) body.stream = true;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  return body;
}

function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return [];
  return list.map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.function?.name || '',
    arguments: call.function?.arguments || '',
  }));
}

function parseMessage(json) {
  const choice = json?.choices?.[0];
  const message = choice?.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(message.tool_calls),
    model: json?.model,
    finishReason: choice?.finish_reason,
    usage: json?.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined,
  };
}

/** 流式增量解析器：把 SSE data 负载逐个喂入，累积文本与 tool_calls。 */
function createStreamDecoder() {
  let content = '';
  let model;
  let finishReason;
  let usage;
  const callMap = new Map();

  return {
    ingest(payload) {
      if (!payload || payload === '[DONE]') return { done: payload === '[DONE]', events: [] };
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return { events: [] };
      }
      const events = [];
      model = chunk.model || model;
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        content += choice.delta.content;
        events.push({ type: 'delta', delta: choice.delta.content });
      }
      const deltaCalls = choice?.delta?.tool_calls;
      if (Array.isArray(deltaCalls)) {
        for (const call of deltaCalls) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const current = callMap.get(index) || { id: '', name: '', arguments: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
          callMap.set(index, current);
          if (call.function?.name || call.id) {
            events.push({ type: 'tool_call_start', toolCall: { id: current.id, name: current.name } });
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      return { events };
    },
    result() {
      const toolCalls = [...callMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.arguments,
        }));
      return { content, toolCalls, model, finishReason, usage };
    },
  };
}

module.exports = { type: 'openai', endpoint, headers, buildBody, parseMessage, createStreamDecoder };
