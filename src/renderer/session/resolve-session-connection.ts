import type { SSHConnection } from '../../shared/types';

/**
 * Resolves a saved connection for a tab/session id.
 * Temp clones use `${baseId}-session-...` and are not stored in the connection list.
 */
export function resolveSessionConnection(
  connections: SSHConnection[],
  sessionId: string,
  preferredConnectionId?: string,
): SSHConnection | null {
  if (!sessionId) {
    return null;
  }

  // Prefer explicit base connection id from session store
  if (preferredConnectionId) {
    const preferred = connections.find((item) => item.id === preferredConnectionId);
    if (preferred) {
      return preferred;
    }
  }

  const exact = connections.find((item) => item.id === sessionId);
  if (exact) {
    return exact;
  }

  // Longest base-id match avoids ambiguity when ids share prefixes
  const clones = connections
    .filter((item) => sessionId.startsWith(`${item.id}-session-`))
    .sort((left, right) => right.id.length - left.id.length);

  return clones[0] ?? null;
}

/** Builds a runtime connection payload that keeps the temporary session id. */
export function buildRuntimeConnection(
  base: SSHConnection,
  sessionId: string,
  nameOverride?: string,
): SSHConnection {
  return {
    ...base,
    id: sessionId,
    name: nameOverride ?? base.name,
  };
}
