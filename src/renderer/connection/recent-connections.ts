const STORAGE_KEY = 'ai-ssh-client:recent-connections:v1';
const RECENT_LIMIT = 50;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** 读取最近连接过的连接 id，最近的排在前面。 */
export function loadRecentConnectionIds(): string[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(new Set(parsed.filter((item): item is string => typeof item === 'string')));
  } catch (error) {
    console.error('Failed to read recent connections:', error);
    return [];
  }
}

/** 记录一次成功连接，返回更新后的最近连接列表。 */
export function markRecentConnection(connectionId: string): string[] {
  if (!connectionId) {
    return loadRecentConnectionIds();
  }

  const next = [
    connectionId,
    ...loadRecentConnectionIds().filter((item) => item !== connectionId),
  ].slice(0, RECENT_LIMIT);

  if (canUseStorage()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.error('Failed to persist recent connections:', error);
    }
  }

  return next;
}

/** 按最近连接顺序排序；没连接过的连接保持原有顺序排在后面。 */
export function sortConnectionsByRecent<T extends { id: string }>(
  connections: T[],
  recentConnectionIds: string[],
): T[] {
  const rank = new Map(recentConnectionIds.map((id, index) => [id, index]));

  return connections
    .map((connection, index) => ({ connection, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.connection.id);
      const rightRank = rank.get(right.connection.id);
      if (leftRank !== undefined && rightRank !== undefined) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) {
        return -1;
      }
      if (rightRank !== undefined) {
        return 1;
      }
      return left.index - right.index;
    })
    .map((item) => item.connection);
}
