import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, Copy, Edit3, FolderOpen, Sparkles } from 'lucide-react';

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onPasteToInput: () => void;
  onPasteToAI: () => void;
  onOpenFileTransfer: () => void;
  onClose: () => void;
  canPasteToTerminal: boolean;
  canOpenFileTransfer: boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Context menu for terminal selection, paste and assistant actions. */
export function TerminalContextMenu({
  x,
  y,
  onCopy,
  onPaste,
  onPasteToInput,
  onPasteToAI,
  onOpenFileTransfer,
  onClose,
  canPasteToTerminal,
  canOpenFileTransfer,
  translate,
}: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    const nextX = x + menuRect.width > windowWidth - 8
      ? windowWidth - menuRect.width - 8
      : x;
    const nextY = y + menuRect.height > windowHeight - 8
      ? windowHeight - menuRect.height - 8
      : y;

    setPosition({
      x: Math.max(8, nextX),
      y: Math.max(8, nextY),
    });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="app-popover fixed top-auto z-overlay mt-0 min-w-[172px] py-1"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={(event) => { event.stopPropagation(); onCopy(); }}
        className="app-popover-row text-sm text-fg-secondary"
      >
        <Copy className="h-4 w-4 shrink-0" />
        {translate('terminal.copy')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={(event) => { event.stopPropagation(); onPaste(); }}
        disabled={!canPasteToTerminal}
        className="app-popover-row text-sm text-fg-secondary disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Clipboard className="h-4 w-4 shrink-0" />
        {translate('terminal.paste')}
      </button>
      <div className="my-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]" />
      <button
        type="button"
        role="menuitem"
        onClick={(event) => { event.stopPropagation(); onPasteToInput(); }}
        disabled={!canPasteToTerminal}
        className="app-popover-row text-sm text-fg-secondary disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Edit3 className="h-4 w-4 shrink-0" />
        {translate('terminal.pasteToInput')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={(event) => { event.stopPropagation(); onPasteToAI(); }}
        className="app-popover-row text-sm text-fg-secondary"
      >
        <Sparkles className="h-4 w-4 shrink-0" />
        {translate('terminal.pasteToAI')}
      </button>
      <div className="my-1 border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]" />
      <button
        type="button"
        role="menuitem"
        onClick={(event) => { event.stopPropagation(); onOpenFileTransfer(); }}
        disabled={!canOpenFileTransfer}
        className="app-popover-row text-sm text-fg-secondary disabled:cursor-not-allowed disabled:opacity-45"
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        {translate('terminal.fileTransfer')}
      </button>
    </div>,
    document.body,
  );
}
