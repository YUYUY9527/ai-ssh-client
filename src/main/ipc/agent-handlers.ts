import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { sshManager } from '../ssh/connection-manager';

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
  const agentListeners: Map<string, (data: Buffer) => void> = new Map();

  // 开始智能体任务
  ipcMain.handle(IPC_CHANNELS.AGENT_START_TASK, async (_event, taskId: string, connectionId: string) => {
    agentState.currentTaskId = taskId;
    agentState.isPaused = false;
    agentState.pendingCommand = null;

    const session = sshManager.getSession(connectionId);
    
    if (session?.shell) {
      // 清空缓冲区
      session.outputBuffer = '';
      
      // 先移除旧的监听器（防止重复）
      const oldHandler = agentListeners.get(connectionId);
      if (oldHandler) {
        session.shell.removeListener('data', oldHandler);
      }
      
      // 创建 agent 专用监听器
      const agentHandler = (data: Buffer) => {
        const dataStr = data.toString();
        session.outputBuffer += dataStr;
        
        // 只发送增量数据，不发送完整累积输出（避免二次增长传输）
        // 渲染进程的 AgentExecutor 会自行累积 fullOutput
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, {
          connectionId,
          data: dataStr,
        });
      };
      
      // 保存引用并添加监听器
      agentListeners.set(connectionId, agentHandler);
      session.shell.on('data', agentHandler);
    }

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

      // 清空缓冲区，准备接收新命令的输出
      session.outputBuffer = '';
      
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
