import type { CommandHistoryIndex, CommandHistoryItem } from '../../shared/types';

function compareHistoryItems(left: CommandHistoryItem, right: CommandHistoryItem): number {
  return right.timestamp - left.timestamp;
}

/** Groups command history into host -> username -> cwd buckets. */
export function buildCommandHistoryIndex(
  historyItems: CommandHistoryItem[],
): CommandHistoryIndex[] {
  const grouped = new Map<string, CommandHistoryIndex>();

  historyItems.forEach((item) => {
    const host = item.host || 'unknown-host';
    const username = item.username || 'unknown-user';
    const cwd = item.cwd || '~';
    const bucketKey = `${host}::${username}::${cwd}`;

    const bucket = grouped.get(bucketKey) ?? {
      host,
      username,
      cwd,
      commands: [],
    };
    bucket.commands.push(item);
    grouped.set(bucketKey, bucket);
  });

  return Array.from(grouped.values())
    .map((bucket) => ({
      ...bucket,
      commands: [...bucket.commands].sort(compareHistoryItems),
    }))
    .sort((left, right) => {
      if (left.host !== right.host) {
        return left.host.localeCompare(right.host);
      }
      if (left.username !== right.username) {
        return left.username.localeCompare(right.username);
      }
      return left.cwd.localeCompare(right.cwd);
    });
}
