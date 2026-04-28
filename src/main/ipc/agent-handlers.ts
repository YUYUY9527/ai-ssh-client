import { ipcMain, BrowserWindow } from 'electron';
import type { ClientChannel } from 'ssh2';
import { IPC_CHANNELS } from '../../shared/constants';
import { sshManager } from '../ssh/connection-manager';
import { checkCommandGuard, logCommandExecution } from '../security';

// 全局智能体状态
interface AgentState {
  currentTaskId: string | null;
  isPaused: boolean;
  pendingCommand: {
    stepId: string;
    command: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
  } | null;
}

let agentState: AgentState = {
  currentTaskId: null,
  isPaused: false,
  pendingCommand: null,
};

export function setupAgentIpcHandlers(mainWindow: BrowserWindow) {
  // 保存每个连接的 agent 监听器引用
  const agentListeners: Map<string, { handler: (data: Buffer) => void; shell: ClientChannel; closeHandler: () => void }> = new Map();
  let activeConnectionId: string | null = null;

  const detachAgentListener = (connectionId: string | null) => {
    if (!connectionId) {
      return;
    }

    const listenerEntry = agentListeners.get(connectionId);
    if (listenerEntry) {
      listenerEntry.shell.removeListener('data', listenerEntry.handler);
      const session = sshManager.getSession(connectionId);
      session?.client.removeListener('close', listenerEntry.closeHandler);
    }
    agentListeners.delete(connectionId);
    if (activeConnectionId === connectionId) {
      activeConnectionId = null;
    }
  };

  // 开始智能体任务
  ipcMain.handle(IPC_CHANNELS.AGENT_START_TASK, async (_event, taskId: string, connectionId: string) => {
    agentState.currentTaskId = taskId;
    agentState.isPaused = false;
    agentState.pendingCommand = null;
    detachAgentListener(activeConnectionId);

    const session = sshManager.getSession(connectionId);
    
    if (session?.shell) {
      // 创建 agent 专用监听器
      const agentHandler = (data: Buffer) => {
        const dataStr = data.toString();
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, {
          connectionId,
          data: dataStr,
        });
      };
      const closeHandler = () => {
        detachAgentListener(connectionId);
      };
      
      // 保存引用并添加监听器
      activeConnectionId = connectionId;
      agentListeners.set(connectionId, { handler: agentHandler, shell: session.shell, closeHandler });
      session.shell.on('data', agentHandler);
      session.client.once('close', closeHandler);
    }

    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP_TASK, async (_event, connectionId: string) => {
    detachAgentListener(connectionId);
    agentState.currentTaskId = null;
    agentState.isPaused = false;
    agentState.pendingCommand = null;
    return { success: true };
  });

  // 暂停智能体任务
  ipcMain.handle(IPC_CHANNELS.AGENT_PAUSE_TASK, async () => {
    agentState.isPaused = true;
    return { success: true };
  });

  // 继续智能体任务
  ipcMain.handle(IPC_CHANNELS.AGENT_RESUME_TASK, async () => {
    agentState.isPaused = false;
    return { success: true };
  });

  // 智能体执行命令
  ipcMain.handle(IPC_CHANNELS.AGENT_EXECUTE_COMMAND, async (_event, connectionId: string, command: string) => {
    try {
      const session = sshManager.getSession(connectionId);
      if (!session?.shell) {
        return { success: false, error: 'Session not found' };
      }

      const guardResult = checkCommandGuard(command);
      if (!guardResult.allowed) {
        console.warn(`[AGENT_EXECUTE_COMMAND] Blocked dangerous command: ${command.substring(0, 50)}...`);
        return {
          success: false,
          error: guardResult.reason || '命令被安全策略阻止',
          riskLevel: guardResult.riskLevel,
        };
      }

      logCommandExecution(connectionId, command, guardResult.riskLevel);
      
      // 执行命令（添加换行符）
      sshManager.executeCommand(connectionId, command + '\n');
      
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // 命令审批响应
  ipcMain.handle(IPC_CHANNELS.AGENT_COMMAND_APPROVAL, async (_event, approved: boolean) => {
    if (agentState.pendingCommand) {
      const command = agentState.pendingCommand;
      agentState.pendingCommand = null;
      
      // 通知渲染进程审批结果
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_COMMAND_APPROVAL, {
        approved,
        command,
      });
      
      return { success: true };
    }
    return { success: false, error: 'No pending command' };
  });
}

// 获取智能体状态
export function getAgentState() {
  return { ...agentState };
}

// 重置智能体状态
export function resetAgentState() {
  agentState = {
    currentTaskId: null,
    isPaused: false,
    pendingCommand: null,
  };
}
