import { Client, ClientChannel } from 'ssh2';
import type { SSHConnection, SSHSessionState, SFTPFileInfo } from '../../shared/types';

interface SSHSession {
  client: Client;
  shell?: ClientChannel;
  sftp?: any;  // SFTP 实例
  connection: SSHConnection;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  // 终端尺寸
  cols: number;
  rows: number;
}

export class SSHConnectionManager {
  private sessions: Map<string, SSHSession> = new Map();
  private keepaliveInterval: number = 60000;

  async connect(connection: SSHConnection, onStateChange?: (state: SSHSessionState) => void, cols: number = 80, rows: number = 24): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const sessionId = connection.id;

      // 如果已有该会话，先断开
      if (this.sessions.has(sessionId)) {
        this.disconnect(sessionId);
      }

      onStateChange?.({
        connectionId: sessionId,
        isConnected: false,
        isConnecting: true,
        reconnectAttempts: 0,
      });

      const connectConfig: any = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        readyTimeout: 30000,
        keepaliveInterval: this.keepaliveInterval,
        keepaliveCountMax: 3,
      };

      if (connection.privateKey) {
        connectConfig.privateKey = connection.privateKey;
        if (connection.passphrase) {
          connectConfig.passphrase = connection.passphrase;
        }
      } else if (connection.password) {
        connectConfig.password = connection.password;
      }

      client
        .on('ready', () => {
          console.log(`SSH connection ready for ${connection.name}`);
          // 创建 shell 时设置终端尺寸
          client.shell({
            cols: cols,
            rows: rows,
            term: 'xterm-256color',
          }, (err, stream) => {
            if (err) {
              console.error(`Shell error for ${connection.name}:`, err);
              reject(err);
              return;
            }
            this.sessions.set(sessionId, {
              client,
              shell: stream,
              connection,
              reconnectAttempts: 0,
              cols,
              rows,
            });
            onStateChange?.({
              connectionId: sessionId,
              isConnected: true,
              isConnecting: false,
              reconnectAttempts: 0,
            });
            resolve(sessionId);
          });
        })
        .on('error', (err) => {
          console.error(`SSH error for ${connection.name}:`, err);
          onStateChange?.({
            connectionId: sessionId,
            isConnected: false,
            isConnecting: false,
            reconnectAttempts: this.sessions.get(sessionId)?.reconnectAttempts || 0,
            lastError: err.message,
          });
          reject(err);
        })
        .on('close', () => {
          console.log(`SSH connection closed for ${connection.name}`);
          const session = this.sessions.get(sessionId);
          if (session) {
            session.reconnectAttempts++;
            // 触发关闭事件，让 renderer 处理重连逻辑
            onStateChange?.({
              connectionId: sessionId,
              isConnected: false,
              isConnecting: false,
              reconnectAttempts: session.reconnectAttempts,
              lastError: 'Connection closed',
            });
          }
        })
        .connect(connectConfig);
    });
  }

  async reconnect(connectionId: string, onStateChange?: (state: SSHSessionState) => void): Promise<boolean> {
    const session = this.sessions.get(connectionId);
    if (!session) {
      console.error(`Session ${connectionId} not found for reconnect`);
      return false;
    }

    if (session.reconnectAttempts >= 5) {
      console.error(`Max reconnect attempts reached for ${connectionId}`);
      onStateChange?.({
        connectionId,
        isConnected: false,
        isConnecting: false,
        reconnectAttempts: session.reconnectAttempts,
        lastError: 'Max reconnect attempts reached',
      });
      return false;
    }

    // 指数退避: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, session.reconnectAttempts), 16000);
    console.log(`Reconnecting ${connectionId} in ${delay}ms (attempt ${session.reconnectAttempts + 1})`);

    return new Promise((resolve) => {
      session.reconnectTimer = setTimeout(async () => {
        try {
          await this.connect(session.connection, onStateChange);
          resolve(true);
        } catch (e) {
          console.error(`Reconnect failed for ${connectionId}:`, e);
          resolve(false);
        }
      }, delay);
    });
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
      }
      if (session.shell) {
        // 清除所有 shell 上的事件监听器，防止内存泄漏
        // 包括 ssh-handlers 和 agent-handlers 注册的监听器
        session.shell.removeAllListeners();
        session.shell.end();
      }
      session.client.end();
      this.sessions.delete(sessionId);
    }
  }

  disconnectAll(): void {
    this.sessions.forEach((session, sessionId) => {
      this.disconnect(sessionId);
    });
  }

  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SSHSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionStates(): SSHSessionState[] {
    return Array.from(this.sessions.values()).map(session => ({
      connectionId: session.connection.id,
      isConnected: true,
      isConnecting: false,
      reconnectAttempts: session.reconnectAttempts,
    }));
  }

  executeCommand(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.shell) {
      session.shell.write(command);
    }
  }

  // 调整终端尺寸
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.shell) {
      // ssh2 的 setWindow 签名是 (rows, cols, top, bottom)
      try {
        session.shell.setWindow(rows, cols, 0, 0);
        session.cols = cols;
        session.rows = rows;
      } catch (err) {
        // 静默处理错误，避免日志洪水
      }
    }
    // shell 未就绪时静默忽略，这是正常的初始化竞争条件
  }

  // 获取 SFTP 实例
  async getSFTP(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (session.sftp) {
      return session.sftp;
    }

    return new Promise((resolve, reject) => {
      session.client.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          reject(err);
          return;
        }
        session.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  // 列出目录
  async listDirectory(sessionId: string, remotePath: string): Promise<SFTPFileInfo[]> {
    const sftp = await this.getSFTP(sessionId);
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err: Error | undefined, list: any[]) => {
        if (err) {
          reject(err);
          return;
        }

        const files: SFTPFileInfo[] = list.map(item => ({
          name: item.filename,
          path: remotePath === '/' ? `/${item.filename}` : `${remotePath}/${item.filename}`,
          size: item.attrs.size,
          isDirectory: item.attrs.isDirectory(),
          isSymbolicLink: item.attrs.isSymbolicLink(),
          mode: item.attrs.mode.toString(8),
          mtime: item.attrs.mtime * 1000,
          atime: item.attrs.atime * 1000,
        }));

        // 排序：目录在前，文件在后，按名称排序
        files.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        resolve(files);
      });
    });
  }

  // 下载文件
  async downloadFile(sessionId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSFTP(sessionId);
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {}, (err: Error | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  // 上传文件
  async uploadFile(sessionId: string, localPath: string, remotePath: string, onProgress?: (percent: number) => void): Promise<void> {
    const sftp = await this.getSFTP(sessionId);
    const { size } = await new Promise<{ size: number }>((resolve, reject) => {
      require('fs').stat(localPath, (err: Error | null, stats: { size: number } | undefined) => {
        if (err) reject(err);
        else resolve(stats!);
      });
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('上传超时'));
      }, 30 * 60 * 1000); // 30分钟超时

      sftp.fastPut(localPath, remotePath, {
        concurrency: 4, // 并发连接数
        step: (transferred: number, _chunk: number, total: number) => {
          if (onProgress && total > 0) {
            onProgress(Math.round((transferred / total) * 100));
          }
        },
      }, (err: Error | undefined) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  setKeepaliveInterval(interval: number): void {
    this.keepaliveInterval = interval;
  }

  // 测试连接 - 连接成功后立即断开
  async testConnection(connection: SSHConnection): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const client = new Client();
      let connected = false;
      let hasError = false;

      const connectConfig: any = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        readyTimeout: 15000, // 15秒超时
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
      };

      if (connection.privateKey) {
        connectConfig.privateKey = connection.privateKey;
        if (connection.passphrase) {
          connectConfig.passphrase = connection.passphrase;
        }
      } else if (connection.password) {
        connectConfig.password = connection.password;
      }

      const cleanup = () => {
        try {
          client.end();
        } catch (e) {
          // 忽略清理错误
        }
      };

      // 超时处理
      const timeout = setTimeout(() => {
        if (!connected && !hasError) {
          hasError = true;
          cleanup();
          resolve({ success: false, error: '连接超时' });
        }
      }, 15000);

      client
        .on('ready', () => {
          connected = true;
          clearTimeout(timeout);
          cleanup();
          resolve({ success: true });
        })
        .on('error', (err) => {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            cleanup();
            resolve({ success: false, error: err.message });
          }
        })
        .on('close', () => {
          // 连接关闭时的处理
        })
        .connect(connectConfig);
    });
  }
}

export const sshManager = new SSHConnectionManager();
