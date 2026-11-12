import { describe, expect, it } from 'vitest';

import * as openai from '../server/ai-providers/openai.cjs';
import * as anthropic from '../server/ai-providers/anthropic.cjs';
import * as providers from '../server/ai-providers/index.cjs';

describe('openai 适配器', () => {
  it('buildBody 透传 tools 与 stream', () => {
    const body = openai.buildBody({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'list_dir', description: '', parameters: {} } }],
    });
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('parseMessage 还原 tool_calls', () => {
    const parsed = openai.parseMessage({
      model: 'gpt-4o-mini',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'run_command', arguments: '{"command":"ls"}' } }],
        },
      }],
    });
    expect(parsed.toolCalls).toEqual([{ id: 'call_1', name: 'run_command', arguments: '{"command":"ls"}' }]);
    expect(parsed.finishReason).toBe('tool_calls');
  });

  it('流式增量拼接分片的 tool_call 参数', () => {
    const decoder = openai.createStreamDecoder();
    decoder.ingest(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }],
    }));
    decoder.ingest(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/etc/hosts"}' } }] }, finish_reason: 'tool_calls' }],
    }));
    const result = decoder.result();
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"/etc/hosts"}' }]);
    expect(result.finishReason).toBe('tool_calls');
  });
});

describe('anthropic 适配器', () => {
  it('buildBody 抽出 system 并转换 tools', () => {
    const body = anthropic.buildBody({
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'list_dir', description: 'list', parameters: { type: 'object', properties: {} } } }],
    });
    expect(body.system).toBe('system prompt');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(body.tools[0]).toEqual({ name: 'list_dir', description: 'list', input_schema: { type: 'object', properties: {} } });
  });

  it('parseMessage 把 tool_use 转成统一 toolCalls', () => {
    const parsed = anthropic.parseMessage({
      model: 'claude',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '思考' },
        { type: 'tool_use', id: 'tu_1', name: 'search_files', input: { query: 'nginx' } },
      ],
    });
    expect(parsed.content).toBe('思考');
    expect(parsed.toolCalls).toEqual([{ id: 'tu_1', name: 'search_files', arguments: '{"query":"nginx"}' }]);
  });

  it('流式增量处理文本与 input_json_delta', () => {
    const decoder = anthropic.createStreamDecoder();
    decoder.ingest(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }));
    decoder.ingest(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'write_file' } }));
    decoder.ingest(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/a"}' } }));
    const result = decoder.result();
    expect(result.content).toBe('hi');
    expect(result.toolCalls).toEqual([{ id: 'tu_2', name: 'write_file', arguments: '{"path":"/tmp/a"}' }]);
  });

  it('resolveAdapter 按类型选择', () => {
    expect(providers.resolveAdapter({ type: 'anthropic' }).type).toBe('anthropic');
    expect(providers.resolveAdapter({ type: 'openai' }).type).toBe('openai');
    expect(providers.resolveAdapter({ type: 'ollama' }).type).toBe('openai');
  });
});
