import { useEffect } from 'react';

import type { SSHConnection } from '../../shared/types';
import { loadSessionScrollbackSnapshots } from './session-scrollback';
import { useSessionStore } from './useSessionStore';

/** Restores recent terminal output into closed sessions after app startup. */
export function useSessionRecovery(connections: SSHConnection[]): void {
  useEffect(() => {
    const snapshots = loadSessionScrollbackSnapshots();
    if (snapshots.length === 0) {
      return;
    }

    useSessionStore.getState().restoreSnapshots(snapshots, connections);
  }, [connections]);
}
