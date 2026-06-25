import type { AppSettings } from '../../shared/types';
import { TerminalView } from './terminal/TerminalView';

interface SessionTerminalProps {
  connectionId: string | null;
  onPasteToAI: (text: string) => void;
  settings: AppSettings;
  theme: 'dark' | 'light' | 'system';
}

/** Session-facing terminal entry point. */
export function SessionTerminal({
  connectionId,
  onPasteToAI,
  settings,
  theme,
}: SessionTerminalProps) {
  return (
    <TerminalView
      connectionId={connectionId}
      onPasteToAI={onPasteToAI}
      settings={settings}
      theme={theme}
    />
  );
}
