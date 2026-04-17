import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { connectionStorage } from '../storage/connection-storage';
import type { SSHConnection } from '../../shared/types';

export function setupConnectionIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_CONNECTIONS, async () => {
    try {
      const connections = connectionStorage.getConnections();
      return { success: true, connections };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_CONNECTION, async (_event, connection: SSHConnection) => {
    try {
      connectionStorage.saveConnection(connection);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_CONNECTION, async (_event, connectionId: string) => {
    try {
      connectionStorage.deleteConnection(connectionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
