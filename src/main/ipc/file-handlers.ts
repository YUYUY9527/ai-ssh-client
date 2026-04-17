import { ipcMain, dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import path from 'path';

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
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      // 不读取文件内容，只返回路径
      return {
        success: true,
        filePath,
        fileName: path.basename(filePath),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
