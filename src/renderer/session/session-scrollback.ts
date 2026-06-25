import {
  DEFAULT_SETTINGS,
} from '../../shared/constants';
import type {
  Session,
  SessionPersistenceSettings,
  SessionScrollbackSnapshot,
} from '../../shared/types';

const STORAGE_KEY = 'ai-ssh-client:session-scrollback:v1';

function getPersistenceSettings(
  overrides?: Partial<SessionPersistenceSettings>,
): SessionPersistenceSettings {
  return {
    maxPersistedSessions:
      overrides?.maxPersistedSessions ?? DEFAULT_SETTINGS.maxPersistedSessions,
    maxScrollbackBytesPerSession:
      overrides?.maxScrollbackBytesPerSession
      ?? DEFAULT_SETTINGS.maxScrollbackBytesPerSession,
  };
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function trimOutput(content: string, maxBytes: number): string {
  if (!content) {
    return '';
  }

  if (content.length <= maxBytes) {
    return content;
  }

  return content.slice(-maxBytes);
}

function readAllSnapshots(): SessionScrollbackSnapshot[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as SessionScrollbackSnapshot[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.sessionId === 'string')
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch (error) {
    console.error('Failed to read session scrollback snapshots:', error);
    return [];
  }
}

function writeAllSnapshots(snapshots: SessionScrollbackSnapshot[]): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch (error) {
    console.error('Failed to persist session scrollback snapshots:', error);
  }
}

/** Loads persisted session scrollback snapshots ordered by recent activity. */
export function loadSessionScrollbackSnapshots(): SessionScrollbackSnapshot[] {
  return readAllSnapshots();
}

/**
 * Persists recent terminal output for a session with bounded size and count.
 */
export function persistSessionScrollbackSnapshot(
  session: Session,
  content: string,
  overrides?: Partial<SessionPersistenceSettings>,
): void {
  if (!session.id) {
    return;
  }

  const settings = getPersistenceSettings(overrides);
  const snapshot: SessionScrollbackSnapshot = {
    sessionId: session.id,
    connectionId: session.connectionId,
    updatedAt: Date.now(),
    cwd: session.cwd,
    content: trimOutput(content, settings.maxScrollbackBytesPerSession),
    title: session.title,
  };

  const merged = [
    snapshot,
    ...readAllSnapshots().filter((item) => item.sessionId !== session.id),
  ].slice(0, settings.maxPersistedSessions);

  writeAllSnapshots(merged);
}

/** Removes any persisted scrollback for the provided session id. */
export function removeSessionScrollbackSnapshot(sessionId: string): void {
  writeAllSnapshots(readAllSnapshots().filter((item) => item.sessionId !== sessionId));
}
