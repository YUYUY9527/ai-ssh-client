import { create } from 'zustand';

import type {
  SSHConnection,
  Session,
  SessionPersistenceSettings,
  SessionScrollbackSnapshot,
  SSHSessionState,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import {
  persistSessionScrollbackSnapshot,
  removeSessionScrollbackSnapshot,
} from './session-scrollback';
import type { SessionOutputRecord, SessionRecord } from './session-types';

const FALLBACK_PERSISTENCE_SETTINGS: SessionPersistenceSettings = {
  maxPersistedSessions: DEFAULT_SETTINGS.maxPersistedSessions,
  maxScrollbackBytesPerSession: DEFAULT_SETTINGS.maxScrollbackBytesPerSession,
};

function deriveSessionState(
  state?: SSHSessionState,
): Session['state'] {
  if (!state) {
    return 'closed';
  }
  if (state.isConnecting && state.reconnectAttempts > 0) {
    return 'reconnecting';
  }
  if (state.isConnecting) {
    return 'connecting';
  }
  if (state.isConnected) {
    return 'connected';
  }
  if (state.lastError) {
    return 'error';
  }
  return 'closed';
}

function buildSessionFromConnection(
  connection: SSHConnection,
  overrides?: Partial<Session>,
): Session {
  return {
    id: overrides?.id ?? connection.id,
    connectionId: connection.id,
    title: overrides?.title ?? connection.name,
    state: overrides?.state ?? 'closed',
    isPinned: overrides?.isPinned,
    scrollbackKey: overrides?.scrollbackKey ?? connection.id,
    reconnectAttempts: overrides?.reconnectAttempts ?? 0,
    lastActiveAt: overrides?.lastActiveAt ?? Date.now(),
    lastError: overrides?.lastError,
    cwd: overrides?.cwd,
    restoredFromScrollback: overrides?.restoredFromScrollback,
  };
}

interface SessionStoreState {
  sessions: SessionRecord;
  orderedSessionIds: string[];
  activeSessionId: string | null;
  outputs: SessionOutputRecord;
  persistenceSettings: SessionPersistenceSettings;
  intentionalDisconnectIds: string[];
  registerSession: (connection: SSHConnection, overrides?: Partial<Session>) => Session;
  restoreSnapshots: (
    snapshots: SessionScrollbackSnapshot[],
    connections: SSHConnection[],
  ) => void;
  setActiveSession: (sessionId: string | null) => void;
  reorderSessions: (orderedSessionIds: string[]) => void;
  removeSession: (sessionId: string) => void;
  setSessionState: (sessionId: string, state: Partial<Session>) => void;
  syncSessionStateFromSsh: (sessionId: string, state: SSHSessionState) => void;
  appendOutput: (sessionId: string, data: string) => void;
  replaceOutput: (sessionId: string, data: string) => void;
  setSessionCwd: (sessionId: string, cwd: string) => void;
  setPersistenceSettings: (settings: Partial<SessionPersistenceSettings>) => void;
  persistSessionOutput: (sessionId: string) => void;
  markIntentionalDisconnect: (sessionId: string) => void;
  consumeIntentionalDisconnect: (sessionId: string) => boolean;
}

/** Stores runtime SSH session state independently from saved connection configs. */
export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: {},
  orderedSessionIds: [],
  activeSessionId: null,
  outputs: {},
  persistenceSettings: FALLBACK_PERSISTENCE_SETTINGS,
  intentionalDisconnectIds: [],

  registerSession: (connection, overrides) => {
    const session = buildSessionFromConnection(connection, overrides);
    set((state) => {
      const existing = state.sessions[session.id];
      return {
        sessions: {
          ...state.sessions,
          [session.id]: existing ? { ...existing, ...session } : session,
        },
        orderedSessionIds: state.orderedSessionIds.includes(session.id)
          ? state.orderedSessionIds
          : [...state.orderedSessionIds, session.id],
      };
    });
    return get().sessions[session.id] ?? session;
  },

  restoreSnapshots: (snapshots, connections) => {
    set((state) => {
      const sessions = { ...state.sessions };
      const outputs = { ...state.outputs };
      const orderedSessionIds = [...state.orderedSessionIds];

      snapshots.forEach((snapshot) => {
        if (sessions[snapshot.sessionId]) {
          return;
        }

        const connection = connections.find((item) => item.id === snapshot.connectionId);
        const title = snapshot.title || connection?.name || snapshot.connectionId;
        sessions[snapshot.sessionId] = {
          id: snapshot.sessionId,
          connectionId: snapshot.connectionId,
          title,
          state: 'closed',
          scrollbackKey: snapshot.sessionId,
          reconnectAttempts: 0,
          lastActiveAt: snapshot.updatedAt,
          cwd: snapshot.cwd,
          restoredFromScrollback: true,
        };
        outputs[snapshot.sessionId] = snapshot.content;
        orderedSessionIds.push(snapshot.sessionId);
      });

      return {
        sessions,
        outputs,
        orderedSessionIds,
        activeSessionId: state.activeSessionId ?? orderedSessionIds[0] ?? null,
      };
    });
  },

  setActiveSession: (sessionId) => {
    set((state) => ({
      activeSessionId: sessionId,
      sessions: sessionId && state.sessions[sessionId]
        ? {
            ...state.sessions,
            [sessionId]: {
              ...state.sessions[sessionId],
              lastActiveAt: Date.now(),
            },
          }
        : state.sessions,
    }));
  },

  reorderSessions: (orderedSessionIds) => {
    set({ orderedSessionIds });
  },

  removeSession: (sessionId) => {
    set((state) => {
      const nextSessions = { ...state.sessions };
      const nextOutputs = { ...state.outputs };
      delete nextSessions[sessionId];
      delete nextOutputs[sessionId];

      const orderedSessionIds = state.orderedSessionIds.filter((item) => item !== sessionId);
      const activeSessionId = state.activeSessionId === sessionId
        ? orderedSessionIds[0] ?? null
        : state.activeSessionId;

      return {
        sessions: nextSessions,
        outputs: nextOutputs,
        orderedSessionIds,
        activeSessionId,
      };
    });
    removeSessionScrollbackSnapshot(sessionId);
  },

  setSessionState: (sessionId, patch) => {
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            ...patch,
          },
        },
      };
    });
  },

  syncSessionStateFromSsh: (sessionId, sshState) => {
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            state: deriveSessionState(sshState),
            reconnectAttempts: sshState.reconnectAttempts,
            lastError: sshState.lastError,
            restoredFromScrollback: false,
            lastActiveAt: Date.now(),
          },
        },
      };
    });
  },

  appendOutput: (sessionId, data) => {
    if (!data) {
      return;
    }

    set((state) => ({
      outputs: {
        ...state.outputs,
        [sessionId]: `${state.outputs[sessionId] || ''}${data}`,
      },
    }));
  },

  replaceOutput: (sessionId, data) => {
    set((state) => ({
      outputs: {
        ...state.outputs,
        [sessionId]: data,
      },
    }));
  },

  setSessionCwd: (sessionId, cwd) => {
    get().setSessionState(sessionId, { cwd });
  },

  setPersistenceSettings: (settings) => {
    set((state) => ({
      persistenceSettings: {
        ...state.persistenceSettings,
        ...settings,
      },
    }));
  },

  persistSessionOutput: (sessionId) => {
    const state = get();
    const session = state.sessions[sessionId];
    if (!session) {
      return;
    }

    persistSessionScrollbackSnapshot(
      session,
      state.outputs[sessionId] || '',
      state.persistenceSettings,
    );
  },

  markIntentionalDisconnect: (sessionId) => {
    set((state) => ({
      intentionalDisconnectIds: state.intentionalDisconnectIds.includes(sessionId)
        ? state.intentionalDisconnectIds
        : [...state.intentionalDisconnectIds, sessionId],
    }));
  },

  consumeIntentionalDisconnect: (sessionId) => {
    const isIntentional = get().intentionalDisconnectIds.includes(sessionId);
    if (!isIntentional) {
      return false;
    }

    set((state) => ({
      intentionalDisconnectIds: state.intentionalDisconnectIds.filter((item) => item !== sessionId),
    }));
    return true;
  },
}));
