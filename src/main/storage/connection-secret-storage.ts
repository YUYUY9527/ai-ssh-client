import { safeStorage } from 'electron';
import Store from 'electron-store';
import type { SSHConnection } from '../../shared/types';

type SSHConnectionSecretKey = 'password' | 'privateKey' | 'passphrase';
export type SSHConnectionSecrets = Partial<Pick<SSHConnection, SSHConnectionSecretKey>>;

interface SecretStoreData {
  sshConnectionSecrets: Record<string, Partial<Record<SSHConnectionSecretKey, string>>>;
}

const SECRET_STORE_KEY = 'sshConnectionSecrets';

function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

export class ConnectionSecretStorage {
  private store: Store<SecretStoreData>;

  constructor() {
    this.store = new Store<SecretStoreData>({
      name: 'ssh-secrets',
      defaults: {
        sshConnectionSecrets: {},
      },
    });
  }

  private getSecretMap(): Record<string, Partial<Record<SSHConnectionSecretKey, string>>> {
    return this.store.get(SECRET_STORE_KEY, {});
  }

  private setSecretMap(map: Record<string, Partial<Record<SSHConnectionSecretKey, string>>>): void {
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
        throw new Error('当前环境无法解密已保护的 SSH 凭据');
      }
      return safeStorage.decryptString(fromBase64(payload));
    }

    if (value.startsWith('plain:')) {
      return fromBase64(value.slice(6)).toString('utf-8');
    }

    return value;
  }

  getSecrets(connectionId: string): SSHConnectionSecrets {
    const rawSecrets = this.getSecretMap()[connectionId] || {};
    const secrets: SSHConnectionSecrets = {};

    for (const key of ['password', 'privateKey', 'passphrase'] as const) {
      const rawValue = rawSecrets[key];
      if (rawValue) {
        try {
          secrets[key] = this.unprotectString(rawValue);
        } catch (error) {
          console.warn(
            `[ConnectionSecretStorage] Unable to decrypt ${key} for connection ${connectionId}. The field will be treated as empty.`,
            error instanceof Error ? error.message : error
          );
        }
      }
    }

    return secrets;
  }

  setSecrets(connectionId: string, secrets: SSHConnectionSecrets): void {
    const normalizedConnectionId = connectionId.trim();
    if (!normalizedConnectionId) {
      throw new Error('connectionId 不能为空');
    }

    const secretMap = this.getSecretMap();
    const nextSecrets: Partial<Record<SSHConnectionSecretKey, string>> = {};

    for (const key of ['password', 'privateKey', 'passphrase'] as const) {
      const value = secrets[key]?.trim() ?? '';
      if (value) {
        nextSecrets[key] = this.protectString(value);
      }
    }

    if (Object.keys(nextSecrets).length === 0) {
      delete secretMap[normalizedConnectionId];
    } else {
      secretMap[normalizedConnectionId] = nextSecrets;
    }

    this.setSecretMap(secretMap);
  }

  deleteSecrets(connectionId: string): void {
    const secretMap = this.getSecretMap();
    if (!(connectionId in secretMap)) {
      return;
    }

    delete secretMap[connectionId];
    this.setSecretMap(secretMap);
  }
}

export const connectionSecretStorage = new ConnectionSecretStorage();
