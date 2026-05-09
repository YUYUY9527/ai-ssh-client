import Store from 'electron-store';
import type { AIProviderConfig, Message, AIProviderSummary } from '../../shared/types';
import type { AIChatResponse } from '../../shared/ipc-types';
import { createProvider, type AIProvider, AIProviderError } from './provider';
import { aiSecretStorage } from '../storage/ai-secret-storage';
import {
  normalizeProviderConfig,
  hydrateProviderConfig,
  toProviderSummary,
  extractProviderSecretInput,
} from './provider-config';

interface StoreData {
  aiProviders: Array<Omit<AIProviderConfig, 'apiKey'>>;
}

export class AIManager {
  private store: Store<StoreData>;
  private providers: Map<string, AIProvider> = new Map();
  private activeRequests: Map<string, AbortController> = new Map();

  constructor() {
    this.store = new Store<StoreData>({
      defaults: {
        aiProviders: [],
      },
    });
    this.migrateLegacySecrets();
    this.loadProviders();
  }

  private migrateLegacySecrets() {
    const configs = this.store.get('aiProviders', []);
    let changed = false;

    const migratedConfigs = configs.map((config) => {
      const legacyApiKey = (config as AIProviderConfig & { apiKey?: string }).apiKey;
      if (typeof legacyApiKey === 'string' && legacyApiKey.trim()) {
        aiSecretStorage.setSecret({ providerId: config.id, apiKey: legacyApiKey });
        changed = true;
      }

      if ('apiKey' in config) {
        const { apiKey: _apiKey, ...rest } = config as AIProviderConfig & { apiKey?: string };
        changed = true;
        return rest;
      }

      return config;
    });

    if (changed) {
      this.store.set('aiProviders', migratedConfigs);
    }
  }

  private loadProviders() {
    const configs = this.store.get('aiProviders', []).map(hydrateProviderConfig);
    for (const config of configs) {
      if (config.isActive) {
        try {
          const provider = createProvider(config);
          this.providers.set(config.id, provider);
        } catch {
          // 静默失败，避免日志输出敏感配置
        }
      }
    }
  }

  getProviders(): AIProviderSummary[] {
    return this.store.get('aiProviders', []).map(toProviderSummary);
  }

  getProviderConfigs(): AIProviderConfig[] {
    return this.store.get('aiProviders', []).map(hydrateProviderConfig);
  }

  async saveProvider(config: AIProviderConfig): Promise<void> {
    const providers = this.store.get('aiProviders', []);
    const normalizedConfig = normalizeProviderConfig(config);
    const existingIndex = providers.findIndex((p) => p.id === config.id);

    if (existingIndex >= 0) {
      providers[existingIndex] = normalizedConfig;
    } else {
      providers.push(normalizedConfig);
    }

    const secretInput = extractProviderSecretInput(config);
    if (secretInput) {
      aiSecretStorage.setSecret(secretInput);
    }

    this.store.set('aiProviders', providers);
    this.providers.delete(config.id);

    if (normalizedConfig.isActive) {
      const provider = createProvider({ ...normalizedConfig, apiKey: aiSecretStorage.getSecret(config.id) });
      this.providers.set(config.id, provider);
    }
  }

  async deleteProvider(providerId: string): Promise<void> {
    const providers = this.store.get('aiProviders', []).filter((p) => p.id !== providerId);
    this.store.set('aiProviders', providers);
    aiSecretStorage.deleteSecret(providerId);
    this.providers.delete(providerId);
  }

  async setActiveProvider(providerId: string): Promise<void> {
    const providers = this.store.get('aiProviders', []);
    let changed = false;

    for (let i = 0; i < providers.length; i++) {
      const shouldBeActive = providers[i].id === providerId;
      if (providers[i].isActive !== shouldBeActive) {
        providers[i] = { ...providers[i], isActive: shouldBeActive };
        changed = true;
      }
      if (!shouldBeActive) {
        this.providers.delete(providers[i].id);
      }
    }

    if (changed) {
      this.store.set('aiProviders', providers);
    }

    const targetConfig = providers.find((p) => p.id === providerId);
    if (targetConfig && !this.providers.has(providerId)) {
      try {
        const provider = createProvider(hydrateProviderConfig(targetConfig));
        this.providers.set(providerId, provider);
      } catch {
        // 静默失败
      }
    }
  }

  async chat(providerId: string, messages: Message[], options?: { requestId?: string }): Promise<AIChatResponse> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AIProviderError(`Provider ${providerId} not found or not active`, 'provider_not_found');
    }

    const requestId = options?.requestId || `${providerId}-${Date.now()}`;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    try {
      return await provider.chat(messages, {
        requestId,
        signal: controller.signal,
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  cancelChat(requestId: string): boolean {
    const controller = this.activeRequests.get(requestId);
    if (!controller) {
      return false;
    }

    controller.abort(new Error('用户取消了 AI 请求'));
    this.activeRequests.delete(requestId);
    return true;
  }

  async testProvider(config: AIProviderConfig): Promise<AIChatResponse> {
    const provider = createProvider({
      ...normalizeProviderConfig(config),
      apiKey: typeof config.apiKey === 'string' ? config.apiKey : aiSecretStorage.getSecret(config.id),
    });

    return provider.testConnection?.() ?? provider.chat([
      { id: 'test', role: 'user', content: '你好，请回复“连接成功”', timestamp: Date.now() },
    ]);
  }
}

let aiManagerInstance: AIManager | null = null;

export function getAIManager(): AIManager {
  if (!aiManagerInstance) {
    aiManagerInstance = new AIManager();
  }

  return aiManagerInstance;
}
