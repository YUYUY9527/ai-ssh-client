import { useEffect, useRef, useState } from 'react';
import { Clipboard, Copy, Edit3 } from 'lucide-react';

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onPasteToInput: () => void;
  onPasteToAI: () => void;
  onClose: () => void;
  canPasteToTerminal: boolean;
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
  onClose,
  canPasteToTerminal,
  translate,
}: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    const nextX = x + menuRect.width > windowWidth
      ? windowWidth - menuRect.width - 8
      : x;
    const nextY = y + menuRect.height > windowHeight
      ? windowHeight - menuRect.height - 8
      : y;

    setPosition({
      x: Math.max(8, nextX),
      y: Math.max(8, nextY),
    });
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="app-popover fixed top-auto mt-0 py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={(event) => { event.stopPropagation(); onCopy(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Copy className="w-4 h-4" />
        {translate('terminal.copy')}
      </button>
      <button
        onClick={(event) => { event.stopPropagation(); onPaste(); }}
        disabled={!canPasteToTerminal}
        className="app-popover-row text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300"
      >
        <Clipboard className="w-4 h-4" />
        {translate('terminal.paste')}
      </button>
      <div className="border-t border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] my-1" />
      <button
        onClick={(event) => { event.stopPropagation(); onPasteToInput(); }}
        disabled={!canPasteToTerminal}
        className="app-popover-row text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300"
      >
        <Edit3 className="w-4 h-4" />
        {translate('terminal.pasteToInput')}
      </button>
      <button
        onClick={(event) => { event.stopPropagation(); onPasteToAI(); }}
        className="app-popover-row text-sm text-slate-700 dark:text-slate-300"
      >
        <Edit3 className="w-4 h-4" />
        {translate('terminal.pasteToAI')}
      </button>
    </div>
  );
}
