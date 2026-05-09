import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { AIProviderSecretInput } from '../../shared/types';

interface SecretStoreData {
  aiProviderSecrets: Record<string, string>;
}

const SECRET_STORE_KEY = 'aiProviderSecrets';

function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function maskApiKey(apiKey: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`;
}

export class AISecretStorage {
  private store: Store<SecretStoreData>;

  constructor() {
    this.store = new Store<SecretStoreData>({
      name: 'ai-secrets',
      defaults: {
        aiProviderSecrets: {},
      },
    });
  }

  private getSecretMap(): Record<string, string> {
    return this.store.get(SECRET_STORE_KEY, {});
  }

  private setSecretMap(map: Record<string, string>): void {
    this.store.set(SECRET_STORE_KEY, map);
  }

  private protectString(value: string): string {
    if (!value) {
      return '';
    }

    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${toBase64(safeStorage.encryptString(value))}`;
    }

    return `plain:${toBase64(Buffer.from(value, 'utf-8'))}`;
  }

  private unprotectString(value: string): string {
    if (!value) {
      return '';
    }

    if (value.startsWith('enc:')) {
      const payload = value.slice(4);
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前环境无法解密已保护的 API Key');
      }
      return safeStorage.decryptString(fromBase64(payload));
    }

    if (value.startsWith('plain:')) {
      return fromBase64(value.slice(6)).toString('utf-8');
    }

    return value;
  }

  getSecret(providerId: string): string {
    const secretMap = this.getSecretMap();
    const raw = secretMap[providerId];
    if (!raw) {
      return '';
    }

    try {
      return this.unprotectString(raw);
    } catch (error) {
      console.warn(
        `[AISecretStorage] Unable to decrypt API key for provider ${providerId}. The provider will be treated as missing an API key.`,
        error instanceof Error ? error.message : error
      );
      return '';
    }
  }

  getSecretStatus(providerId: string): { providerId: string; hasApiKey: boolean; maskedApiKey?: string } {
    const apiKey = this.getSecret(providerId);
    return {
      providerId,
      hasApiKey: Boolean(apiKey),
      maskedApiKey: maskApiKey(apiKey),
    };
  }

  setSecret(input: AIProviderSecretInput): void {
    const providerId = input.providerId?.trim();
    if (!providerId) {
      throw new Error('providerId 不能为空');
    }

    const secretMap = this.getSecretMap();
    const apiKey = input.apiKey?.trim() ?? '';

    if (!apiKey) {
      delete secretMap[providerId];
    } else {
      secretMap[providerId] = this.protectString(apiKey);
    }

    this.setSecretMap(secretMap);
  }

  deleteSecret(providerId: string): void {
    const secretMap = this.getSecretMap();
    if (!(providerId in secretMap)) {
      return;
    }

    delete secretMap[providerId];
    this.setSecretMap(secretMap);
  }
}

export const aiSecretStorage = new AISecretStorage();
