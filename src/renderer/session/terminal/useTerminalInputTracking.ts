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

function tailText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(-maxChars);
}

function stripTerminalControlSequences(input: string): string {
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === '\u001b') {
      const next = input[index + 1];
      if (next === ']') {
        index += 2;
        let previousEscape = false;
        for (; index < input.length; index += 1) {
          const oscChar = input[index];
          if (oscChar === '\u0007' || (previousEscape && oscChar === '\\')) {
            break;
          }
          previousEscape = oscChar === '\u001b';
        }
      } else if (next === '[') {
        index += 2;
        for (; index < input.length; index += 1) {
          const csiChar = input[index];
          if (csiChar >= '@' && csiChar <= '~') {
            break;
          }
        }
      } else if (next) {
        index += 1;
      }
      continue;
    }

    if (ch === '\0') {
      continue;
    }

    if (ch < ' ' && ch !== '\r' && ch !== '\n' && ch !== '\t') {
      continue;
    }

    output += ch;
  }

  return output;
}

function parsePromptCwd(line: string): string | null {
  const trimmed = line.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (!trimmed || (lastChar !== '$' && lastChar !== '#')) {
    return null;
  }

  const bracketMatch = trimmed.match(/\[([^\]]+)\]\s*[#$]$/);
  if (bracketMatch) {
    const candidate = bracketMatch[1].trim().split(/\s+/).pop();
    if (candidate && (candidate.startsWith('~') || candidate.startsWith('/'))) {
      return candidate;
    }
  }

  const colonMatch = trimmed.match(/:([~/][^\s#$]*)\s*[#$]$/);
  if (colonMatch) {
    return colonMatch[1];
  }

  const trailingMatch = trimmed.match(/(?:^|\s)([~/][^\s#$]*)\s*[#$]$/);
  if (trailingMatch) {
    return trailingMatch[1];
  }

  return null;
}

function extractCwdFromTerminalOutput(output: string): string | null {
  const normalized = stripTerminalControlSequences(tailText(output, 4096)).replace(/\r/g, '\n');
  const lines = normalized
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(-8)
    .reverse();

  for (const line of lines) {
    const cwd = parsePromptCwd(line);
    if (cwd) {
      return cwd;
    }
  }

  return parsePromptCwd(normalized.trim());
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

  const syncSessionCwd = useCallback((cwd: string) => {
    if (!liveConnectionId) {
      return;
    }
    const normalized = normalizeHistoryPath(cwd);
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

  useEffect(() => {
    if (!xtermRef.current || !liveConnectionId) {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      return;
    }

    if (onDataDisposableRef.current) {
      return;
    }

    const term = xtermRef.current;

    const onDataDisposable = term.onData((data: string) => {
      if (data === '\x16') {
        return;
      }

      if (liveConnectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(liveConnectionId, data);
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
          const inferredNextCwd = nextTrackedCwd(currentCwd, command);
          if (inferredNextCwd) {
            syncSessionCwd(inferredNextCwd);
          }

          void (async () => {
            const { connections } = useConnectionStore.getState();
            const connection = connections.find(item => item.id === liveConnectionId);
            const historyItem: CommandHistoryItem = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              command,
              timestamp: Date.now(),
              connectionId: liveConnectionId || '',
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
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
    };
  }, [liveConnectionId, syncAlternateScreenState, syncSessionCwd, terminalInstanceVersion, xtermRef]);

  return {
    consumeOutputChunk,
    resetInputTracking,
  };
}
