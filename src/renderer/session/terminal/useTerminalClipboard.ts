import { useCallback, useState, type RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

interface TerminalClipboardOptions {
  onPasteToAI?: (text: string) => void;
  xtermRef: RefObject<XTerm | null>;
}

/** Handles terminal context-menu clipboard actions. */
export function useTerminalClipboard({ onPasteToAI, xtermRef }: TerminalClipboardOptions) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const copyTerminalSelectionToClipboard = useCallback((): boolean => {
    const selection = xtermRef.current?.getSelection();
    if (!selection) {
      return false;
    }

    navigator.clipboard.writeText(selection).catch((error) => {
      console.error('Failed to copy terminal selection:', error);
    });
    return true;
  }, [xtermRef]);

  const pasteToInput = useCallback((text: string) => {
    if (!xtermRef.current) {
      return;
    }

    const cleanText = text.replace(/[\r\n]+$/, '');
    if (cleanText) {
      xtermRef.current.paste(cleanText);
    }
  }, [xtermRef]);

  const handleCopy = useCallback(() => {
    copyTerminalSelectionToClipboard();
    closeContextMenu();
  }, [closeContextMenu, copyTerminalSelectionToClipboard]);

  const handlePaste = useCallback(() => {
    if (xtermRef.current) {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          xtermRef.current?.paste(text);
        }
      }).catch((error) => {
        console.error('Failed to read clipboard:', error);
      });
    }
    closeContextMenu();
  }, [closeContextMenu, xtermRef]);

  const handlePasteToInput = useCallback(() => {
    if (!xtermRef.current) {
      closeContextMenu();
      return;
    }

    const selectedText = xtermRef.current.getSelection();
    if (selectedText && selectedText.trim()) {
      pasteToInput(selectedText);
      closeContextMenu();
      return;
    }

    navigator.clipboard.readText().then((clipboardText) => {
      if (clipboardText) {
        pasteToInput(clipboardText);
      }
      closeContextMenu();
    }).catch((error) => {
      console.error('Failed to read clipboard:', error);
      closeContextMenu();
    });
  }, [closeContextMenu, pasteToInput, xtermRef]);

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

    navigator.clipboard.readText().then((clipboardText) => {
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
