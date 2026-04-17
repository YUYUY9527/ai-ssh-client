/**
 * 快速命令管理 Hook
 * 封装快速命令的加载、创建、更新、删除逻辑
 */
import { useState, useCallback, useEffect } from 'react';
import type { QuickCommand, QuickCommandGroup } from '../../shared/types';

interface UseQuickCommandsOptions {
  autoLoad?: boolean;
}

interface UseQuickCommandsReturn {
  // 状态
  commands: QuickCommand[];
  groups: QuickCommandGroup[];
  isLoading: boolean;
  
  // 命令操作
  saveCommand: (command: QuickCommand) => Promise<boolean>;
  deleteCommand: (commandId: string) => Promise<boolean>;
  
  // 分组操作
  saveGroup: (group: QuickCommandGroup) => Promise<boolean>;
  deleteGroup: (groupId: string) => Promise<boolean>;
  
  // 工具方法
  loadCommands: () => Promise<void>;
  getCommandsByGroup: (groupId: string) => QuickCommand[];
  getUngroupedCommands: () => QuickCommand[];
}

/**
 * 快速命令 Hook
 * 管理快速命令和分组的状态与 CRUD 操作
 */
export function useQuickCommands(options: UseQuickCommandsOptions = {}): UseQuickCommandsReturn {
  const { autoLoad = true } = options;
  
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [groups, setGroups] = useState<QuickCommandGroup[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // 加载命令和分组
  const loadCommands = useCallback(async () => {
    if (!window.electronAPI) return;
    
    setIsLoading(true);
    try {
      const [commandsResult, groupsResult] = await Promise.all([
        window.electronAPI.getQuickCommands(),
        window.electronAPI.getQuickCommandGroups(),
      ]);
      
      if (commandsResult.success) {
        setCommands(Array.isArray(commandsResult.data?.commands) ? commandsResult.data.commands : []);
      }
      if (groupsResult.success) {
        setGroups(Array.isArray(groupsResult.data?.groups) ? groupsResult.data.groups : []);
      }
    } catch (error) {
      console.error('[QuickCommands] Failed to load:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 自动加载
  useEffect(() => {
    if (autoLoad) {
      loadCommands();
    }
  }, [autoLoad, loadCommands]);

  // 保存命令
  const saveCommand = useCallback(async (command: QuickCommand): Promise<boolean> => {
    if (!window.electronAPI) return false;
    
    try {
      const result = await window.electronAPI.saveQuickCommand(command);
      if (result.success) {
        await loadCommands();
        return true;
      }
      return false;
    } catch (error) {
      console.error('[QuickCommands] Failed to save command:', error);
      return false;
    }
  }, [loadCommands]);

  // 删除命令
  const deleteCommand = useCallback(async (commandId: string): Promise<boolean> => {
    if (!window.electronAPI) return false;
    
    try {
      const result = await window.electronAPI.deleteQuickCommand(commandId);
      if (result.success) {
        await loadCommands();
        return true;
      }
      return false;
    } catch (error) {
      console.error('[QuickCommands] Failed to delete command:', error);
      return false;
    }
  }, [loadCommands]);

  // 保存分组
  const saveGroup = useCallback(async (group: QuickCommandGroup): Promise<boolean> => {
    if (!window.electronAPI) return false;
    
    try {
      const result = await window.electronAPI.saveQuickCommandGroup(group);
      if (result.success) {
        await loadCommands();
        return true;
      }
      return false;
    } catch (error) {
      console.error('[QuickCommands] Failed to save group:', error);
      return false;
    }
  }, [loadCommands]);

  // 删除分组
  const deleteGroup = useCallback(async (groupId: string): Promise<boolean> => {
    if (!window.electronAPI) return false;
    
    try {
      const result = await window.electronAPI.deleteQuickCommandGroup(groupId);
      if (result.success) {
        await loadCommands();
        return true;
      }
      return false;
    } catch (error) {
      console.error('[QuickCommands] Failed to delete group:', error);
      return false;
    }
  }, [loadCommands]);

  // 获取分组内的命令
  const getCommandsByGroup = useCallback((groupId: string): QuickCommand[] => {
    return commands.filter(cmd => cmd.groupId === groupId);
  }, [commands]);

  // 获取未分组的命令
  const getUngroupedCommands = useCallback((): QuickCommand[] => {
    return commands.filter(cmd => !cmd.groupId);
  }, [commands]);

  return {
    commands,
    groups,
    isLoading,
    saveCommand,
    deleteCommand,
    saveGroup,
    deleteGroup,
    loadCommands,
    getCommandsByGroup,
    getUngroupedCommands,
  };
}
