import type { AIProviderConfig, AIProviderSecretInput, AIProviderSummary } from '../../shared/types';
import type { AIProviderSecretStatusResult } from '../../shared/ipc-types';
import { aiSecretStorage } from '../storage/ai-secret-storage';

interface StoredAIProviderConfig extends Omit<AIProviderConfig, 'apiKey'> {}

export function normalizeProviderConfig(config: AIProviderConfig): StoredAIProviderConfig {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    baseUrl: config.baseUrl,
    model: config.model,
    isActive: Boolean(config.isActive),
  };
}

export function hydrateProviderConfig(config: StoredAIProviderConfig): AIProviderConfig {
  return {
    ...config,
    apiKey: aiSecretStorage.getSecret(config.id),
  };
}

export function toProviderSummary(config: StoredAIProviderConfig): AIProviderSummary {
  const secretStatus = aiSecretStorage.getSecretStatus(config.id);
  return {
    ...config,
    hasApiKey: secretStatus.hasApiKey,
    maskedApiKey: secretStatus.maskedApiKey,
  };
}

export function isSecretPlaceholderInput(apiKey: string): boolean {
  const normalized = apiKey.trim();
  return normalized.length > 0 && /^[•*]+$/.test(normalized);
}

export function shouldUpdateProviderSecret(config: AIProviderConfig): boolean {
  return typeof config.apiKey === 'string' && !isSecretPlaceholderInput(config.apiKey);
}

export function extractProviderSecretInput(config: AIProviderConfig): AIProviderSecretInput | null {
  if (!shouldUpdateProviderSecret(config)) {
    return null;
  }

  return {
    providerId: config.id,
    apiKey: config.apiKey ?? '',
  };
}

export function getProviderSecretStatus(providerId: string): AIProviderSecretStatusResult {
  return aiSecretStorage.getSecretStatus(providerId);
}
