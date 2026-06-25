import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

import { useConnectionStore } from '../../store/useConnectionStore';
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
  connectionId: string | null;
  syncAlternateScreenState: () => boolean | undefined;
  terminalInstanceVersion: number;
  xtermRef: RefObject<XTerm | null>;
}

/** Tracks user input, cwd hints and command history writes for one terminal instance. */
export function useTerminalInputTracking({
  connectionId,
  syncAlternateScreenState,
  terminalInstanceVersion,
  xtermRef,
}: TerminalInputTrackingOptions) {
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const inputTrackingReliableRef = useRef(true);
  const currentInputRef = useRef('');
  const cwdRef = useRef('~');
  const outputTailRef = useRef('');
  const [, setCommandHistory] = useState<CommandHistoryItem[]>([]);

  const resetInputTracking = useCallback(() => {
    inputTrackingReliableRef.current = true;
    currentInputRef.current = '';
    cwdRef.current = '~';
    outputTailRef.current = '';
  }, []);

  const consumeOutputChunk = useCallback((chunk: string) => {
    outputTailRef.current = tailText(`${outputTailRef.current}${chunk}`, 4096);
    const detectedCwd = extractCwdFromTerminalOutput(outputTailRef.current);
    if (detectedCwd) {
      cwdRef.current = detectedCwd;
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      if (window.electronAPI) {
        const historyResult = await window.electronAPI.getCommandHistory();
        if (historyResult.success) {
          setCommandHistory(Array.isArray(historyResult.data?.history) ? historyResult.data.history : []);
        }
      }
    };
    void loadData();
  }, [connectionId]);

  useEffect(() => {
    if (!xtermRef.current || !connectionId) {
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
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, data);
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
          const currentCwd = cwdRef.current;
          const cdMatch = command.match(/^cd\s+(.+)$/);
          if (cdMatch) {
            const target = cdMatch[1].trim().replace(/["']/g, '');
            if (target.startsWith('/')) {
              cwdRef.current = target;
            } else if (target === '~' || target === '') {
              cwdRef.current = '~';
            } else if (target === '-') {
              // The previous directory is shell-owned, so the UI keeps the last known cwd.
            } else if (target === '..') {
              const parts = cwdRef.current.split('/').filter(Boolean);
              parts.pop();
              cwdRef.current = parts.length === 0 ? '/' : `/${parts.join('/')}`;
            } else if (target.startsWith('~/')) {
              cwdRef.current = target;
            } else if (cwdRef.current === '~') {
              cwdRef.current = `~/${target}`;
            } else {
              cwdRef.current = `${cwdRef.current.replace(/\/$/, '')}/${target}`;
            }
          } else if (command === 'cd') {
            cwdRef.current = '~';
          }

          void (async () => {
            if (window.electronAPI) {
              const { connections } = useConnectionStore.getState();
              const connection = connections.find(item => item.id === connectionId);
              const historyItem: CommandHistoryItem = {
                id: Date.now().toString(),
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
              await window.electronAPI.addCommandHistory(historyItem);
              window.dispatchEvent(new CustomEvent('command-history-updated'));

              const historyResult = await window.electronAPI.getCommandHistory();
              if (historyResult.success) {
                setCommandHistory(Array.isArray(historyResult.data?.history) ? historyResult.data.history : []);
              }
            }
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
  }, [connectionId, syncAlternateScreenState, terminalInstanceVersion, xtermRef]);

  return {
    consumeOutputChunk,
    resetInputTracking,
  };
}
