/**
 * SSH 事件监听 Hook
 * 统一管理 SSH 数据、错误、关闭以及系统恢复事件
 */
import { useEffect, useCallback } from 'react';
import { useConnectionStore } from '../store/useConnectionStore';
import type { SSHSessionState, AppSettings } from '../../shared/types';

interface UseSshEventBindingsOptions {
  appSettings?: AppSettings | null;
  onConnectionStateChange?: (connectionId: string, state: SSHSessionState) => void;
  onConnectionClose?: (connectionId: string) => void;
  updateTabState?: (connectionId: string, state: SSHSessionState) => void;
  handleConnectionClose?: (connectionId: string) => void;
}

/**
 * SSH 事件绑定 Hook
 * 处理所有 SSH 相关的事件监听和系统恢复逻辑
 */
export function useSshEventBindings(options: UseSshEventBindingsOptions = {}) {
  const { appSettings, onConnectionStateChange, onConnectionClose, updateTabState, handleConnectionClose } = options;
  const addTerminalOutput = useConnectionStore(state => state.addTerminalOutput);

  // 初始化事件监听
  useEffect(() => {
    if (!window.electronAPI) return;

    // 监听 SSH 数据
    const cleanupSshData = window.electronAPI.onSshData(({ connectionId, data, type, state }) => {
      if (type === 'state' && state) {
        updateTabState?.(connectionId, state);
        onConnectionStateChange?.(connectionId, state);
        return;
      }

      if (data) {
        addTerminalOutput(connectionId, data);
      }
    });

    // 监听 SSH 错误
    const cleanupSshError = window.electronAPI.onSshError?.(({ connectionId, error }) => {
      addTerminalOutput(connectionId, `\r\n\x1b[31m错误: ${error}\x1b[0m\r\n`);
    });

    // 监听 SSH 关闭
    const cleanupSshClose = window.electronAPI.onSshClose?.((connectionId) => {
      handleConnectionClose?.(connectionId);
      onConnectionClose?.(connectionId);
    });

    // 监听系统从睡眠恢复，检查 SSH 连接状态
    const cleanupSystemResume = (window.electronAPI as any).onSystemResume?.(() => {
      console.log('[SSH Events] System resumed from sleep, checking SSH connections...');
      // 延迟 2 秒后检查连接状态，给网络恢复一些时间
      setTimeout(async () => {
        const result = await window.electronAPI?.sshGetSessions();
        if (result?.success && result.sessions) {
          const activeSessions = new Set(result.sessions.map((s: any) => s.connectionId));
          // 通知上层检查所有已连接的 tab
          console.log('[SSH Events] Active sessions after resume:', activeSessions);
        }
      }, 2000);
    });

    return () => {
      cleanupSshData();
      cleanupSshError?.();
      cleanupSshClose?.();
      cleanupSystemResume?.();
    };
  }, [appSettings, addTerminalOutput, updateTabState, handleConnectionClose, onConnectionStateChange, onConnectionClose]);

  // 返回一个检查会话状态的方法
  const checkSessions = useCallback(async () => {
    const result = await window.electronAPI?.sshGetSessions();
    if (result?.success && result.sessions) {
      return result.sessions;
    }
    return [];
  }, []);

  return { checkSessions };
}

/**
 * 系统恢复后检查连接状态的工具函数
 * 用于外部调用
 */
export async function checkConnectionsAfterResume(
  openTabs: Array<{ id: string; isConnected: boolean }>,
  onUpdateTabs: (updater: (prev: Array<{ id: string; isConnected: boolean }>) => Array<{ id: string; isConnected: boolean }>) => void
) {
  console.log('[SSH Events] Checking connections after system resume...');
  
  setTimeout(async () => {
    const result = await window.electronAPI?.sshGetSessions();
    if (result?.success && result.sessions) {
      const activeSessions = new Set(result.sessions.map((s: any) => s.connectionId));
      // 检查所有已连接的 tab，如果 SSH session 不在了就标记为断开
      onUpdateTabs(prev => prev.map(tab => {
        if (tab.isConnected && !activeSessions.has(tab.id)) {
          return { ...tab, isConnected: false };
        }
        return tab;
      }));
    }
  }, 2000);
}
