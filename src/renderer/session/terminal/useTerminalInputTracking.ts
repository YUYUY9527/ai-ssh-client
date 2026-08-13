import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

import {
  DEFAULT_CWD,
  nextTrackedCwd,
  normalizeHistoryPath,
} from '../../history/command-history-index';
import { useCommandHistoryStore } from '../../history/useCommandHistoryStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useSessionStore } from '../useSessionStore';
import type { CommandHistoryItem } from '../../../shared/types';
import {
  extractCwdFromTerminalOutput,
  shouldReplaceCwd,
  stripTerminalControlSequences,
} from './terminal-cwd';

function tailText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(-maxChars);
}

/**
 * xterm 对 OSC/CSI 查询的自动应答（挂起期间应丢弃，防 PTY 回显死循环）。
 * 特征：所有以 ESC（0x1b）或单字节 CSI（0x9b）开头的序列。
 * 注意：用户方向键等也是 \x1b[ 开头，但回放挂起窗口为毫秒级，期间丢弃可接受；
 * 普通字符、回车、退格、制表符等真实输入不受影响。
 */
function isXtermAutoReply(data: string): boolean {
  if (!data) {
    return false;
  }
  const code = data.charCodeAt(0);
  return code === 0x1b || code === 0x9b;
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
  syncAlternateScreenState: () => boolean | undefined;
  terminalInstanceVersion: number;
  xtermRef: RefObject<XTerm | null>;
}

/** Tracks user input, cwd hints and command history writes for one terminal instance. */
export function useTerminalInputTracking({
  liveConnectionId,
  syncAlternateScreenState,
  terminalInstanceVersion,
  xtermRef,
}: TerminalInputTrackingOptions) {
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
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

  const consumeOutputChunk = useCallback((chunk: string) => {
    outputTailRef.current = tailText(`${outputTailRef.current}${chunk}`, 4096);
    const detectedCwd = extractCwdFromTerminalOutput(outputTailRef.current);
    if (detectedCwd) {
      syncSessionCwd(detectedCwd);
    }
  }, [syncSessionCwd]);

  useEffect(() => {
    // 预热历史缓存，供面板与后续补全共用
    void useCommandHistoryStore.getState().loadHistory();
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

    const onDataDisposable = term.onData((data: string) => {
      if (data === '\x16') {
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

      if (window.electronAPI) {
        try {
          window.electronAPI.sshExecuteSync(connectionId, data);
        } catch (error) {
          console.warn('sshExecuteSync failed', error);
        }
      }

      if (syncAlternateScreenState()) {
        currentInputRef.current = '';
        return;
      }

      if (data === '\r') {
        const command = inputTrackingReliableRef.current
          ? currentInputRef.current.trim()
          : (extractCommandFromTerminalOutput(outputTailRef.current) || currentInputRef.current.trim());
        if (command) {
          const currentCwd = normalizeHistoryPath(cwdRef.current || DEFAULT_CWD);
          // cd 追踪：提示符弱/无 OSC7 时仍能跟着跳目录；打开传输时 live 提示符优先可纠正误输入
          const inferredNextCwd = nextTrackedCwd(currentCwd, command);
          if (inferredNextCwd) {
            syncSessionCwd(inferredNextCwd);
          }

          void (async () => {
            const { connections } = useConnectionStore.getState();
            const connection = connections.find(item => item.id === connectionId);
            const historyItem: CommandHistoryItem = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              command,
              timestamp: Date.now(),
              connectionId: connectionId || '',
              connectionName: connection?.name || 'Unknown',
              host: connection?.host,
              username: connection?.username,
              executedBy: 'user',
              approved: true,
              cwd: currentCwd,
            };
            await useCommandHistoryStore.getState().addHistoryItem(historyItem);
          })();
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

  // 连接切换或终端实例重建时清掉挂起，避免上一轮回放泄漏
  useEffect(() => {
    forceResumeInputForward();
  }, [forceResumeInputForward, liveConnectionId, terminalInstanceVersion]);

  /** 打开传输时读取最新追踪快照（避免 React state 滞后）。 */
  const getCwdTrackingSnapshot = useCallback(() => ({
    cwd: cwdRef.current,
    outputTail: outputTailRef.current,
  }), []);

  return {
    consumeOutputChunk,
    resetInputTracking,
    beginSuspendInputForward,
    endSuspendInputForward,
    forceResumeInputForward,
    getCwdTrackingSnapshot,
  };
}
