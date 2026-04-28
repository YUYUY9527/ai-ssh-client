import { ipcMain, dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import path from 'path';
import { readFile, stat } from 'fs/promises';

const MAX_PRIVATE_KEY_FILE_BYTES = 1024 * 1024;
const selectedFilePaths = new Set<string>();

function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath);
}

export function setupFileIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.SELECT_FILE, async (_event, options: {
    title?: string;
    filters?: { name: string; extensions: string[] }[];
    defaultPath?: string;
    properties?: string[];
  }) => {
    try {
      const properties = (options.properties as Array<'openFile' | 'multiSelections'>) || ['openFile'];
      
      const result = await dialog.showOpenDialog({
        title: options.title || '选择文件',
        filters: options.filters || [
          { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: options.defaultPath,
        properties: properties,
      });

      if (result.canceled || result.filePaths.length === 0) {
        return {
          success: true,
          data: {
            canceled: true,
            filePath: '',
            fileName: '',
          },
        };
      }

      const filePath = result.filePaths[0];
      selectedFilePaths.add(normalizeFilePath(filePath));
      // 不读取文件内容，只返回路径
      return {
        success: true,
        data: {
          canceled: false,
          filePath,
          fileName: path.basename(filePath),
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.READ_PRIVATE_KEY_FILE, async (_event, filePath: string) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { success: false, error: '私钥文件路径无效' };
      }

      const normalizedPath = normalizeFilePath(filePath);
      if (!selectedFilePaths.has(normalizedPath)) {
        return { success: false, error: '只能读取通过文件选择器选择的私钥文件' };
      }

      const fileStat = await stat(normalizedPath);
      if (!fileStat.isFile()) {
        return { success: false, error: '选择的路径不是文件' };
      }

      if (fileStat.size > MAX_PRIVATE_KEY_FILE_BYTES) {
        return { success: false, error: '私钥文件过大' };
      }

      const content = await readFile(normalizedPath, 'utf-8');
      return { success: true, data: { content } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
