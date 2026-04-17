import type { AIProviderConfig, Message, AIProviderType } from '../../shared/types';
import type { AIChatResponse } from '../../shared/ipc-types';

export type AIErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'invalid_config'
  | 'provider_not_found'
  | 'unknown';

export class AIProviderError extends Error {
  code: AIErrorCode;
  retryable: boolean;
  status?: number;

  constructor(message: string, code: AIErrorCode = 'unknown', options?: { retryable?: boolean; status?: number }) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
  }
}

export interface AIChatOptions {
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AIProvider {
  id: string;
  name: string;
  type: AIProviderType;
  config: AIProviderConfig;
  chat(messages: Message[], options?: AIChatOptions): Promise<AIChatResponse>;
  testConnection?(options?: AIChatOptions): Promise<AIChatResponse>;
  normalizeError(error: unknown): AIProviderError;
  supportsFeature(feature: 'chat' | 'cancel' | 'usage'): boolean;
}

const DEFAULT_BASE_URLS: Record<AIProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://127.0.0.1:11434/v1',
};

const DEFAULT_MODEL_BY_TYPE: Record<AIProviderType, string> = {
  openai: 'gpt-3.5-turbo',
  'openai-compatible': 'gpt-3.5-turbo',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.1',
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

function sanitizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('AI request timeout')), timeoutMs);

  const abortFromExternal = () => controller.abort(externalSignal?.reason ?? new Error('AI request aborted'));

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  controller.signal.addEventListener('abort', () => {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }, { once: true });

  return controller.signal;
}

function classifyHttpError(status: number): AIErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'network';
  return 'invalid_response';
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***').slice(0, 300);
}

abstract class BaseAIProvider implements AIProvider {
  id: string;
  name: string;
  type: AIProviderType;
  config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.config = config;
  }

  supportsFeature(feature: 'chat' | 'cancel' | 'usage'): boolean {
    return ['chat', 'cancel', 'usage'].includes(feature);
  }

  normalizeError(error: unknown): AIProviderError {
    if (error instanceof AIProviderError) {
      return error;
    }

    if (error instanceof Error) {
      if (error.name === 'AbortError' || /timeout/i.test(error.message)) {
        return new AIProviderError('AI 请求超时，请稍后重试', 'timeout', { retryable: true });
      }
      return new AIProviderError(sanitizeErrorMessage(error.message), 'unknown');
    }

    return new AIProviderError('未知 AI 请求错误', 'unknown');
  }

  async testConnection(options?: AIChatOptions): Promise<AIChatResponse> {
    return this.chat([
      { id: 'test', role: 'user', content: '你好，请回复“连接成功”', timestamp: Date.now() },
    ], options);
  }

  abstract chat(messages: Message[], options?: AIChatOptions): Promise<AIChatResponse>;
}

export class OpenAICompatibleProvider extends BaseAIProvider {
  async chat(messages: Message[], options?: AIChatOptions): Promise<AIChatResponse> {
    const apiKey = this.config.apiKey?.trim();
    const isOllama = this.type === 'ollama';

    if (!apiKey && !isOllama) {
      throw new AIProviderError('缺少 API Key', 'invalid_config');
    }

    const baseUrl = sanitizeBaseUrl(this.config.baseUrl || DEFAULT_BASE_URLS[this.type]);
    const model = this.config.model || DEFAULT_MODEL_BY_TYPE[this.type];
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
            temperature: 0.7,
          }),
          signal: createTimeoutSignal(timeoutMs, options?.signal),
        });

        if (!response.ok) {
          await response.text();
          throw new AIProviderError(`AI 服务请求失败 (${response.status})`, classifyHttpError(response.status), {
            retryable: response.status >= 500 || response.status === 429,
            status: response.status,
          });
        }

        const data = await response.json() as any;
        const content = data?.choices?.[0]?.message?.content;

        if (typeof content !== 'string') {
          throw new AIProviderError('AI 响应格式无效', 'invalid_response');
        }

        return {
          content,
          model: data?.model || model,
          finishReason: data?.choices?.[0]?.finish_reason,
          requestId: response.headers.get('x-request-id') || options?.requestId,
          usage: data?.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              }
            : undefined,
        };
      } catch (error) {
        lastError = error;
        const normalized = this.normalizeError(error);
        if (!normalized.retryable || attempt >= MAX_RETRIES) {
          throw normalized;
        }
      }
    }

    throw this.normalizeError(lastError);
  }
}

const providerFactoryMap: Record<AIProviderType, (config: AIProviderConfig) => AIProvider> = {
  openai: (config) => new OpenAICompatibleProvider(config),
  'openai-compatible': (config) => new OpenAICompatibleProvider(config),
  anthropic: (config) => new OpenAICompatibleProvider(config),
  gemini: (config) => new OpenAICompatibleProvider(config),
  ollama: (config) => new OpenAICompatibleProvider(config),
};

export function createProvider(config: AIProviderConfig): AIProvider {
  const factory = providerFactoryMap[config.type];
  if (!factory) {
    throw new AIProviderError(`不支持的 Provider 类型: ${config.type}`, 'invalid_config');
  }
  return factory(config);
}
