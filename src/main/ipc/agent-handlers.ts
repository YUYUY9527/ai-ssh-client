import { ipcMain, BrowserWindow } from 'electron';
import type { ClientChannel } from 'ssh2';
import { IPC_CHANNELS } from '../../shared/constants';
import { sshManager } from '../ssh/connection-manager';
import { checkCommandGuard, logCommandExecution } from '../security';
import type { IPCResult, AgentExecAwaitResult } from '../../shared/ipc-types';
import { createSentinelStripper } from '../utils/sentinel-stripper';

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

// 进行中的 sentinel 等待器（按 connectionId 保存，一次只允许一个）
interface PendingExecWait {
  runId: string;
  sentinelPattern: RegExp;
  buffer: string;
  resolve: (result: AgentExecAwaitResult) => void;
  timeout: NodeJS.Timeout;
  detach: () => void;
}
const pendingWaits: Map<string, PendingExecWait> = new Map();

const SENTINEL_PREFIX = '__AGENT_DONE_';
const DEFAULT_EXEC_TIMEOUT_MS = 20 * 60 * 1000; // 20 分钟硬上限

function makeSentinelMarker(runId: string) {
  return `${SENTINEL_PREFIX}${runId}__`;
}

function makeSentinelPattern(runId: string): RegExp {
  const marker = makeSentinelMarker(runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 匹配 "__AGENT_DONE_<runId>__:<exitCode>"，允许前后有回车换行
  return new RegExp(`${marker}:(-?\\d+)`);
}

function wrapCommandWithSentinel(command: string, runId: string): string {
  const marker = makeSentinelMarker(runId);
  const trimmed = command.replace(/[\r\n]+$/, '');

  // 判断命令是否包含多行结构（heredoc、多行脚本等）
  // 这些结构不能用 `(cmd)` 子 shell 包裹，否则 heredoc 结束标记会被破坏
  const isMultiLine = trimmed.includes('\n');
  const hasHeredoc = /<<[-~]?\s*['"]?\w+['"]?/.test(trimmed);

  if (isMultiLine || hasHeredoc) {
    // 多行命令：在命令后追加 sentinel，用换行分隔
    // 使用临时变量保存退出码，避免 printf 本身的退出码覆盖
    return `${trimmed}\n__ais_ec=$?; printf '\\n${marker}:%s\\n' "$__ais_ec"\n`;
  }

  // 单行命令：用子 shell 包裹确保 $? 准确
  return `(${trimmed}); printf '\\n${marker}:%s\\n' "$?"\n`;
}

function finishPendingWait(connectionId: string, result: AgentExecAwaitResult) {
  const pending = pendingWaits.get(connectionId);
  if (!pending) return;
  pendingWaits.delete(connectionId);
  clearTimeout(pending.timeout);
  pending.detach();
  pending.resolve(result);
}

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

    // 清理该连接上的 sentinel 等待
    finishPendingWait(connectionId, { output: '', exitCode: null, reason: 'closed' });
  };

  // 开始智能体任务
  ipcMain.handle(IPC_CHANNELS.AGENT_START_TASK, async (_event, taskId: string, connectionId: string) => {
    agentState.currentTaskId = taskId;
    agentState.isPaused = false;
    agentState.pendingCommand = null;
    detachAgentListener(activeConnectionId);

    const session = sshManager.getSession(connectionId);

    if (session?.shell) {
      const stripper = createSentinelStripper((delayedData) => {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, {
          connectionId,
          data: delayedData,
        });
      });
      // 创建 agent 专用监听器
      const agentHandler = (data: Buffer) => {
        const clean = stripper.feed(data.toString());
        if (!clean) return;
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, {
          connectionId,
          data: clean,
        });
      };
      const closeHandler = () => {
        const tail = stripper.flush();
        if (tail) {
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_TERMINAL_OUTPUT, {
            connectionId,
            data: tail,
          });
        }
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

  // 智能体执行命令（无等待，兼容旧路径）
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

  // 智能体执行命令 + 等待 sentinel（可靠完成信号）
  ipcMain.handle(
    IPC_CHANNELS.AGENT_EXEC_AWAIT,
    async (
      _event,
      connectionId: string,
      command: string,
      options?: { runId?: string; timeoutMs?: number },
    ): Promise<IPCResult<AgentExecAwaitResult>> => {
      try {
        const session = sshManager.getSession(connectionId);
        if (!session?.shell) {
          return { success: false, error: 'Session not found' };
        }

        const guardResult = checkCommandGuard(command);
        if (!guardResult.allowed) {
          console.warn(`[AGENT_EXEC_AWAIT] Blocked dangerous command: ${command.substring(0, 50)}...`);
          return {
            success: false,
            error: guardResult.reason || '命令被安全策略阻止',
          };
        }

        logCommandExecution(connectionId, command, guardResult.riskLevel);

        // 如果已有等待，先以 canceled 结束旧的
        if (pendingWaits.has(connectionId)) {
          finishPendingWait(connectionId, { output: '', exitCode: null, reason: 'canceled' });
        }

        const runId = options?.runId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = Math.max(1000, options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
        const sentinelPattern = makeSentinelPattern(runId);
        const shell = session.shell;

        const result = await new Promise<AgentExecAwaitResult>((resolve) => {
          const dataHandler = (buf: Buffer) => {
            const pending = pendingWaits.get(connectionId);
            if (!pending) return;
            pending.buffer += buf.toString();
            // 限制缓冲区大小，防止 OOM
            if (pending.buffer.length > 1024 * 1024) {
              pending.buffer = pending.buffer.slice(-768 * 1024);
            }
            const match = pending.sentinelPattern.exec(pending.buffer);
            if (match) {
              const exitCode = Number.parseInt(match[1], 10);
              // 剪掉 sentinel 行及其之后
              const sentinelIndex = pending.buffer.indexOf(match[0]);
              const output = sentinelIndex >= 0 ? pending.buffer.slice(0, sentinelIndex) : pending.buffer;
              finishPendingWait(connectionId, {
                output,
                exitCode: Number.isFinite(exitCode) ? exitCode : null,
                reason: 'done',
              });
            }
          };

          const closeHandler = () => {
            finishPendingWait(connectionId, { output: '', exitCode: null, reason: 'closed' });
          };

          const detach = () => {
            shell.removeListener('data', dataHandler);
            session.client.removeListener('close', closeHandler);
          };

          shell.on('data', dataHandler);
          session.client.once('close', closeHandler);

          const timeout = setTimeout(() => {
            const pending = pendingWaits.get(connectionId);
            if (!pending || pending.runId !== runId) return;
            finishPendingWait(connectionId, {
              output: pending.buffer,
              exitCode: null,
              reason: 'timeout',
            });
          }, timeoutMs);

          pendingWaits.set(connectionId, {
            runId,
            sentinelPattern,
            buffer: '',
            resolve,
            timeout,
            detach,
          });

          // 写入带 sentinel 的命令（最后这一步可能抛错，此时手动 finish）
          try {
            sshManager.executeCommand(connectionId, wrapCommandWithSentinel(command, runId));
          } catch (error) {
            finishPendingWait(connectionId, {
              output: '',
              exitCode: null,
              reason: 'closed',
            });
          }
        });

        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );

  // 主动取消正在进行的 sentinel 等待（保留已经到达的输出）
  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL_EXEC, async (_event, connectionId: string) => {
    const pending = pendingWaits.get(connectionId);
    if (!pending) {
      return { success: false, error: 'No pending exec' };
    }
    finishPendingWait(connectionId, {
      output: pending.buffer,
      exitCode: null,
      reason: 'canceled',
    });
    return { success: true };
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
