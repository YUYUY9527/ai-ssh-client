import { useEffect, useRef, useCallback } from 'react';
import { useAgentStore } from '../store/useAgentStore';
import { useAIStore } from '../store/useAIStore';
import { useConnectionStore } from '../store/useConnectionStore';
import { AGENT_SYSTEM_PROMPT } from '../../shared/constants';
import type { AgentResponse, Message, ThinkingStep } from '../../shared/types';

// 智能提取终端输出的关键部分
const extractKeyOutput = (output: string, maxLength: number): string => {
  if (output.length <= maxLength) return output;

  const lines = output.split('\n');
  const keyLines: string[] = [];
  let currentLength = 0;

  // 提取错误和警告行
  const errorPatterns = [
    /error/i, /failed/i, /exception/i, /warning/i, /fatal/i,
    /denied/i, /permission/i, /not found/i, /cannot/i, /unable/i,
  ];

  // 提取重要信息行
  const importantPatterns = [/\[.*\]/, /^-{3,}/, /^={3,}/, /^\s*\d+/];

  for (const line of lines) {
    if (currentLength + line.length > maxLength * 0.7) break;
    const isError = errorPatterns.some(p => p.test(line));
    const isImportant = importantPatterns.some(p => p.test(line));
    if (isError || isImportant) {
      keyLines.push(line);
      currentLength += line.length + 1;
    }
  }

  // 包含最后的 N 行
  const lastLines = lines.slice(-20);
  const result = [...new Set([...keyLines, ...lastLines])].join('\n');

  return result.length > maxLength ? '...\n' + result.slice(-maxLength + 10) : result;
};

const stripAnsi = (text: string): string => text
  // OSC sequences like: ESC ] 0;title BEL
  .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
  // CSI / other ANSI sequences
  .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

const normalizeTerminalText = (text: string): string => stripAnsi(text)
  .replace(/\r/g, '\n')
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n');

// 解析 AI 响应中的 JSON
const parseAgentResponse = (content: string): AgentResponse | null => {
  let cleanContent = content.trim();
  
  // 移除开头/结尾引号
  if ((cleanContent.startsWith('"') && cleanContent.endsWith('"')) ||
      (cleanContent.startsWith("'") && cleanContent.endsWith("'"))) {
    cleanContent = cleanContent.slice(1, -1);
  }

  // 尝试直接解析
  try {
    const parsed = JSON.parse(cleanContent);
    if (parsed?.decision) return parsed;
  } catch (e) {}

  // 尝试从代码块中提取
  const patterns = [/```(?:json)?\s*([\s\S]*?)\s*```/, /`([\s\S]*?)`/];
  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed?.decision) return parsed;
      } catch (e) {}
    }
  }

  // 尝试从 { ... } 中提取
  const firstBrace = cleanContent.indexOf('{');
  const lastBrace = cleanContent.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    try {
      const parsed = JSON.parse(cleanContent.slice(firstBrace, lastBrace + 1));
      if (parsed?.decision) return parsed;
    } catch (e) {}
  }

  return null;
};

// 检测终端是否阻塞（等待用户输入）
const detectTerminalBlocking = (output: string): { isBlocking: boolean; prompt: string } => {
  const normalizedOutput = normalizeTerminalText(output);
  const lastLines = normalizedOutput.split('\n').slice(-5).join('\n').toLowerCase();
  const blockingPatterns = [
    // Y/N 确认
    { pattern: /\[y\/n\]/i, prompt: 'Y/N 确认' },
    { pattern: /\[y\]/i, prompt: 'Y 确认' },
    { pattern: /yes\/no/i, prompt: 'Yes/No 确认' },
    { pattern: /\(yes\/no\)/i, prompt: 'Yes/No 确认' },
    { pattern: /\(y\/n\)/i, prompt: 'Y/N 确认' },
    { pattern: /remove regular file.*[?？]/i, prompt: 'rm 删除确认' },
    { pattern: /remove directory.*[?？]/i, prompt: 'rm 目录删除确认' },
    { pattern: /overwrite .*[\?:：]?\s*$/i, prompt: '覆盖确认' },
    { pattern: /是否删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否删除(?:普通|常规)?文件.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /确认删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /确认覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /是否继续.*[?？]/i, prompt: '继续确认' },
    // 密码与密钥
    { pattern: /password:\s*$/i, prompt: '密码输入' },
    { pattern: /passphrase\s*(for|:)/i, prompt: '密钥密码' },
    { pattern: /enter passphrase/i, prompt: '密钥密码' },
    { pattern: /sudo.*password/i, prompt: 'sudo 密码' },
    // 继续/确认
    { pattern: /continue\?/i, prompt: '继续确认' },
    { pattern: /proceed\?/i, prompt: '继续确认' },
    { pattern: /do you want/i, prompt: '操作确认' },
    { pattern: /are you sure/i, prompt: '操作确认' },
    { pattern: /confirm\s*\??/i, prompt: '操作确认' },
    // 包管理器交互
    { pattern: /apt.*\[y\/i\/n\]/i, prompt: 'apt 交互确认' },
    { pattern: /yum.*\[y\/n\]/i, prompt: 'yum 交互确认' },
    { pattern: /dnf.*\[y\/n\]/i, prompt: 'dnf 交互确认' },
    { pattern: /do you want to continue\?/i, prompt: '包管理器确认' },
    // SSH 首次握手
    { pattern: /are you sure you want to continue connecting/i, prompt: 'SSH 首次连接确认' },
    { pattern: /fingerprint.*yes\/no/i, prompt: 'SSH 指纹确认' },
    // 分页器
    { pattern: /:\s*$/m, prompt: '分页器等待' },
    { pattern: /--more--/i, prompt: '分页器等待' },
    { pattern: /\(end\)/i, prompt: '分页器结束' },
    // 编辑器
    { pattern: /vim.*\:$/m, prompt: 'Vim 编辑器等待' },
    { pattern: /nano.*\^G/i, prompt: 'Nano 编辑器等待' },
  ];

  for (const { pattern, prompt } of blockingPatterns) {
    if (pattern.test(lastLines)) {
      return { isBlocking: true, prompt };
    }
  }

  return { isBlocking: false, prompt: '' };
};

const hasShellPrompt = (output: string): boolean => {
  const tail = normalizeTerminalText(output).split('\n').slice(-5).join('\n');
  const promptPatterns = [
    /\]\s*#\s*$/m,
    /\]\s*\$\s*$/m,
    /^.*>\s*$/m,
    /^.*#\s*$/m,
    /^.*\$\s*$/m,
    /\w+@[\w.-]+:\S+#\s*$/m,
    /\w+@[\w.-]+:\S+\$\s*$/m,
    /\[[^\]]+@[^\]]+\][#$]\s*$/m,
  ];

  return promptPatterns.some((pattern) => pattern.test(tail));
};

const isLikelyLongRunningCommand = (command: string): boolean => {
  const normalized = command.toLowerCase();
  const patterns = [
    /\bgit\s+clone\b/,
    /\bnpm\s+(install|ci|update)\b/,
    /\byarn\s+(install|add|upgrade)\b/,
    /\bpnpm\s+(install|add|update)\b/,
    /\bbun\s+install\b/,
    /\bpip(?:3)?\s+install\b/,
    /\buv\s+(pip\s+install|sync)\b/,
    /\bpoetry\s+install\b/,
    /\bcomposer\s+install\b/,
    /\bcargo\s+(build|install|check|test)\b/,
    /\bgo\s+(build|test|get|install)\b/,
    /\bapt(-get)?\s+(install|upgrade|update)\b/,
    /\byum\s+(install|update)\b/,
    /\bdnf\s+(install|update|upgrade)\b/,
    /\bpacman\s+-S\b/,
    /\bbrew\s+(install|upgrade|update)\b/,
    /\b(make|cmake|gradle|mvn|docker\s+build)\b/,
    /\b(wget|curl)\b/,
    /\bscp\b/,
    /\brsync\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

const DUPLICATE_COMMAND_COOLDOWN_MS = 8000;

const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, ' ');

const isSafeRepeatableCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command).toLowerCase();
  const patterns = [
    /^(ls|ll)\b/,
    /^pwd$/,
    /^whoami$/,
    /^id$/,
    /^stat\b/,
    /^test\b/,
    /^find\b/,
    /^cat\b/,
    /^head\b/,
    /^tail\b/,
    /^grep\b/,
    /^du\b/,
    /^df\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

export function AgentExecutor() {
  const {
    currentTask,
    agentState,
    config,
    pendingApproval,
    approvalResult,
    pendingQuestion,
    pendingInput,
    addThinkingStep,
    updateThinkingStep,
    completeTask,
    setPendingApproval,
    setApprovalResult,
    setPendingQuestion,
    setPendingInput,
    setPendingTerminalPrompt,
    trimAgentContext,
    taskHistory,
  } = useAgentStore();

  const { providers, activeProviderId } = useAIStore();
  const { activeConnectionId, executeCommand } = useConnectionStore();

  const terminalOutputRef = useRef<string>('');
  const isProcessingRef = useRef(false);
  const agentMessagesRef = useRef<Message[]>([]);
  const pendingCommandRef = useRef<string | null>(null);
  const stepIdCounter = useRef(0);
  const stepCountRef = useRef(0);
  const lastCommandOutputRef = useRef('');
  const commandExecutionHistoryRef = useRef<Map<string, number>>(new Map());
  const taskVersionRef = useRef(0);
  const initializedTaskIdRef = useRef<string | null>(null);
  const pausedAgentResponseRef = useRef<{
    taskVersion: number;
    thinkStepId: string;
    aiResponse: AgentResponse;
  } | null>(null);
  const agentStateRef = useRef(agentState);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  const generateStepId = useCallback(() => `${Date.now()}-${++stepIdCounter.current}`, []);

  const shouldHaltProgress = useCallback((taskVersion?: number): boolean => {
    if (agentStateRef.current !== 'thinking') {
      return true;
    }
    if (typeof taskVersion === 'number' && taskVersionRef.current !== taskVersion) {
      return true;
    }
    return false;
  }, []);

  const shouldBlockRepeatedCommand = useCallback((command: string): boolean => {
    const normalized = normalizeCommand(command);
    if (!normalized || isSafeRepeatableCommand(normalized)) {
      return false;
    }

    const lastExecutedAt = commandExecutionHistoryRef.current.get(normalized);
    if (!lastExecutedAt) {
      return false;
    }

    return Date.now() - lastExecutedAt < DUPLICATE_COMMAND_COOLDOWN_MS;
  }, []);

  const markCommandExecuted = useCallback((command: string) => {
    const normalized = normalizeCommand(command);
    if (!normalized) {
      return;
    }

    commandExecutionHistoryRef.current.set(normalized, Date.now());

    if (commandExecutionHistoryRef.current.size > 100) {
      const now = Date.now();
      for (const [key, executedAt] of commandExecutionHistoryRef.current.entries()) {
        if (now - executedAt > DUPLICATE_COMMAND_COOLDOWN_MS * 10) {
          commandExecutionHistoryRef.current.delete(key);
        }
      }
    }
  }, []);

  const notifyTaskCompletion = useCallback(async (success: boolean, reason: string) => {
    if (!window.electronAPI) {
      return;
    }

    const settingsResult = await window.electronAPI.getSettings();
    if (!settingsResult.success || !settingsResult.data.settings.commandNotifications) {
      return;
    }

    const title = success ? 'AI 任务执行完成' : 'AI 任务执行失败';
    const body = reason.trim() || (success ? '任务完成' : '任务失败');
    await window.electronAPI.showSystemNotification(title, body, {
      onlyWhenAppInBackground: true,
    });
  }, []);

  // 监听终端输出（本地累积 fullOutput，避免 IPC 传输二次增长）
  const localFullOutputRef = useRef<string>('');
  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanup = window.electronAPI.onAgentTerminalOutput?.((data) => {
      if (data.connectionId === activeConnectionId) {
        // 本地累积完整输出
        localFullOutputRef.current += data.data;
        terminalOutputRef.current = localFullOutputRef.current;
      }
    });
    return () => cleanup?.();
  }, [activeConnectionId]);

  // 调用 AI
  const callAgentAI = useCallback(async (userInput: string, lastOutput: string = ''): Promise<AgentResponse | null> => {
    if (!window.electronAPI || !activeProviderId) return null;
    const provider = providers.find(p => p.id === activeProviderId);
    if (!provider) return null;

    const executedCommands: string[] = [];
    for (const msg of agentMessagesRef.current) {
      if (msg.role === 'assistant') {
        try {
          const parsed = parseAgentResponse(msg.content);
          if (parsed?.command) executedCommands.push(parsed.command);
        } catch (e) {}
      }
    }

    const messages: Message[] = [
      { id: 'system', role: 'system', content: AGENT_SYSTEM_PROMPT, timestamp: Date.now() },
      ...agentMessagesRef.current,
    ];

    // 添加历史任务上下文（任务联动）
    const taskContextRounds = config.taskContextRounds ?? 3;
    if (taskContextRounds > 0 && taskHistory.length > 0) {
      const recentTasks = taskHistory
        .filter(task => task.state === 'finished' || task.state === 'error')
        .slice(0, taskContextRounds);

      if (recentTasks.length > 0) {
        const taskContext = recentTasks.map((task, index) => {
          const executedCmds = task.executions
            .filter(e => e.success)
            .map(e => e.command)
            .join(', ');
          return `**任务 ${index + 1}**：${task.userInput}
状态：${task.state === 'finished' ? '已完成' : '失败'}
${executedCmds ? `执行命令：${executedCmds}` : ''}
${task.finishReason ? `结果：${task.finishReason}` : ''}`;
        }).join('\n\n');

        messages.push({
          id: `task-context-${Date.now()}`,
          role: 'system',
          content: `**历史任务上下文**（最近 ${recentTasks.length} 轮）：\n\n${taskContext}`,
          timestamp: Date.now(),
        });
      }
    }

    let userMessageContent = `用户任务：${userInput}`;
    if (executedCommands.length > 0) {
      userMessageContent += `\n\n⚠️ **已执行的命令（不要重复）**：\n${executedCommands.map((cmd, i) => `${i + 1}. \`${cmd}\``).join('\n')}`;
    }
    if (lastOutput) {
      const maxLength = config.maxTerminalOutputLength ?? 8000;
      const extractedOutput = maxLength === 0 ? lastOutput : extractKeyOutput(lastOutput, maxLength);
      userMessageContent += `\n\n**最新命令的终端输出**：\n\`\`\`\n${extractedOutput}\n\`\`\``;
    }

    messages.push({
      id: Date.now().toString(),
      role: 'user',
      content: userMessageContent,
      timestamp: Date.now(),
    });

    try {
      const result = await window.electronAPI.aiChat(activeProviderId, messages);
      if (result.success && result.data) {
        const parsed = parseAgentResponse(result.data.content);
        if (parsed) {
          agentMessagesRef.current.push(
            { id: (Date.now() - 1).toString(), role: 'user', content: userMessageContent, timestamp: Date.now() - 1 },
            { id: Date.now().toString(), role: 'assistant', content: result.data.content, timestamp: Date.now() }
          );
          // 裁剪上下文
          const maxMessages = config.maxContextMessages || 20;
          if (agentMessagesRef.current.length > maxMessages * 1.5) {
            agentMessagesRef.current = agentMessagesRef.current.slice(-(maxMessages * 2));
            trimAgentContext();
          }
          return parsed;
        }
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : '未知错误';
      addThinkingStep({
        id: generateStepId(),
        type: 'understanding',
        title: 'AI 调用失败',
        content: `AI 请求失败：${errMessage}`,
        timestamp: Date.now(),
        status: 'failed',
      });
    }
    return null;
  }, [activeProviderId, providers, config, trimAgentContext, taskHistory, addThinkingStep, generateStepId]);

  // 执行命令并等待输出
  const executeCommandAndWait = useCallback(async (command: string, execStepId: string): Promise<string> => {
    // 清空本地输出引用（重要：避免累积旧输出）
    terminalOutputRef.current = '';

    try {
      if (window.electronAPI) {
        await window.electronAPI.agentExecuteCommand(activeConnectionId!, command);
      } else {
        executeCommand(command);
      }

      const commandSentTime = Date.now();
      const isLongRunningCommand = isLikelyLongRunningCommand(command);

      // 等待输出
      await new Promise<void>((resolve) => {
        let lastCheckLength = 0;
        let lastGrowTime = Date.now(); // 最后一次输出增长的时间
        const minWaitMs = isLongRunningCommand ? 10000 : 3000;
        const maxWaitMs = isLongRunningCommand ? 300000 : 20000;
        const noGrowthTimeoutMs = isLongRunningCommand ? 15000 : 2000;

        const checkOutput = () => {
          const currentOutput = terminalOutputRef.current;
          const blocking = detectTerminalBlocking(currentOutput);

          if (blocking.isBlocking) {
            resolve();
            return;
          }

          const hasSeenPrompt = currentOutput.length > 0 && hasShellPrompt(currentOutput);

          // 检测输出增长
          if (currentOutput.length > lastCheckLength) {
            lastGrowTime = Date.now();
            lastCheckLength = currentOutput.length;
          }

          const elapsed = Date.now() - commandSentTime;
          const timeSinceLastGrowth = Date.now() - lastGrowTime;
          const hasEnoughOutput = currentOutput.length > 100;

          // 停止条件：
          // 1. 看到提示符且等待超过 1 秒且输出停止增长超过 1 秒
          // 2. 输出停止增长超过 2 秒且总时间超过最小等待时间且输出足够
          // 3. 达到最大等待时间
          const canStopByPrompt = hasSeenPrompt && timeSinceLastGrowth > 1000;
          const canStopByNoGrowth = !isLongRunningCommand
            && timeSinceLastGrowth > noGrowthTimeoutMs
            && elapsed > minWaitMs
            && hasEnoughOutput;
          const canStopByTimeout = elapsed > maxWaitMs;
          const shouldStop = canStopByPrompt || canStopByNoGrowth || canStopByTimeout;

          if (shouldStop) {
            resolve();
            return;
          }

          setTimeout(checkOutput, 200);
        };

        setTimeout(checkOutput, 200);
      });

      lastCommandOutputRef.current = terminalOutputRef.current;

      // 检测阻塞
      const blocking = detectTerminalBlocking(lastCommandOutputRef.current);
      if (blocking.isBlocking) {
        setPendingTerminalPrompt(blocking.prompt);
        const blockStepId = generateStepId();
        addThinkingStep({
          id: blockStepId,
          type: 'observation',
          title: '终端等待输入',
          content: `⚠️ 检测到终端正在等待输入：${blocking.prompt}\n\n请在终端中手动输入继续...`,
          timestamp: Date.now(),
          status: 'in_progress',
        });

        // 等待用户处理
        await new Promise<void>((resolve) => {
          let pollCount = 0;
          const pollForUnblock = () => {
            if (agentState === 'finished') {
              resolve();
              return;
            }
            const currentOutput = terminalOutputRef.current;
            const blocking = detectTerminalBlocking(currentOutput);
            if (!blocking.isBlocking || currentOutput.length > lastCommandOutputRef.current.length + 5) {
              lastCommandOutputRef.current = currentOutput;
              resolve();
              return;
            }
            pollCount++;
            if (pollCount >= 120) {
              resolve();
              return;
            }
            setTimeout(pollForUnblock, 500);
          };
          setTimeout(pollForUnblock, 500);
        });

        setPendingTerminalPrompt(null);
        updateThinkingStep(blockStepId, { status: 'completed' });
      }

      return lastCommandOutputRef.current;
    } catch (error) {
      updateThinkingStep(execStepId, {
        status: 'failed',
        content: `命令执行失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
      return terminalOutputRef.current;
    }
  }, [activeConnectionId, executeCommand, generateStepId, addThinkingStep, updateThinkingStep, agentState, setPendingTerminalPrompt]);

  const finishTask = useCallback((success: boolean, reason: string) => {
    isProcessingRef.current = false;
    pausedAgentResponseRef.current = null;
    void notifyTaskCompletion(success, reason);
    completeTask(success, success ? undefined : reason, success ? reason : undefined);
  }, [completeTask, notifyTaskCompletion]);

  const runAgentLoop = useCallback(async () => {
    if (!currentTask || !activeConnectionId || !activeProviderId) return;
    if (shouldHaltProgress()) return;
    if (isProcessingRef.current) return;
    if (stepCountRef.current >= (config.maxExecutionSteps || 10)) {
      finishTask(false, '超过最大执行步数限制');
      return;
    }

    isProcessingRef.current = true;
    const myTaskVersion = taskVersionRef.current;

    try {
      let thinkStepId: string;
      let aiResponse: AgentResponse | null;
      const pausedResponse = pausedAgentResponseRef.current;

      if (pausedResponse && pausedResponse.taskVersion === myTaskVersion) {
        thinkStepId = pausedResponse.thinkStepId;
        aiResponse = pausedResponse.aiResponse;
        pausedAgentResponseRef.current = null;
      } else {
        stepCountRef.current += 1;
        thinkStepId = generateStepId();
        addThinkingStep({
          id: thinkStepId,
          type: 'understanding',
          title: stepCountRef.current === 1 ? '思考过程' : `第 ${stepCountRef.current} 步：分析决策`,
          content: '正在分析当前状态并决定下一步操作...',
          timestamp: Date.now(),
          status: 'in_progress',
        });

        aiResponse = await callAgentAI(currentTask.userInput, lastCommandOutputRef.current);

        if (aiResponse && shouldHaltProgress(myTaskVersion)) {
          pausedAgentResponseRef.current = {
            taskVersion: myTaskVersion,
            thinkStepId,
            aiResponse,
          };
          isProcessingRef.current = false;
          return;
        }

        if (shouldHaltProgress(myTaskVersion)) {
          isProcessingRef.current = false;
          return;
        }
      }

      if (!aiResponse) {
        updateThinkingStep(thinkStepId, { status: 'failed', content: '无法解析 AI 响应' });
        finishTask(false, 'AI 响应无效');
        return;
      }

      updateThinkingStep(thinkStepId, {
        status: 'completed',
        content: aiResponse.thought.reasoning,
      });

      if (aiResponse.decision === 'finish') {
        finishTask(true, aiResponse.finishReason || '任务完成');
        return;
      }

      if (aiResponse.decision === 'ask') {
        setPendingQuestion(aiResponse.question || '需要更多信息');
        isProcessingRef.current = false;
        return;
      }

      const command = aiResponse.command?.trim();
      if (!command) {
        finishTask(false, 'AI 未提供可执行命令');
        return;
      }

      if (shouldBlockRepeatedCommand(command)) {
        finishTask(false, `检测到重复命令，已阻止执行：${command}`);
        return;
      }

      pendingCommandRef.current = command;
      const risk = useAIStore.getState().analyzeCommand(command);
      const needsApproval = risk.riskLevel === 'critical'
        || (risk.riskLevel === 'high' && config.approveHighRisk !== false)
        || (risk.riskLevel === 'medium' && config.approveMediumRisk !== false);

      if (needsApproval) {
        setPendingApproval({ command, riskLevel: risk.riskLevel });
        isProcessingRef.current = false;
        return;
      }

      const execStepId = generateStepId();
      addThinkingStep({
        id: execStepId,
        type: 'execution',
        title: `执行命令：${command}`,
        content: command,
        timestamp: Date.now(),
        status: 'in_progress',
      });

      markCommandExecuted(command);
      const output = await executeCommandAndWait(command, execStepId);
      if (shouldHaltProgress(myTaskVersion)) {
        updateThinkingStep(execStepId, { status: 'completed', content: `${command}\n\n${extractKeyOutput(output, 1500)}` });
        isProcessingRef.current = false;
        return;
      }
      updateThinkingStep(execStepId, { status: 'completed', content: `${command}\n\n${extractKeyOutput(output, 1500)}` });

      isProcessingRef.current = false;
      setTimeout(() => {
        if (!shouldHaltProgress(myTaskVersion)) {
          runAgentLoop();
        }
      }, 100);
    } catch (error) {
      isProcessingRef.current = false;
      finishTask(false, error instanceof Error ? error.message : '智能体执行失败');
    }
  }, [
    currentTask,
    activeConnectionId,
    activeProviderId,
    config.maxExecutionSteps,
    config.approveHighRisk,
    config.approveMediumRisk,
    generateStepId,
    addThinkingStep,
    updateThinkingStep,
    finishTask,
    callAgentAI,
    executeCommandAndWait,
    setPendingApproval,
    setPendingQuestion,
    shouldBlockRepeatedCommand,
    markCommandExecuted,
    shouldHaltProgress,
  ]);

  useEffect(() => {
    if (!currentTask || !activeConnectionId || agentState !== 'thinking') return;

    const isNewTask = initializedTaskIdRef.current !== currentTask.id;

      if (isNewTask) {
        initializedTaskIdRef.current = currentTask.id;
        taskVersionRef.current += 1;
        stepCountRef.current = 0;
        pausedAgentResponseRef.current = null;
        lastCommandOutputRef.current = '';
        terminalOutputRef.current = '';
        localFullOutputRef.current = '';
      agentMessagesRef.current = [];
      commandExecutionHistoryRef.current.clear();

      if (window.electronAPI) {
        window.electronAPI.agentStartTask(currentTask.id, activeConnectionId).then(() => {
          runAgentLoop();
        });
      } else {
        runAgentLoop();
      }
      return;
    }

    if (!isProcessingRef.current && !pendingApproval && !pendingQuestion) {
      runAgentLoop();
    }
  }, [currentTask?.id, activeConnectionId, agentState, pendingApproval, pendingQuestion, runAgentLoop]);

  useEffect(() => {
    if (!pendingApproval || approvalResult == null) return;

    const command = pendingApproval.command;
    const currentVersion = taskVersionRef.current;

    if (approvalResult === 'approved') {
      isProcessingRef.current = true;
      setApprovalResult(null);
      setPendingApproval(null);

      const execStepId = generateStepId();
      addThinkingStep({
        id: execStepId,
        type: 'execution',
        title: `执行已批准命令：${command}`,
        content: command,
        timestamp: Date.now(),
        status: 'in_progress',
      });

      markCommandExecuted(command);
      executeCommandAndWait(command, execStepId).then((output) => {
        updateThinkingStep(execStepId, { status: 'completed', content: `${command}\n\n${extractKeyOutput(output, 1500)}` });
        isProcessingRef.current = false;
        setTimeout(() => {
          if (!shouldHaltProgress(currentVersion)) {
            runAgentLoop();
          }
        }, 100);
      }).catch((error) => {
        isProcessingRef.current = false;
        finishTask(false, error instanceof Error ? error.message : '审批后的命令执行失败');
      });
      return;
    }

    if (approvalResult === 'rejected') {
      setApprovalResult(null);
      setPendingApproval(null);
      finishTask(false, '用户拒绝执行命令');
    }
  }, [approvalResult, pendingApproval, setApprovalResult, setPendingApproval, generateStepId, addThinkingStep, executeCommandAndWait, updateThinkingStep, runAgentLoop, finishTask, markCommandExecuted, shouldHaltProgress]);

  useEffect(() => {
    if (!pendingQuestion || !pendingInput) return;

    agentMessagesRef.current.push(
      { id: Date.now().toString(), role: 'user', content: `用户补充信息：${pendingInput}`, timestamp: Date.now() }
    );
    setPendingInput('');
    setPendingQuestion(null);

    const currentVersion = taskVersionRef.current;
    setTimeout(() => {
      if (!shouldHaltProgress(currentVersion)) {
        runAgentLoop();
      }
    }, 100);
  }, [pendingQuestion, pendingInput, setPendingInput, setPendingQuestion, runAgentLoop, shouldHaltProgress]);

  return null;
}
