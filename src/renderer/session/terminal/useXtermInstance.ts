import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import type { AppSettings } from '../../../shared/types';
import { t } from '../../i18n';
import {
  TERMINAL_THEMES,
  getTerminalFontFamily,
} from './terminal-theme';
import { resolveTerminalRuntimeSettings } from './terminal-settings';
import { isOpenableHttpUrl, ShellIntegrationParser, type ShellIntegrationState } from './shell-integration';
import { gateTerminalPaste } from './paste-safety';

interface XtermInstanceOptions {
  copyTerminalSelectionToClipboard: () => boolean;
  fontSize: number;
  liveConnectionId: string | null;
  onInstanceVersionChange: () => void;
  /** 多行粘贴需确认时回调；单行不会触发。 */
  onMultilinePasteRequest?: (previewText: string, preparedText: string) => void;
  resetInputTracking: () => void;
  searchAddonRef: MutableRefObject<SearchAddon | null>;
  sessionId: string | null;
  settings?: AppSettings;
  syncAlternateScreenState: () => boolean | undefined;
  terminalRef: MutableRefObject<HTMLDivElement | null>;
  terminalTheme: string;
  xtermRef: MutableRefObject<XTerm | null>;
  onShellIntegrationStateChange?: (state: ShellIntegrationState) => void;
}

/** 打开 HTTP(S) 链接：优先新窗口，失败时用 a 标签回退。 */
function openTerminalUrl(url: string): void {
  if (!isOpenableHttpUrl(url)) {
    return;
  }
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) {
      return;
    }
  } catch {
    // fall through
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Owns xterm lifecycle, sizing, write target registration and option synchronization. */
export function useXtermInstance({
  copyTerminalSelectionToClipboard,
  fontSize,
  liveConnectionId,
  onInstanceVersionChange,
  onMultilinePasteRequest,
  resetInputTracking,
  searchAddonRef,
  sessionId,
  settings,
  syncAlternateScreenState,
  terminalRef,
  terminalTheme,
  xtermRef,
  onShellIntegrationStateChange,
}: XtermInstanceOptions) {
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveConnectionIdRef = useRef(liveConnectionId);
  const onMultilinePasteRequestRef = useRef(onMultilinePasteRequest);
  const onShellIntegrationStateChangeRef = useRef(onShellIntegrationStateChange);
  const copyOnSelectRef = useRef(false);
  const shellIntegrationEnabledRef = useRef(true);
  const copySelectionRef = useRef(copyTerminalSelectionToClipboard);
  const shellParserRef = useRef(new ShellIntegrationParser());
  const selectionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [renderedOutput, setRenderedOutput] = useState('');
  const runtimeSettings = resolveTerminalRuntimeSettings(settings);

  copyOnSelectRef.current = runtimeSettings.copyOnSelect;
  shellIntegrationEnabledRef.current = runtimeSettings.shellIntegration;
  copySelectionRef.current = copyTerminalSelectionToClipboard;

  useEffect(() => {
    liveConnectionIdRef.current = liveConnectionId;
  }, [liveConnectionId]);

  useEffect(() => {
    onMultilinePasteRequestRef.current = onMultilinePasteRequest;
  }, [onMultilinePasteRequest]);

  useEffect(() => {
    onShellIntegrationStateChangeRef.current = onShellIntegrationStateChange;
  }, [onShellIntegrationStateChange]);

  const resizeSSH = useCallback((cols: number, rows: number) => {
    if (liveConnectionIdRef.current && window.electronAPI) {
      window.electronAPI.sshResize(liveConnectionIdRef.current, cols, rows);
    }
  }, []);

  const fitAndResize = useCallback(() => {
    if (!xtermRef.current || !fitAddonRef.current) {
      return;
    }

    fitAddonRef.current.fit();
    const { cols, rows } = xtermRef.current;
    if (cols > 0 && rows > 0) {
      resizeSSH(cols, rows);
    }
  }, [resizeSSH, xtermRef]);

  useEffect(() => {
    if (liveConnectionId) {
      fitAndResize();
    }
  }, [fitAndResize, liveConnectionId]);

  /** 经粘贴门控后发送；多行走确认回调。 */
  const sendPasteText = useCallback((text: string) => {
    const gated = gateTerminalPaste(text, false);
    if (gated.action === 'skip') {
      return;
    }
    if (gated.action === 'confirm') {
      onMultilinePasteRequestRef.current?.(gated.previewText, gated.preparedText);
      return;
    }
    if (liveConnectionIdRef.current && window.electronAPI) {
      window.electronAPI.sshExecuteSync(liveConnectionIdRef.current, gated.text);
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !terminalRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
        onInstanceVersionChange();
      }
      setRenderedOutput('');
      shellParserRef.current.reset();
      return;
    }

    if (xtermRef.current) {
      return;
    }

    const initialRuntime = resolveTerminalRuntimeSettings(settings);

    const term = new XTerm({
      theme: TERMINAL_THEMES[terminalTheme],
      fontFamily: getTerminalFontFamily(settings?.fontFamily),
      fontSize,
      lineHeight: 1.2,
      cursorBlink: initialRuntime.cursorBlink,
      allowTransparency: true,
      cursorStyle: initialRuntime.cursorStyle,
      scrollback: initialRuntime.scrollback,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      openTerminalUrl(uri);
    });

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    setRenderedOutput('');
    shellParserRef.current.reset();
    onInstanceVersionChange();

    // 选中即复制：用 ref 读最新开关，避免重建实例
    selectionDisposableRef.current = term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) {
        return;
      }
      const selection = term.getSelection();
      if (selection) {
        copySelectionRef.current();
      }
    });

    const shouldHandlePaste = (eventTarget: EventTarget | null) => {
      const targetNode = eventTarget instanceof Node ? eventTarget : null;
      const activeElement = document.activeElement;
      const isEditable = activeElement instanceof HTMLElement
        && (
          activeElement.isContentEditable
          || activeElement.tagName === 'INPUT'
          || activeElement.tagName === 'TEXTAREA'
        );

      if (targetNode && terminalRef.current?.contains(targetNode)) {
        return true;
      }

      if (activeElement && terminalRef.current?.contains(activeElement)) {
        return true;
      }

      return !isEditable && Boolean(liveConnectionIdRef.current) && terminalRef.current?.offsetParent !== null;
    };

    const handleTerminalPaste = (event: ClipboardEvent) => {
      if (!shouldHandlePaste(event.target)) {
        return;
      }

      const text = event.clipboardData?.getData('text/plain');
      if (!text) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      // 多行不直接 sshExecuteSync，统一走门控
      sendPasteText(text);
    };

    terminalRef.current.addEventListener('paste', handleTerminalPaste, true);
    document.addEventListener('paste', handleTerminalPaste, true);

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.ctrlKey && key === 'c' && event.type === 'keydown') {
        return !copyTerminalSelectionToClipboard();
      }

      if (event.ctrlKey && key === 'v') {
        if (event.type === 'keydown' && liveConnectionIdRef.current && window.electronAPI) {
          void navigator.clipboard?.readText?.().then((text) => {
            if (text && liveConnectionIdRef.current) {
              sendPasteText(text);
            }
          }).catch(() => {});
        }
        return false;
      }

      if (event.ctrlKey && key === 'f') {
        return false;
      }
      return true;
    });

    let initialFitDone = false;
    const doInitialFit = () => {
      if (initialFitDone || !terminalRef.current) {
        return;
      }

      const rect = terminalRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) {
        return;
      }

      initialFitDone = true;
      fitAndResize();
    };

    requestAnimationFrame(doInitialFit);
    initTimeoutRef.current = setTimeout(doInitialFit, 50);
    fitTimeoutRef.current = setTimeout(doInitialFit, 200);

    const handleWindowResize = () => {
      if (terminalRef.current) {
        fitAndResize();
      }
    };
    window.addEventListener('resize', handleWindowResize);

    term.clear();
    if (liveConnectionIdRef.current) {
      term.write(`\x1b[1;32m=== ${t('terminal.sshConnected')} ===\x1b[0m\r\n`);
      term.write(`\x1b[1;33m${t('terminal.waitingServer')}\x1b[0m\r\n\r\n`);
    }
    resetInputTracking();

    const writeParsedDisposable = term.onWriteParsed(() => {
      syncAlternateScreenState();
    });

    resizeObserverRef.current = new ResizeObserver(() => {
      if (!initialFitDone) {
        return;
      }
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(() => {
        if (!terminalRef.current) {
          return;
        }

        const rect = terminalRef.current.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) {
          return;
        }
        fitAndResize();
      }, 50);
    });

    resizeObserverRef.current.observe(terminalRef.current);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (selectionDisposableRef.current) {
        selectionDisposableRef.current.dispose();
        selectionDisposableRef.current = null;
      }
      terminalRef.current?.removeEventListener('paste', handleTerminalPaste, true);
      document.removeEventListener('paste', handleTerminalPaste, true);
      writeParsedDisposable.dispose();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      onInstanceVersionChange();
    };
  }, [
    copyTerminalSelectionToClipboard,
    fitAndResize,
    onInstanceVersionChange,
    resetInputTracking,
    searchAddonRef,
    sendPasteText,
    sessionId,
    syncAlternateScreenState,
    terminalRef,
    xtermRef,
  ]);

  useEffect(() => {
    const handler = (command: string) => {
      if (liveConnectionIdRef.current && window.electronAPI) {
        window.electronAPI.sshExecuteSync(liveConnectionIdRef.current, command);
      }
    };

    const claimWriteTarget = () => {
      if (!terminalRef.current || terminalRef.current.offsetParent === null) {
        return;
      }
      (window as any).writeToTerminal = handler;
    };

    claimWriteTarget();

    const observedTargets = [
      terminalRef.current,
      terminalRef.current?.parentElement,
      terminalRef.current?.parentElement?.parentElement,
      terminalRef.current?.parentElement?.parentElement?.parentElement,
    ].filter(Boolean) as HTMLElement[];

    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(claimWriteTarget);
    });

    observedTargets.forEach((target) => {
      observer.observe(target, { attributes: true, attributeFilter: ['style', 'class'] });
    });

    const handleFocus = () => {
      claimWriteTarget();
    };

    terminalRef.current?.addEventListener('pointerenter', handleFocus);
    terminalRef.current?.addEventListener('focusin', handleFocus);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      observer.disconnect();
      terminalRef.current?.removeEventListener('pointerenter', handleFocus);
      terminalRef.current?.removeEventListener('focusin', handleFocus);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
      if ((window as any).writeToTerminal === handler) {
        delete (window as any).writeToTerminal;
      }
    };
  }, [terminalRef, xtermRef]);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      fitAndResize();
    }
  }, [fitAndResize, fontSize, xtermRef]);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontFamily = getTerminalFontFamily(settings?.fontFamily);
      fitAndResize();
    }
  }, [fitAndResize, settings?.fontFamily, xtermRef]);

  useEffect(() => {
    if (xtermRef.current && TERMINAL_THEMES[terminalTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[terminalTheme];
    }
  }, [terminalTheme, xtermRef]);

  // 实时应用 scrollback / 光标 / 闪烁
  useEffect(() => {
    if (!xtermRef.current) {
      return;
    }
    xtermRef.current.options.scrollback = runtimeSettings.scrollback;
    xtermRef.current.options.cursorStyle = runtimeSettings.cursorStyle;
    xtermRef.current.options.cursorBlink = runtimeSettings.cursorBlink;
  }, [
    runtimeSettings.scrollback,
    runtimeSettings.cursorStyle,
    runtimeSettings.cursorBlink,
    xtermRef,
  ]);

  /** 消费输出分片中的 Shell Integration OSC（不阻断写流）。 */
  const consumeShellIntegration = useCallback((chunk: string): ShellIntegrationState => {
    if (!shellIntegrationEnabledRef.current) {
      return shellParserRef.current.getState();
    }
    const next = shellParserRef.current.feed(chunk);
    onShellIntegrationStateChangeRef.current?.(next);
    return next;
  }, []);

  return {
    renderedOutput,
    setRenderedOutput,
    consumeShellIntegration,
    getShellIntegrationState: () => shellParserRef.current.getState(),
  };
}
