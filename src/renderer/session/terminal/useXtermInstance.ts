import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

import type { AppSettings } from '../../../shared/types';
import { t } from '../../i18n';
import {
  XTERM_SCROLLBACK_LINES,
  TERMINAL_THEMES,
  getTerminalFontFamily,
} from './terminal-theme';

function prepareTerminalPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r');
}

interface XtermInstanceOptions {
  connectionId: string | null;
  copyTerminalSelectionToClipboard: () => boolean;
  fontSize: number;
  onInstanceVersionChange: () => void;
  resetInputTracking: () => void;
  searchAddonRef: RefObject<SearchAddon | null>;
  settings?: AppSettings;
  syncAlternateScreenState: () => boolean | undefined;
  terminalRef: RefObject<HTMLDivElement | null>;
  terminalTheme: string;
  xtermRef: RefObject<XTerm | null>;
}

/** Owns xterm lifecycle, sizing, write target registration and option synchronization. */
export function useXtermInstance({
  connectionId,
  copyTerminalSelectionToClipboard,
  fontSize,
  onInstanceVersionChange,
  resetInputTracking,
  searchAddonRef,
  settings,
  syncAlternateScreenState,
  terminalRef,
  terminalTheme,
  xtermRef,
}: XtermInstanceOptions) {
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renderedOutput, setRenderedOutput] = useState('');

  const resizeSSH = useCallback((cols: number, rows: number) => {
    if (connectionId && window.electronAPI) {
      window.electronAPI.sshResize(connectionId, cols, rows);
    }
  }, [connectionId]);

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
    if (!connectionId || !terminalRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
        onInstanceVersionChange();
      }
      setRenderedOutput('');
      return;
    }

    if (xtermRef.current) {
      return;
    }

    const term = new XTerm({
      theme: TERMINAL_THEMES[terminalTheme],
      fontFamily: getTerminalFontFamily(settings?.fontFamily),
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: true,
      cursorStyle: 'block',
      scrollback: XTERM_SCROLLBACK_LINES,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);

    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    onInstanceVersionChange();

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

      return !isEditable && Boolean(connectionId) && terminalRef.current?.offsetParent !== null;
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
      const terminalText = prepareTerminalPaste(text);
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, terminalText);
      } else {
        term.input(terminalText);
      }
    };

    terminalRef.current.addEventListener('paste', handleTerminalPaste, true);
    document.addEventListener('paste', handleTerminalPaste, true);

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.ctrlKey && key === 'c' && event.type === 'keydown') {
        return !copyTerminalSelectionToClipboard();
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
      if (connectionId && terminalRef.current) {
        fitAndResize();
      }
    };
    window.addEventListener('resize', handleWindowResize);

    term.clear();
    term.write(`\x1b[1;32m=== ${t('terminal.sshConnected')} ===\x1b[0m\r\n`);
    term.write(`\x1b[1;33m${t('terminal.waitingServer')}\x1b[0m\r\n\r\n`);
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
    connectionId,
    copyTerminalSelectionToClipboard,
    fitAndResize,
    onInstanceVersionChange,
    resetInputTracking,
    searchAddonRef,
    syncAlternateScreenState,
    terminalRef,
    xtermRef,
  ]);

  useEffect(() => {
    const handler = (command: string) => {
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, command);
        return;
      }

      xtermRef.current?.input(command);
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
  }, [connectionId, terminalRef, xtermRef]);

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

  return {
    renderedOutput,
    setRenderedOutput,
  };
}
