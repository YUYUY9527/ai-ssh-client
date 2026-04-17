import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { sshManager } from '../ssh/connection-manager';
import type { SSHConnection, SSHSessionState } from '../../shared/types';
import { dialog } from 'electron';
import { homedir } from 'os';
import path from 'path';
import { checkCommandGuard, logCommandExecution } from '../security';

export function setupSSHIpcHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle(IPC_CHANNELS.SSH_CONNECT, async (event, connection: SSHConnection, cols?: number, rows?: number) => {
    try {
      const sessionId = await sshManager.connect(connection, (state: SSHSessionState) => {
        mainWindow.webContents.send(IPC_CHANNELS.SSH_DATA, {
          connectionId: state.connectionId,
          data: '', // 特殊标记表示状态变化
          type: 'state',
          state,
        });
      }, cols || 80, rows || 24);

      const session = sshManager.getSession(sessionId);
      if (session?.shell) {
        session.shell.on('data', (data: Buffer) => {
          mainWindow.webContents.send(IPC_CHANNELS.SSH_DATA, {
            connectionId: sessionId,
            data: data.toString(),
            type: 'data',
          });
        });

        session.shell.on('close', () => {
          mainWindow.webContents.send(IPC_CHANNELS.SSH_CLOSE, sessionId);
        });

        session.shell.stderr.on('data', (data: Buffer) => {
          mainWindow.webContents.send(IPC_CHANNELS.SSH_ERROR, {
            connectionId: sessionId,
            error: data.toString(),
          });
        });
      }

      return { success: true, sessionId };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SSH_DISCONNECT, async (_event, connectionId: string) => {
    sshManager.disconnect(connectionId);
    return { success: true };
  });

  // SSH_EXECUTE 使用 ipcMain.handle 支持 async/await 模式
  ipcMain.handle(IPC_CHANNELS.SSH_EXECUTE, async (_event, connectionId: string, command: string) => {
    try {
      // 主进程安全兜底：检查命令风险
      const guardResult = checkCommandGuard(command);
      
      if (!guardResult.allowed) {
        console.warn(`[SSH_EXECUTE] Blocked dangerous command: ${command.substring(0, 50)}...`);
        return { 
          success: false, 
          error: guardResult.reason || '命令被安全策略阻止',
          riskLevel: guardResult.riskLevel,
        };
      }
      
      // 记录命令执行日志
      logCommandExecution(connectionId, command, guardResult.riskLevel);
      
      sshManager.executeCommand(connectionId, command);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.on(IPC_CHANNELS.SSH_EXECUTE_SYNC, (_event, connectionId: string, command: string) => {
    try {
      sshManager.executeCommand(connectionId, command);
    } catch (error) {
      console.error('[SSH_EXECUTE_SYNC] Failed to forward terminal input:', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SSH_RECONNECT, async (event, connectionId: string) => {
    try {
      const ok = await sshManager.reconnect(connectionId, (state: SSHSessionState) => {
        mainWindow.webContents.send(IPC_CHANNELS.SSH_DATA, {
          connectionId: state.connectionId,
          data: '',
          type: 'state',
          state,
        });
      });
      return ok ? { success: true } : { success: false, error: 'Reconnect failed' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SSH_GET_SESSIONS, async () => {
    const states = sshManager.getSessionStates();
    return { success: true, sessions: states };
  });

  ipcMain.handle(IPC_CHANNELS.SSH_TEST_CONNECTION, async (_event, connection: SSHConnection) => {
    try {
      const result = await sshManager.testConnection(connection);
      return result;
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SSH_RESIZE, async (_event, connectionId: string, cols: number, rows: number) => {
    try {
      sshManager.resize(connectionId, cols, rows);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // SFTP 文件传输处理器
  ipcMain.handle(IPC_CHANNELS.SFTP_LIST_DIRECTORY, async (_event, connectionId: string, remotePath: string) => {
    try {
      const files = await sshManager.listDirectory(connectionId, remotePath || '/');
      return { success: true, files };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SFTP_DOWNLOAD_FILE, async (_event, connectionId: string, remotePath: string) => {
    try {
      // 打开保存对话框
      const filename = path.basename(remotePath);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存文件',
        defaultPath: path.join(homedir(), 'Downloads', filename),
        filters: [{ name: '所有文件', extensions: ['*'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' };
      }

      await sshManager.downloadFile(connectionId, remotePath, result.filePath);
      return { success: true, localPath: result.filePath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SFTP_UPLOAD_FILE, async (_event, connectionId: string, localPath: string, remoteDir: string) => {
    try {
      const filename = path.basename(localPath);
      const remotePath = remoteDir === '/' ? `/${filename}` : `${remoteDir}/${filename}`;

      // 发送进度更新
      const sendProgress = (percent: number) => {
        mainWindow.webContents.send('sftp-upload-progress', {
          connectionId,
          filename,
          progress: percent,
        });
      };

      await sshManager.uploadFile(connectionId, localPath, remotePath, sendProgress);
      return { success: true, remotePath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
