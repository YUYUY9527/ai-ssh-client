import { Radio } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { useWorkspaceStore } from '../../workspace/useWorkspaceStore';
import { countLeaves } from '../../workspace/paneLayout';
import {
  isTerminalBroadcastEnabled,
  setTerminalBroadcastEnabled,
  subscribeTerminalBroadcast,
} from './terminal-broadcast';

interface BroadcastButtonProps {
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * 命令广播开关：仅在分屏（可见终端 ≥ 2）时出现，开启后键入会同步到其它可见面板。
 */
export function BroadcastButton({ translate }: BroadcastButtonProps) {
  const enabled = useSyncExternalStore(subscribeTerminalBroadcast, isTerminalBroadcastEnabled, () => false);
  const paneCount = useWorkspaceStore((state) => (state.paneRoot ? countLeaves(state.paneRoot) : 1));

  if (paneCount < 2) return null;

  return (
    <button
      type="button"
      onClick={() => setTerminalBroadcastEnabled(!enabled)}
      className={`terminal-control ${enabled ? 'terminal-control-active' : ''}`}
      title={translate(enabled ? 'terminal.broadcastOn' : 'terminal.broadcastOff')}
      aria-pressed={enabled}
    >
      <Radio className="w-4 h-4" />
    </button>
  );
}
