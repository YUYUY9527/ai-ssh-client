import Store from 'electron-store';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings, CommandHistoryItem, QuickCommand, QuickCommandGroup } from '../../shared/types';

interface SettingsStoreData {
  settings: AppSettings;
  commandHistory: CommandHistoryItem[];
  quickCommands: QuickCommand[];
  quickCommandGroups: QuickCommandGroup[];
}

export class SettingsStorage {
  private store: Store<SettingsStoreData>;

  constructor() {
    this.store = new Store<SettingsStoreData>({
      defaults: {
        settings: DEFAULT_SETTINGS,
        commandHistory: [],
        quickCommands: [],
        quickCommandGroups: [],
      },
    });
  }

  // 设置相关
  getSettings(): AppSettings {
    return this.store.get('settings', DEFAULT_SETTINGS);
  }

  saveSettings(settings: AppSettings): void {
    this.store.set('settings', settings);
  }

  // 命令历史
  getCommandHistory(): CommandHistoryItem[] {
    return this.store.get('commandHistory', []);
  }

  addCommandHistoryItem(item: CommandHistoryItem): void {
    const history = this.getCommandHistory();
    // 限制历史记录数量为 500 条
    const newHistory = [item, ...history].slice(0, 500);
    this.store.set('commandHistory', newHistory);
  }

  clearCommandHistory(): void {
    this.store.set('commandHistory', []);
  }

  // 快速命令
  getQuickCommands(): QuickCommand[] {
    return this.store.get('quickCommands', []);
  }

  saveQuickCommand(command: QuickCommand): void {
    const commands = this.getQuickCommands();
    const existingIndex = commands.findIndex(c => c.id === command.id);

    if (existingIndex >= 0) {
      commands[existingIndex] = command;
    } else {
      commands.push(command);
    }

    this.store.set('quickCommands', commands);
  }

  deleteQuickCommand(commandId: string): void {
    const commands = this.getQuickCommands().filter(c => c.id !== commandId);
    this.store.set('quickCommands', commands);
  }

  // 快速命令分组
  getQuickCommandGroups(): QuickCommandGroup[] {
    return this.store.get('quickCommandGroups', []);
  }

  saveQuickCommandGroup(group: QuickCommandGroup): void {
    const groups = this.getQuickCommandGroups();
    const existingIndex = groups.findIndex(g => g.id === group.id);

    if (existingIndex >= 0) {
      groups[existingIndex] = group;
    } else {
      groups.push(group);
    }

    this.store.set('quickCommandGroups', groups);
  }

  deleteQuickCommandGroup(groupId: string): void {
    // 删除分组时，同时删除该分组下的所有命令
    const groups = this.getQuickCommandGroups().filter(g => g.id !== groupId);
    const commands = this.getQuickCommands().filter(c => c.groupId !== groupId);

    this.store.set('quickCommandGroups', groups);
    this.store.set('quickCommands', commands);
  }

  exportAllData(): SettingsStoreData {
    return {
      settings: this.getSettings(),
      commandHistory: this.getCommandHistory(),
      quickCommands: this.getQuickCommands(),
      quickCommandGroups: this.getQuickCommandGroups(),
    };
  }

  // 导入数据
  importData(data: Partial<SettingsStoreData>): void {
    if (data.settings) {
      this.saveSettings(data.settings);
    }
    if (data.commandHistory) {
      this.store.set('commandHistory', data.commandHistory);
    }
    if (data.quickCommands) {
      this.store.set('quickCommands', data.quickCommands);
    }
    if (data.quickCommandGroups) {
      this.store.set('quickCommandGroups', data.quickCommandGroups);
    }
  }
}

export const settingsStorage = new SettingsStorage();

// 便捷函数
export const getSettings = () => settingsStorage.getSettings();
export const saveSettings = (settings: AppSettings) => settingsStorage.saveSettings(settings);
export const getCommandHistory = () => settingsStorage.getCommandHistory();
export const addCommandHistoryItem = (item: CommandHistoryItem) => settingsStorage.addCommandHistoryItem(item);
export const clearCommandHistory = () => settingsStorage.clearCommandHistory();
export const getQuickCommands = () => settingsStorage.getQuickCommands();
export const saveQuickCommand = (command: QuickCommand) => settingsStorage.saveQuickCommand(command);
export const deleteQuickCommand = (commandId: string) => settingsStorage.deleteQuickCommand(commandId);
export const getQuickCommandGroups = () => settingsStorage.getQuickCommandGroups();
export const saveQuickCommandGroup = (group: QuickCommandGroup) => settingsStorage.saveQuickCommandGroup(group);
export const deleteQuickCommandGroup = (groupId: string) => settingsStorage.deleteQuickCommandGroup(groupId);
