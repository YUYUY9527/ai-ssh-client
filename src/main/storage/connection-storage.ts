import Store from 'electron-store';
import type { SSHConnection } from '../../shared/types';
import { connectionSecretStorage, type SSHConnectionSecrets } from './connection-secret-storage';

type StoredSSHConnection = Omit<SSHConnection, 'password' | 'privateKey' | 'passphrase'>;

interface StoreData {
  sshConnections: StoredSSHConnection[];
}

export class ConnectionStorage {
  private store: Store<StoreData>;

  constructor() {
    this.store = new Store<StoreData>({
      defaults: {
        sshConnections: [],
      },
    });
    this.migrateLegacySecrets();
  }

  private getStoredConnections(): StoredSSHConnection[] {
    return this.store.get('sshConnections', []);
  }

  private normalizeConnection(connection: SSHConnection): StoredSSHConnection {
    return {
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
    };
  }

  private extractSecrets(connection: SSHConnection): SSHConnectionSecrets {
    return {
      password: connection.password,
      privateKey: connection.privateKey,
      passphrase: connection.passphrase,
    };
  }

  private hydrateConnection(connection: StoredSSHConnection): SSHConnection {
    return {
      ...connection,
      ...connectionSecretStorage.getSecrets(connection.id),
    };
  }

  private migrateLegacySecrets(): void {
    const connections = this.store.get('sshConnections', []) as Array<SSHConnection | StoredSSHConnection>;
    let changed = false;

    const migratedConnections = connections.map((connection) => {
      const legacyConnection = connection as SSHConnection;
      const secrets = this.extractSecrets(legacyConnection);
      if (secrets.password || secrets.privateKey || secrets.passphrase) {
        connectionSecretStorage.setSecrets(legacyConnection.id, secrets);
        changed = true;
      }

      if ('password' in legacyConnection || 'privateKey' in legacyConnection || 'passphrase' in legacyConnection) {
        changed = true;
      }

      return this.normalizeConnection(legacyConnection);
    });

    if (changed) {
      this.store.set('sshConnections', migratedConnections);
    }
  }

  getConnections(): SSHConnection[] {
    return this.getStoredConnections().map((connection) => this.hydrateConnection(connection));
  }

  getExportConnections(): SSHConnection[] {
    return this.getStoredConnections().map((connection) => ({ ...connection }));
  }

  saveConnection(connection: SSHConnection): void {
    const connections = this.getStoredConnections();
    const existingIndex = connections.findIndex(c => c.id === connection.id);
    const normalizedConnection = this.normalizeConnection(connection);

    if (existingIndex >= 0) {
      connections[existingIndex] = normalizedConnection;
    } else {
      connections.push(normalizedConnection);
    }

    connectionSecretStorage.setSecrets(connection.id, this.extractSecrets(connection));
    this.store.set('sshConnections', connections);
  }

  deleteConnection(connectionId: string): void {
    const connections = this.getStoredConnections().filter(c => c.id !== connectionId);
    this.store.set('sshConnections', connections);
    connectionSecretStorage.deleteSecrets(connectionId);
  }
}

export const connectionStorage = new ConnectionStorage();

// 便捷函数导出
export const getConnections = () => connectionStorage.getConnections();
export const saveConnection = (c: SSHConnection) => connectionStorage.saveConnection(c);
export const deleteConnection = (id: string) => connectionStorage.deleteConnection(id);
