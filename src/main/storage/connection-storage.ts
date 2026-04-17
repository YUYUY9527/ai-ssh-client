import Store from 'electron-store';
import type { SSHConnection } from '../../shared/types';

interface StoreData {
  sshConnections: SSHConnection[];
}

export class ConnectionStorage {
  private store: Store<StoreData>;

  constructor() {
    this.store = new Store<StoreData>({
      defaults: {
        sshConnections: [],
      },
    });
  }

  getConnections(): SSHConnection[] {
    return this.store.get('sshConnections', []);
  }

  saveConnection(connection: SSHConnection): void {
    const connections = this.getConnections();
    const existingIndex = connections.findIndex(c => c.id === connection.id);

    if (existingIndex >= 0) {
      connections[existingIndex] = connection;
    } else {
      connections.push(connection);
    }

    this.store.set('sshConnections', connections);
  }

  deleteConnection(connectionId: string): void {
    const connections = this.getConnections().filter(c => c.id !== connectionId);
    this.store.set('sshConnections', connections);
  }
}

export const connectionStorage = new ConnectionStorage();

// 便捷函数导出
export const getConnections = () => connectionStorage.getConnections();
export const saveConnection = (c: SSHConnection) => connectionStorage.saveConnection(c);
export const deleteConnection = (id: string) => connectionStorage.deleteConnection(id);
