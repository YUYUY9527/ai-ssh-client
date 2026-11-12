'use strict';

const openai = require('./openai.cjs');
const anthropic = require('./anthropic.cjs');

/**
 * 按 provider.type 选择适配器。
 * gemini/ollama/openai-compatible 均走 OpenAI 兼容协议。
 */
function resolveAdapter(provider) {
  const type = provider?.type;
  if (type === 'anthropic') return anthropic;
  return openai;
}

module.exports = { resolveAdapter, openai, anthropic };
