import { useCallback, useState, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

import { t } from '../../i18n';

interface TerminalClipboardOptions {
  liveConnectionId: string | null;
  onPasteToAI?: (text: string) => void;
  xtermRef: RefObject<XTerm | null>;
}

function prepareTerminalPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r');
}

function inputTerminalText(connectionId: string | null, text: string): void {
  if (!text) {
    return;
  }

  const terminalText = prepareTerminalPaste(text);
  if (connectionId && window.electronAPI) {
    window.electronAPI.sshExecuteSync(connectionId, terminalText);
  }
}

function copyText(text: string): void {
  const fallbackCopy = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallbackCopy);
    return;
  }

  fallbackCopy();
}

function readClipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    return Promise.reject(new Error('Clipboard API is unavailable'));
  }

  return navigator.clipboard.readText();
}

function promptPasteText(): string {
  return window.prompt(t('terminal.clipboardPrompt')) || '';
}

/** Handles terminal context-menu clipboard actions. */
export function useTerminalClipboard({ liveConnectionId, onPasteToAI, xtermRef }: TerminalClipboardOptions) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const copyTerminalSelectionToClipboard = useCallback((): boolean => {
    const selection = xtermRef.current?.getSelection();
    if (!selection) {
      return false;
    }

    copyText(selection);
    return true;
  }, [xtermRef]);

  const pasteToInput = useCallback((text: string) => {
    const cleanText = text.replace(/[\r\n]+$/, '');
    if (cleanText) {
      inputTerminalText(liveConnectionId, cleanText);
    }
  }, [liveConnectionId]);

  const handleCopy = useCallback(() => {
    copyTerminalSelectionToClipboard();
    closeContextMenu();
  }, [closeContextMenu, copyTerminalSelectionToClipboard]);

  const handlePaste = useCallback(() => {
    if (!liveConnectionId) {
      closeContextMenu();
      return;
    }

    readClipboardText().then((text) => {
      inputTerminalText(liveConnectionId, text);
      closeContextMenu();
    }).catch((error) => {
      console.error('Failed to read clipboard:', error);
      inputTerminalText(liveConnectionId, promptPasteText());
      xtermRef.current?.focus();
      closeContextMenu();
    });
  }, [closeContextMenu, liveConnectionId, xtermRef]);

  const handlePasteToInput = useCallback(() => {
    if (!liveConnectionId) {
      closeContextMenu();
      return;
    }

    const selectedText = xtermRef.current?.getSelection();
    if (selectedText && selectedText.trim()) {
      pasteToInput(selectedText);
      closeContextMenu();
      return;
    }

    readClipboardText().then((clipboardText) => {
      if (clipboardText) {
        pasteToInput(clipboardText);
      }
      closeContextMenu();
    }).catch((error) => {
      console.error('Failed to read clipboard:', error);
      inputTerminalText(liveConnectionId, promptPasteText());
      xtermRef.current?.focus();
      closeContextMenu();
    });
  }, [closeContextMenu, liveConnectionId, pasteToInput, xtermRef]);

  const handlePasteToAI = useCallback(() => {
    if (!xtermRef.current) {
      closeContextMenu();
      return;
    }

    const selectedText = xtermRef.current.getSelection();
    if (selectedText && selectedText.trim()) {
      onPasteToAI?.(selectedText);
      closeContextMenu();
      return;
    }

    readClipboardText().then((clipboardText) => {
      if (clipboardText) {
        onPasteToAI?.(clipboardText);
      }
      closeContextMenu();
    }).catch((error) => {
      console.error('Failed to read clipboard:', error);
      closeContextMenu();
    });
  }, [closeContextMenu, onPasteToAI, xtermRef]);

  return {
    closeContextMenu,
    contextMenu,
    copyTerminalSelectionToClipboard,
    handleCopy,
    handlePaste,
    handlePasteToAI,
    handlePasteToInput,
    setContextMenu,
  };
}
