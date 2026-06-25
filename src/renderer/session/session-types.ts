import type { Session, SessionScrollbackSnapshot } from '../../shared/types';

/** Runtime session map keyed by session id. */
export type SessionRecord = Record<string, Session>;

/** In-memory terminal output cache keyed by session id. */
export type SessionOutputRecord = Record<string, string>;

/** Serializable snapshot payload returned by the recovery helpers. */
export interface SessionRecoveryState {
  sessions: SessionRecord;
  outputs: SessionOutputRecord;
  orderedSessionIds: string[];
}

/** Convenience alias for persisted scrollback snapshots. */
export type PersistedScrollbackSnapshot = SessionScrollbackSnapshot;
