import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

import {
  DEFAULT_CWD,
  nextTrackedCwd,
  normalizeHistoryPath,
} from '../../history/command-history-index';
import { recordSessionCommand } from '../../history/session-command-buffer';
import { useSessionStore } from '../useSessionStore';
import {
  isShellPromptReadyForAgent,
  parseTerminalAgentPaste,
  resolveTerminalAgentLineAction,
  type TerminalAgentReplyMode,
} from '../../agent/terminal-agent-chat';
import {
  extractCwdFromTerminalOutput,
  shouldReplaceCwd,
  stripTerminalControlSequences,
} from './terminal-cwd';
import { trackPastedInput } from './paste-safety';
import {
  getBroadcastTargetConnectionIds,
  isTerminalBroadcastEnabled,
} from './terminal-broadcast';
import {
  isPromptLineReady,
  readLogicalBufferLine,
  resolveSubmittedInput,
  stripPromptPrefix,
} from './terminal-input-line';

function tailText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(-maxChars);
}

/**
 * xterm 对 OSC/CSI 查询的自动应答（回放挂起期间应丢弃，防 PTY 回显死循环）。
 *
 * 只匹配真正的应答报文，绝不能像早期实现那样"凡是 ESC 开头就丢"——
 * 用户的 ↑↓←→、Home/End、F 键、Alt+字母同样是 \x1b 开头，误丢会让全屏程序里
 * 方向键短暂失灵（SUSPEND_INPUT_FORWARD_TIMEOUT_MS 最多 1.5s）。
 */
const XTERM_AUTO_REPLY_PATTERNS: readonly RegExp[] = [
  /^\x1b\[\??[\d;]*[cnR]$/, // DA1/DA2 设备属性应答、DSR 光标位置应答
  /^\x1b\[[?>][\d;]*[cn]$/, // 私有设备属性应答
  /^\x1b\[\?[\d;]*\$y$/, // DECRPM 模式报告应答
  /^\x1b\[[IO]$/, // 焦点进入 / 离开
  /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)$/, // OSC 应答
  /^\x1bP[^\x1b]*\x1b\\$/, // DCS 应答
];

export function isXtermAutoReply(data: string): boolean {
  if (!data || data.charCodeAt(0) !== 0x1b) {
    return false;
  }
  return XTERM_AUTO_REPLY_PATTERNS.some((pattern) => pattern.test(data));
}

function parsePromptCommand(line: string): string | null {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return null;
  }

  const bracketMatch = trimmed.match(/^\[[^\]]+\][#$]\s+(.+)$/);
  if (bracketMatch) {
    return bracketMatch[1].trim();
  }

  const colonMatch = trimmed.match(/^[^\s@]+@[^\s:]+:[^\s]+[#$]\s+(.+)$/);
  if (colonMatch) {
    return colonMatch[1].trim();
  }

  const shMatch = trimmed.match(/^(?:ba)?sh-[^\s]+[#$]\s+(.+)$/);
  if (shMatch) {
    return shMatch[1].trim();
  }

  return null;
}

function extractCommandFromTerminalOutput(output: string): string | null {
  const normalized = stripTerminalControlSequences(tailText(output, 4096)).replace(/\r/g, '\n');
  const lines = normalized
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(-8)
    .reverse();

  for (const line of lines) {
    const command = parsePromptCommand(line);
    if (command) {
      return command;
    }
  }

  return null;
}

interface TerminalInputTrackingOptions {
  liveConnectionId: string | null;
  onAgentInput?: (text: string) => void;
  getAgentReplyMode?: () => TerminalAgentReplyMode | null;
  shouldForceAgentPrefix?: () => boolean;
  onExitAgentFollowUp?: () => void;
  syncAlternateScreenState: () => boolean | undefined;
  terminalInstanceVersion: number;
  xtermRef: RefObject<XTerm | null>;
}

/** Tracks user input, cwd hints and command history writes for one terminal instance. */
export function useTerminalInputTracking({
  liveConnectionId,
  onAgentInput,
  getAgentReplyMode,
  shouldForceAgentPrefix,
  onExitAgentFollowUp,
  syncAlternateScreenState,
  terminalInstanceVersion,
  xtermRef,
}: TerminalInputTrackingOptions) {
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const onAgentInputRef = useRef(onAgentInput);
  const getAgentReplyModeRef = useRef(getAgentReplyMode);
  const shouldForceAgentPrefixRef = useRef(shouldForceAgentPrefix);
  const onExitAgentFollowUpRef = useRef(onExitAgentFollowUp);
  const inputTrackingReliableRef = useRef(true);
  const currentInputRef = useRef('');
  const cwdRef = useRef(DEFAULT_CWD);
  const outputTailRef = useRef('');
  /** >0 时不向 SSH 转发 onData（全量回放会重放 OSC 查询应答，导致死循环刷屏） */
  const suspendInputForwardRef = useRef(0);
  /** 挂起世代：超时强制恢复时避免误伤新一轮挂起 */
  const suspendGenerationRef = useRef(0);
  const suspendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 回放 write 回调偶发不触发时的最长挂起（ms） */
  const SUSPEND_INPUT_FORWARD_TIMEOUT_MS = 1500;

  const syncSessionCwd = useCallback((cwd: string) => {
    if (!liveConnectionId) {
      return;
    }
    const normalized = normalizeHistoryPath(cwd);
    // 禁止用 ~/x 覆盖 /abs/x，否则打开 SFTP 时按登录家目录展开 ~ 会偏到错误位置
    if (!shouldReplaceCwd(cwdRef.current, normalized)) {
      return;
    }
    cwdRef.current = normalized;
    useSessionStore.getState().setSessionCwd(liveConnectionId, normalized);
  }, [liveConnectionId]);

  const resetInputTracking = useCallback(() => {
    inputTrackingReliableRef.current = true;
    currentInputRef.current = '';
    const sessionCwd = liveConnectionId
      ? useSessionStore.getState().sessions[liveConnectionId]?.cwd
      : undefined;
    cwdRef.current = normalizeHistoryPath(sessionCwd || DEFAULT_CWD);
    outputTailRef.current = '';
  }, [liveConnectionId]);

  useEffect(() => {
    onAgentInputRef.current = onAgentInput;
    getAgentReplyModeRef.current = getAgentReplyMode;
    shouldForceAgentPrefixRef.current = shouldForceAgentPrefix;
    onExitAgentFollowUpRef.current = onExitAgentFollowUp;
  }, [getAgentReplyMode, onAgentInput, onExitAgentFollowUp, shouldForceAgentPrefix]);

  const consumeOutputChunk = useCallback((chunk: string) => {
    outputTailRef.current = tailText(`${outputTailRef.current}${chunk}`, 4096);
    const detectedCwd = extractCwdFromTerminalOutput(outputTailRef.current);
    if (detectedCwd) {
      syncSessionCwd(detectedCwd);
    }
  }, [syncSessionCwd]);

  useEffect(() => {
    if (liveConnectionId) {
      const sessionCwd = useSessionStore.getState().sessions[liveConnectionId]?.cwd;
      cwdRef.current = normalizeHistoryPath(sessionCwd || DEFAULT_CWD);
    } else {
      cwdRef.current = DEFAULT_CWD;
    }
  }, [liveConnectionId]);

  /** 强制恢复输入转发（连接切换 / 超时 / 实例重建）。 */
  const forceResumeInputForward = useCallback(() => {
    suspendInputForwardRef.current = 0;
    suspendGenerationRef.current += 1;
    if (suspendTimeoutRef.current) {
      clearTimeout(suspendTimeoutRef.current);
      suspendTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    // 每次绑定前先卸旧监听，避免 early-return 丢 cleanup 或闭包过期
    if (onDataDisposableRef.current) {
      onDataDisposableRef.current.dispose();
      onDataDisposableRef.current = null;
    }

    if (!xtermRef.current || !liveConnectionId) {
      forceResumeInputForward();
      return;
    }

    const term = xtermRef.current;
    const connectionId = liveConnectionId;
    /** 光标所在**逻辑行**（折行已拼回）的原始内容，含提示符与正在输入的部分。 */
    const readLogicalLine = (): string => {
      const activeBuffer = term.buffer.active;
      return readLogicalBufferLine(
        (index) => activeBuffer.getLine(index),
        activeBuffer.cursorY,
      );
    };

    /**
     * 光标是否停在 shell 提示符上。
     *
     * 折行后光标所在视觉行只有输入的尾段，必须先拼回逻辑行再判定；否则长输入
     * （粘贴或键入）会被当成「不在提示符上」，`@ai` 行会被误发给远端 shell。
     */
    const isAgentPromptReady = () => {
      const logicalLine = readLogicalLine();
      if (isShellPromptReadyForAgent(logicalLine, currentInputRef.current)) {
        return true;
      }
      // 本地追踪不可用（粘贴未记录等）时退化为「行首能否识别出提示符」
      return isPromptLineReady(logicalLine);
    };

    /**
     * 回车时真正提交的内容。
     *
     * 追踪可靠（正在键入）时以追踪为准，仅在屏幕内容与其互为前后缀时补全
     * （粘贴、折行、历史召回）；追踪失效时才退回输出尾部解析。
     * 注意：空行回车必须保持为空，否则会把上一条命令当成新输入提交。
     */
    const resolveEnteredCommand = (): string => {
      const logicalLine = readLogicalLine().replace(/\s+$/, '');
      const stripped = stripPromptPrefix(logicalLine);
      const screenInput = stripped.matched ? stripped.text.trim() : '';
      if (inputTrackingReliableRef.current) {
        return resolveSubmittedInput(currentInputRef.current, screenInput);
      }
      return screenInput
        || extractCommandFromTerminalOutput(outputTailRef.current)
        || currentInputRef.current.trim();
    };

    const onDataDisposable = term.onData((data: string) => {
      // 先判断是否处于全屏程序（vim/nano）：下面 \x16(^V) 的吞键只针对普通 shell，
      // 全屏程序里 ^V 是它自己的命令，必须原样转发。
      const inAlternateScreen = syncAlternateScreenState();

      if (data === '\x16' && !inAlternateScreen) {
        return;
      }

      // 回放/重建 buffer 期间产生的查询应答不得写回 PTY
      if (suspendInputForwardRef.current > 0) {
        // 挂起只拦截 xterm 的 OSC/CSI 自动应答：回放历史内容时这些应答若写回
        // PTY 会被 echo 再次回放，形成刷屏死循环（典型：无限刷 11;rgb:...）。
        // 用户真实按键（可打印字符/回车/退格/制表符等）不在拦截范围，
        // 避免“连接成功后首屏回放期间敲命令没反应”。
        if (isXtermAutoReply(data)) {
          return;
        }
      }

      // 命令广播：把这一笔用户按键同步到当前分屏可见的其它终端。
      // 放在自动应答拦截之后，避免把 xterm 的重放应答广播出去。
      if (isTerminalBroadcastEnabled() && data) {
        for (const target of getBroadcastTargetConnectionIds(connectionId)) {
          try {
            window.electronAPI?.sshExecuteSync(target, data);
          } catch (error) {
            console.warn('broadcast sshExecuteSync failed', error);
          }
        }
      }

      if (inAlternateScreen) {
        if (window.electronAPI) {
          try {
            window.electronAPI.sshExecuteSync(connectionId, data);
          } catch (error) {
            console.warn('sshExecuteSync failed', error);
          }
        }
        currentInputRef.current = '';
        return;
      }

      if (data !== '\r') {
        const pastedAgentCommand = parseTerminalAgentPaste(data, currentInputRef.current);
        if (pastedAgentCommand && isAgentPromptReady()) {
          const hadForwardedInput = currentInputRef.current.length > 0;
          inputTrackingReliableRef.current = true;
          currentInputRef.current = '';
          if (window.electronAPI) {
            try {
              if (hadForwardedInput) {
                window.electronAPI.sshExecuteSync(connectionId, '\x15');
              }
              onAgentInputRef.current?.(pastedAgentCommand.text);
            } catch (error) {
              console.warn('Failed to submit pasted terminal Agent input', error);
            }
          }
          return;
        }
      }

      let command: string | null = null;
      if (data === '\r') {
        command = resolveEnteredCommand();
        const agentPromptReady = isAgentPromptReady();
        const replyMode = getAgentReplyModeRef.current?.() ?? null;
        const lineAction = resolveTerminalAgentLineAction(
          command || '',
          replyMode,
        );
        inputTrackingReliableRef.current = true;
        currentInputRef.current = '';
        if (lineAction.type === 'exit-follow-up') {
          if (window.electronAPI) {
            try {
              window.electronAPI.sshExecuteSync(connectionId, '\r');
              onExitAgentFollowUpRef.current?.();
            } catch (error) {
              console.warn('Failed to exit terminal Agent follow-up mode', error);
            }
          }
          return;
        }
        if (lineAction.type === 'shell-escape') {
          if (window.electronAPI) {
            try {
              window.electronAPI.sshExecuteSync(connectionId, '\x15');
              if (lineAction.text) {
                window.electronAPI.sshExecuteSync(connectionId, `${lineAction.text}\r`);
              }
            } catch (error) {
              console.warn('Failed to execute terminal Agent shell escape', error);
            }
          }
          return;
        }
        if (
          lineAction.type === 'agent'
          && (agentPromptReady || replyMode !== null || shouldForceAgentPrefixRef.current?.())
        ) {
          // The remote shell has echoed the line but has not executed it. Clear
          // that pending shell input, then route the line to the local Agent.
          if (window.electronAPI) {
            try {
              window.electronAPI.sshExecuteSync(connectionId, '\x15');
              onAgentInputRef.current?.(lineAction.text);
            } catch (error) {
              console.warn('Failed to submit terminal Agent input', error);
            }
          }
          return;
        }
      }

      if (window.electronAPI) {
        try {
          window.electronAPI.sshExecuteSync(connectionId, data);
        } catch (error) {
          console.warn('sshExecuteSync failed', error);
        }
      }

      if (data === '\r') {
        if (command) {
          const currentCwd = normalizeHistoryPath(cwdRef.current || DEFAULT_CWD);
          // cd 追踪：提示符弱/无 OSC7 时仍能跟着跳目录；打开传输时 live 提示符优先可纠正误输入
          const inferredNextCwd = nextTrackedCwd(currentCwd, command);
          if (inferredNextCwd) {
            syncSessionCwd(inferredNextCwd);
          }

          recordSessionCommand(connectionId || '', {
            command,
            cwd: currentCwd,
            executedBy: 'user',
          });
        }
        inputTrackingReliableRef.current = true;
        currentInputRef.current = '';
      } else if (data === '\x7f' || data === '\b') {
        currentInputRef.current = currentInputRef.current.slice(0, -1);
      } else if (data === '\x03') {
        inputTrackingReliableRef.current = true;
        currentInputRef.current = '';
      } else if (data === '\x15') {
        currentInputRef.current = '';
      } else if (data === '\x17') {
        currentInputRef.current = currentInputRef.current.replace(/\S+\s*$/, '');
      } else if (data.startsWith('\x1b')) {
        if (data === '\x1b[A' || data === '\x1b[B') {
          inputTrackingReliableRef.current = false;
          currentInputRef.current = '';
        }
      } else if (data === '\t') {
        inputTrackingReliableRef.current = false;
        currentInputRef.current = '';
      } else if (data.charCodeAt(0) >= 32) {
        if (!currentInputRef.current) {
          inputTrackingReliableRef.current = true;
        }
        currentInputRef.current += data;
      }
    });

    onDataDisposableRef.current = onDataDisposable;

    return () => {
      onDataDisposable.dispose();
      if (onDataDisposableRef.current === onDataDisposable) {
        onDataDisposableRef.current = null;
      }
    };
  }, [
    forceResumeInputForward,
    liveConnectionId,
    syncAlternateScreenState,
    syncSessionCwd,
    terminalInstanceVersion,
    xtermRef,
  ]);

  /**
   * 回放输出时挂起 onData→SSH。
   * 带超时保险：xterm write 回调偶发不触发时，避免一直“光标闪但不能输入”。
   */
  const beginSuspendInputForward = useCallback(() => {
    suspendInputForwardRef.current += 1;
    const generation = ++suspendGenerationRef.current;
    if (suspendTimeoutRef.current) {
      clearTimeout(suspendTimeoutRef.current);
    }
    suspendTimeoutRef.current = setTimeout(() => {
      suspendTimeoutRef.current = null;
      if (suspendGenerationRef.current !== generation) {
        return;
      }
      if (suspendInputForwardRef.current > 0) {
        suspendInputForwardRef.current = 0;
      }
    }, SUSPEND_INPUT_FORWARD_TIMEOUT_MS);
  }, []);

  const endSuspendInputForward = useCallback(() => {
    suspendInputForwardRef.current = Math.max(0, suspendInputForwardRef.current - 1);
    // 注意：不清理 suspendTimeoutRef。超时恢复（挂起提前归零）后迟到的
    // endSuspend 若清掉 timer，会让新挂起失去兜底，极端情况下永久吞输入。
    // timer 到期时会按 generation 校验自行收敛，无需在此清理。
  }, []);

  /**
   * 只清「正在敲的这一行」，不动 cwd / outputTail。
   *
   * 用途：退出 Agent 连续对话或按 Esc 中断时，远端那行已经被 `\x15` 清掉，
   * 本地追踪也必须同步清空，否则残留的 `@ai ...` 会继续和新输入拼在一起，
   * 导致用户「退出后随便打点什么还是被当成 AI 对话」。
   */
  const clearTrackedInput = useCallback(() => {
    inputTrackingReliableRef.current = true;
    currentInputRef.current = '';
  }, []);

  // 连接切换或终端实例重建时清掉挂起，避免上一轮回放泄漏
  useEffect(() => {
    forceResumeInputForward();
  }, [forceResumeInputForward, liveConnectionId, terminalInstanceVersion]);

  /**
   * 粘贴文本直接下发到远端、不经过 onData，所以要在这里补记，否则回车提交的是残缺内容
   * （粘贴不丢：见 `trackPastedInput` 的说明）。
   */
  const recordPastedInput = useCallback((text: string) => {
    const next = trackPastedInput(
      { input: currentInputRef.current, reliable: inputTrackingReliableRef.current },
      text,
    );
    currentInputRef.current = next.input;
    inputTrackingReliableRef.current = next.reliable;
  }, []);

  /** 当前普通 shell 输入行；粘贴路由用它避免截断已有命令。 */
  const getCurrentInput = useCallback(() => currentInputRef.current, []);

  /** 打开传输时读取最新追踪快照（避免 React state 滞后）。 */
  const getCwdTrackingSnapshot = useCallback(() => ({
    cwd: cwdRef.current,
    outputTail: outputTailRef.current,
  }), []);

  return {
    consumeOutputChunk,
    resetInputTracking,
    clearTrackedInput,
    beginSuspendInputForward,
    endSuspendInputForward,
    forceResumeInputForward,
    getCurrentInput,
    getCwdTrackingSnapshot,
    recordPastedInput,
  };
}
