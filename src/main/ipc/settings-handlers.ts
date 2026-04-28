import { ipcMain, Notification, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  getSettings,
  saveSettings,
  getCommandHistory,
  addCommandHistoryItem,
  clearCommandHistory,
  getQuickCommands,
  saveQuickCommand,
  deleteQuickCommand,
  getQuickCommandGroups,
  saveQuickCommandGroup,
  deleteQuickCommandGroup,
} from '../storage/settings-storage';
import { connectionStorage } from '../storage/connection-storage';
import { aiManager } from '../ai/manager';
import type {
  AppSettings,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  AIProviderConfig,
  AIProviderType,
  SSHConnection,
} from '../../shared/types';
import type { IPCResult, ImportDataResult, ImportIssue } from '../../shared/ipc-types';

interface ImportPayload {
  version?: string;
  exportDate?: string;
  connections?: SSHConnection[];
  aiProviders?: AIProviderConfig[];
  settings?: Partial<AppSettings>;
  commandHistory?: CommandHistoryItem[];
  quickCommands?: QuickCommand[];
  quickCommandGroups?: QuickCommandGroup[];
}

interface SystemNotificationPayload {
  title?: string;
  body?: string;
  onlyWhenAppInBackground?: boolean;
}

const VALID_PROVIDER_TYPES: AIProviderType[] = ['openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama'];

function isAppInBackground(mainWindow: BrowserWindow | null | undefined): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return true;
  }

  return !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function sanitizeProvider(provider: unknown): AIProviderConfig | null {
  if (!isObject(provider)) return null;
  if (typeof provider.id !== 'string' || typeof provider.name !== 'string') return null;
  if (!VALID_PROVIDER_TYPES.includes(provider.type as AIProviderType)) return null;
  if (provider.baseUrl && typeof provider.baseUrl !== 'string') return null;
  if (provider.model && typeof provider.model !== 'string') return null;

  return {
    id: provider.id,
    name: provider.name,
    type: provider.type as AIProviderType,
    apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : undefined,
    baseUrl: provider.baseUrl,
    model: provider.model,
    isActive: Boolean(provider.isActive),
  };
}

function sanitizeConnection(connection: unknown): SSHConnection | null {
  if (!isObject(connection)) return null;
  if (typeof connection.id !== 'string' || typeof connection.name !== 'string') return null;
  if (typeof connection.host !== 'string' || typeof connection.username !== 'string') return null;

  const port = typeof connection.port === 'number' ? connection.port : Number(connection.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port,
    username: connection.username,
    password: typeof connection.password === 'string' ? connection.password : undefined,
    privateKey: typeof connection.privateKey === 'string' ? connection.privateKey : undefined,
    passphrase: typeof connection.passphrase === 'string' ? connection.passphrase : undefined,
  };
}

function sanitizeQuickCommand(command: unknown): QuickCommand | null {
  if (!isObject(command)) return null;
  if (typeof command.id !== 'string' || typeof command.name !== 'string' || typeof command.command !== 'string') return null;

  return {
    id: command.id,
    name: command.name,
    command: command.command,
    description: typeof command.description === 'string' ? command.description : undefined,
    groupId: typeof command.groupId === 'string' ? command.groupId : undefined,
  };
}

function sanitizeQuickCommandGroup(group: unknown): QuickCommandGroup | null {
  if (!isObject(group)) return null;
  if (typeof group.id !== 'string' || typeof group.name !== 'string') return null;

  return {
    id: group.id,
    name: group.name,
    color: typeof group.color === 'string' ? group.color : undefined,
  };
}

function sanitizeSettings(settings: unknown): Partial<AppSettings> | undefined {
  if (!isObject(settings)) return undefined;

  const next: Partial<AppSettings> = {};
  if (settings.theme === 'dark' || settings.theme === 'light' || settings.theme === 'system') next.theme = settings.theme;
  if (typeof settings.fontSize === 'number') next.fontSize = settings.fontSize;
  if (typeof settings.fontFamily === 'string') next.fontFamily = settings.fontFamily;
  if (typeof settings.keepaliveInterval === 'number') next.keepaliveInterval = settings.keepaliveInterval;
  if (typeof settings.keepaliveCountMax === 'number') next.keepaliveCountMax = settings.keepaliveCountMax;
  if (typeof settings.autoReconnect === 'boolean') next.autoReconnect = settings.autoReconnect;
  if (typeof settings.maxReconnectAttempts === 'number') next.maxReconnectAttempts = settings.maxReconnectAttempts;
  if (typeof settings.approveHighRisk === 'boolean') next.approveHighRisk = settings.approveHighRisk;
  if (typeof settings.approveMediumRisk === 'boolean') next.approveMediumRisk = settings.approveMediumRisk;
  if (typeof settings.rememberChoice === 'boolean') next.rememberChoice = settings.rememberChoice;
  if (typeof settings.connectionNotifications === 'boolean') next.connectionNotifications = settings.connectionNotifications;
  if (typeof settings.commandNotifications === 'boolean') next.commandNotifications = settings.commandNotifications;
  if (typeof settings.showTerminalOutputPrompt === 'boolean') next.showTerminalOutputPrompt = settings.showTerminalOutputPrompt;
  if (typeof settings.terminalTheme === 'string') next.terminalTheme = settings.terminalTheme;
  if (typeof settings.agentEnabled === 'boolean') next.agentEnabled = settings.agentEnabled;
  if (typeof settings.agentAutoExecute === 'boolean') next.agentAutoExecute = settings.agentAutoExecute;
  if (typeof settings.agentMaxExecutionSteps === 'number') next.agentMaxExecutionSteps = settings.agentMaxExecutionSteps;
  if (typeof settings.agentMaxContextMessages === 'number') next.agentMaxContextMessages = settings.agentMaxContextMessages;
  if (typeof settings.agentMaxTerminalOutputLength === 'number') next.agentMaxTerminalOutputLength = settings.agentMaxTerminalOutputLength;
  if (typeof settings.agentTrimContextEnabled === 'boolean') next.agentTrimContextEnabled = settings.agentTrimContextEnabled;
  if (typeof settings.agentTaskContextRounds === 'number') next.agentTaskContextRounds = settings.agentTaskContextRounds;

  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeImportData(data: unknown): ImportPayload {
  if (!isObject(data)) {
    throw new Error('导入数据格式无效');
  }

  return {
    version: typeof data.version === 'string' ? data.version : undefined,
    exportDate: typeof data.exportDate === 'string' ? data.exportDate : undefined,
    connections: Array.isArray(data.connections) ? data.connections.map(sanitizeConnection).filter(Boolean) as SSHConnection[] : [],
    aiProviders: Array.isArray(data.aiProviders) ? data.aiProviders.map(sanitizeProvider).filter(Boolean) as AIProviderConfig[] : [],
    settings: sanitizeSettings(data.settings),
    commandHistory: [],
    quickCommands: Array.isArray(data.quickCommands) ? data.quickCommands.map(sanitizeQuickCommand).filter(Boolean) as QuickCommand[] : [],
    quickCommandGroups: Array.isArray(data.quickCommandGroups) ? data.quickCommandGroups.map(sanitizeQuickCommandGroup).filter(Boolean) as QuickCommandGroup[] : [],
  };
}

export function setupSettingsIpcHandlers(getMainWindow?: () => BrowserWindow | null) {
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, async (): Promise<IPCResult<{ settings: AppSettings }>> => {
    try {
      return { success: true, data: { settings: getSettings() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, async (_event, settings: AppSettings): Promise<IPCResult> => {
    try {
      saveSettings(settings);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SHOW_SYSTEM_NOTIFICATION,
    async (_event, payload: SystemNotificationPayload): Promise<IPCResult> => {
      try {
        if (!Notification.isSupported()) {
          return { success: false, error: '当前系统不支持通知' };
        }

        if (payload?.onlyWhenAppInBackground && !isAppInBackground(getMainWindow?.())) {
          return { success: true };
        }

        const title = typeof payload?.title === 'string' && payload.title.trim()
          ? payload.title.trim()
          : '通知';
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';

        const notification = new Notification({
          title,
          body,
          silent: false,
        });

        notification.show();
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.GET_COMMAND_HISTORY, async (): Promise<IPCResult<{ history: CommandHistoryItem[] }>> => {
    try {
      return { success: true, data: { history: getCommandHistory() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ADD_COMMAND_HISTORY, async (_event, item: CommandHistoryItem): Promise<IPCResult> => {
    try {
      addCommandHistoryItem(item);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLEAR_COMMAND_HISTORY, async (): Promise<IPCResult> => {
    try {
      clearCommandHistory();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_QUICK_COMMANDS, async (): Promise<IPCResult<{ commands: QuickCommand[] }>> => {
    try {
      return { success: true, data: { commands: getQuickCommands() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_QUICK_COMMAND, async (_event, command: QuickCommand): Promise<IPCResult> => {
    try {
      saveQuickCommand(command);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_QUICK_COMMAND, async (_event, commandId: string): Promise<IPCResult> => {
    try {
      deleteQuickCommand(commandId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_QUICK_COMMAND_GROUPS, async (): Promise<IPCResult<{ groups: QuickCommandGroup[] }>> => {
    try {
      return { success: true, data: { groups: getQuickCommandGroups() } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_QUICK_COMMAND_GROUP, async (_event, group: QuickCommandGroup): Promise<IPCResult> => {
    try {
      saveQuickCommandGroup(group);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_QUICK_COMMAND_GROUP, async (_event, groupId: string): Promise<IPCResult> => {
    try {
      deleteQuickCommandGroup(groupId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('export-all-data', async (): Promise<IPCResult<{ data: ImportPayload }>> => {
    try {
      const providerConfigs = aiManager.getProviderConfigs().map(({ apiKey, ...rest }) => ({ ...rest, apiKey: '' }));
      const data: ImportPayload = {
        version: '1.3.0',
        exportDate: new Date().toISOString(),
        connections: connectionStorage.getExportConnections(),
        aiProviders: providerConfigs,
        settings: getSettings(),
        commandHistory: getCommandHistory(),
        quickCommands: getQuickCommands(),
        quickCommandGroups: getQuickCommandGroups(),
      };
      return { success: true, data: { data } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('import-data', async (_event, rawData: unknown, options?: { merge?: boolean }): Promise<IPCResult<ImportDataResult>> => {
    try {
      const data = sanitizeImportData(rawData);
      const merge = options?.merge ?? false;
      const skipped: ImportIssue[] = [];
      const imported: ImportDataResult['imported'] = {
        connections: 0,
        aiProviders: 0,
        settings: 0,
        quickCommands: 0,
        quickCommandGroups: 0,
      };

      const rawConnections = isObject(rawData) && Array.isArray(rawData.connections) ? rawData.connections : [];
      rawConnections.forEach((connection, index) => {
        const sanitized = sanitizeConnection(connection);
        if (!sanitized) {
          skipped.push({ scope: 'connection', index, reason: '连接配置格式无效，已跳过' });
          return;
        }
        connectionStorage.saveConnection(sanitized);
        imported.connections += 1;
      });

      const existingProviders = aiManager.getProviderConfigs();
      const existingIds = new Set(existingProviders.map((provider) => provider.id));
      const rawProviders = isObject(rawData) && Array.isArray(rawData.aiProviders) ? rawData.aiProviders : [];
      for (let index = 0; index < rawProviders.length; index += 1) {
        const provider = sanitizeProvider(rawProviders[index]);
        if (!provider) {
          skipped.push({ scope: 'provider', index, reason: 'AI Provider 配置无效，已跳过' });
          continue;
        }
        if (merge && existingIds.has(provider.id)) {
          skipped.push({ scope: 'provider', index, id: provider.id, reason: 'merge 模式下已存在同 ID Provider，已跳过' });
          continue;
        }
        await aiManager.saveProvider(provider);
        imported.aiProviders += 1;
      }

      if (data.settings) {
        saveSettings({ ...getSettings(), ...data.settings });
        imported.settings = 1;
      } else if (isObject(rawData) && rawData.settings !== undefined) {
        skipped.push({ scope: 'settings', reason: '设置项格式无效，已跳过' });
      }

      const rawQuickCommands = isObject(rawData) && Array.isArray(rawData.quickCommands) ? rawData.quickCommands : [];
      rawQuickCommands.forEach((command, index) => {
        const sanitized = sanitizeQuickCommand(command);
        if (!sanitized) {
          skipped.push({ scope: 'quick-command', index, reason: '快捷命令格式无效，已跳过' });
          return;
        }
        saveQuickCommand(sanitized);
        imported.quickCommands += 1;
      });

      const rawQuickCommandGroups = isObject(rawData) && Array.isArray(rawData.quickCommandGroups) ? rawData.quickCommandGroups : [];
      rawQuickCommandGroups.forEach((group, index) => {
        const sanitized = sanitizeQuickCommandGroup(group);
        if (!sanitized) {
          skipped.push({ scope: 'quick-command-group', index, reason: '快捷命令分组格式无效，已跳过' });
          return;
        }
        saveQuickCommandGroup(sanitized);
        imported.quickCommandGroups += 1;
      });

      return { success: true, data: { imported, skipped } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
