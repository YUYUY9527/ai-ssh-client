import type { AppSettings } from '../../shared/types';
import { TerminalView } from './terminal/TerminalView';

interface SessionTerminalProps {
  liveConnectionId: string | null;
  onPasteToAI: (text: string) => void;
  sessionId: string | null;
  settings: AppSettings;
  theme: 'dark' | 'light' | 'system';
}

/** Session-facing terminal entry point. */
export function SessionTerminal({
  liveConnectionId,
  onPasteToAI,
  sessionId,
  settings,
  theme,
}: SessionTerminalProps) {
  return (
    <TerminalView
      liveConnectionId={liveConnectionId}
      onPasteToAI={onPasteToAI}
      sessionId={sessionId}
      settings={settings}
      theme={theme}
    />
  );
}
