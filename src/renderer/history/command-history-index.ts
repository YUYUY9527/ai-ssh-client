import type { CommandHistoryIndex, CommandHistoryItem } from '../../shared/types';

export const UNKNOWN_HOST = 'unknown-host';
export const UNKNOWN_USER = 'unknown-user';
export const DEFAULT_CWD = '~';

export interface CommandHistoryItemView extends CommandHistoryItem {
  /** Resolved cwd used for grouping when stored cwd is missing or weak. */
  effectiveCwd: string;
}

export interface CommandHistoryHostNode {
  host: string;
  usernames: CommandHistoryUserNode[];
  commandCount: number;
  latestTimestamp: number;
}

export interface CommandHistoryUserNode {
  host: string;
  username: string;
  cwds: CommandHistoryCwdNode[];
  commandCount: number;
  latestTimestamp: number;
}

export interface CommandHistoryCwdNode {
  host: string;
  username: string;
  cwd: string;
  commands: CommandHistoryItemView[];
  commandCount: number;
  latestTimestamp: number;
}

export interface CommandHistoryContext {
  host?: string;
  username?: string;
  cwd?: string;
  connectionId?: string;
}

function compareByTimestampDesc(left: number, right: number): number {
  return right - left;
}

function compareHistoryItems(left: CommandHistoryItem, right: CommandHistoryItem): number {
  return compareByTimestampDesc(left.timestamp, right.timestamp);
}

/** Normalize shell-like paths so `~/a/../b` and `/a//b` collapse consistently. */
export function normalizeHistoryPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '~') {
    return DEFAULT_CWD;
  }

  const isHomePath = trimmed.startsWith('~/');
  const isAbsolutePath = trimmed.startsWith('/');
  if (!isHomePath && !isAbsolutePath) {
    return trimmed;
  }

  const prefix = isHomePath ? '~' : '/';
  const rawSegments = (isHomePath ? trimmed.slice(2) : trimmed.slice(1)).split('/');
  const segments: string[] = [];

  rawSegments.forEach((segment) => {
    if (!segment || segment === '.') {
      return;
    }
    if (segment === '..') {
      segments.pop();
      return;
    }
    segments.push(segment);
  });

  if (prefix === '~') {
    return segments.length > 0 ? `~/${segments.join('/')}` : DEFAULT_CWD;
  }

  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

function resolveTrackedCwd(currentCwd: string, target: string): string | null {
  const sanitized = target.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!sanitized || sanitized === '~') {
    return DEFAULT_CWD;
  }
  if (sanitized === '-') {
    return null;
  }
  if (sanitized.startsWith('/') || sanitized.startsWith('~/')) {
    return normalizeHistoryPath(sanitized);
  }

  const base = normalizeHistoryPath(currentCwd || DEFAULT_CWD);
  if (base === DEFAULT_CWD) {
    return normalizeHistoryPath(`~/${sanitized}`);
  }
  return normalizeHistoryPath(`${base.replace(/\/$/, '')}/${sanitized}`);
}

/** Infer next cwd after a cd-like command. Returns null when unknown. */
export function nextTrackedCwd(currentCwd: string, command: string): string | null {
  const match = command.trim().match(/^cd(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }
  return resolveTrackedCwd(currentCwd, match[1] ?? '~');
}

function connectionKeyOf(item: CommandHistoryItem): string {
  return item.connectionId || item.connectionName || item.id;
}

/** Backfill effective cwd for legacy items missing reliable cwd metadata. */
export function enrichHistoryItems(historyList: CommandHistoryItem[]): CommandHistoryItemView[] {
  const cwdByConnection = new Map<string, string>();
  const chronological = [...historyList].sort((left, right) => left.timestamp - right.timestamp);

  const derived = chronological.map((item) => {
    const connectionKey = connectionKeyOf(item);
    const knownCwd = cwdByConnection.get(connectionKey);
    const storedCwd = item.cwd?.trim();
    const effectiveCwd = normalizeHistoryPath(
      (!storedCwd || storedCwd === DEFAULT_CWD) && knownCwd
        ? knownCwd
        : (storedCwd || knownCwd || DEFAULT_CWD),
    );

    const nextCwd = nextTrackedCwd(effectiveCwd, item.command);
    if (nextCwd) {
      cwdByConnection.set(connectionKey, nextCwd);
    } else if (storedCwd) {
      cwdByConnection.set(connectionKey, normalizeHistoryPath(storedCwd));
    } else if (!cwdByConnection.has(connectionKey)) {
      cwdByConnection.set(connectionKey, effectiveCwd);
    }

    return {
      ...item,
      host: item.host || UNKNOWN_HOST,
      username: item.username || UNKNOWN_USER,
      cwd: item.cwd ? normalizeHistoryPath(item.cwd) : item.cwd,
      effectiveCwd,
    };
  });

  return derived.sort(compareHistoryItems);
}

/** Flatten history into host/username/cwd buckets. */
export function buildCommandHistoryIndex(
  historyItems: CommandHistoryItem[],
): CommandHistoryIndex[] {
  const views = enrichHistoryItems(historyItems);
  const grouped = new Map<string, CommandHistoryIndex>();

  views.forEach((item) => {
    const host = item.host || UNKNOWN_HOST;
    const username = item.username || UNKNOWN_USER;
    const cwd = item.effectiveCwd || DEFAULT_CWD;
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

/** Build nested host → username → cwd tree for layered UI. */
export function buildCommandHistoryTree(
  historyItems: CommandHistoryItem[],
): CommandHistoryHostNode[] {
  const index = buildCommandHistoryIndex(historyItems);
  const hostMap = new Map<string, Map<string, CommandHistoryCwdNode[]>>();

  index.forEach((bucket) => {
    const userMap = hostMap.get(bucket.host) ?? new Map<string, CommandHistoryCwdNode[]>();
    const cwdNodes = userMap.get(bucket.username) ?? [];
    const latestTimestamp = bucket.commands[0]?.timestamp ?? 0;
    cwdNodes.push({
      host: bucket.host,
      username: bucket.username,
      cwd: bucket.cwd,
      commands: bucket.commands as CommandHistoryItemView[],
      commandCount: bucket.commands.length,
      latestTimestamp,
    });
    userMap.set(bucket.username, cwdNodes);
    hostMap.set(bucket.host, userMap);
  });

  return Array.from(hostMap.entries())
    .map(([host, userMap]) => {
      const usernames = Array.from(userMap.entries())
        .map(([username, cwds]) => {
          const sortedCwds = [...cwds].sort((left, right) => (
            compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
            || left.cwd.localeCompare(right.cwd)
          ));
          return {
            host,
            username,
            cwds: sortedCwds,
            commandCount: sortedCwds.reduce((sum, node) => sum + node.commandCount, 0),
            latestTimestamp: sortedCwds[0]?.latestTimestamp ?? 0,
          };
        })
        .sort((left, right) => (
          compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
          || left.username.localeCompare(right.username)
        ));

      return {
        host,
        usernames,
        commandCount: usernames.reduce((sum, node) => sum + node.commandCount, 0),
        latestTimestamp: usernames[0]?.latestTimestamp ?? 0,
      };
    })
    .sort((left, right) => (
      compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
      || left.host.localeCompare(right.host)
    ));
}

function matchesContext(
  item: CommandHistoryItemView,
  context?: CommandHistoryContext,
): boolean {
  if (!context) {
    return true;
  }
  if (context.connectionId && item.connectionId && item.connectionId === context.connectionId) {
    return true;
  }
  if (context.host && (item.host || UNKNOWN_HOST) !== context.host) {
    return false;
  }
  if (context.username && (item.username || UNKNOWN_USER) !== context.username) {
    return false;
  }
  if (context.cwd) {
    const target = normalizeHistoryPath(context.cwd);
    if (item.effectiveCwd !== target) {
      return false;
    }
  }
  return true;
}

/** Score items so current host/user/cwd surface first. */
export function scoreHistoryItem(
  item: CommandHistoryItemView,
  context?: CommandHistoryContext,
): number {
  if (!context) {
    return item.timestamp;
  }

  let score = item.timestamp;
  if (context.connectionId && item.connectionId === context.connectionId) {
    score += 1_000_000_000_000;
  }
  if (context.host && (item.host || UNKNOWN_HOST) === context.host) {
    score += 100_000_000_000;
  }
  if (context.username && (item.username || UNKNOWN_USER) === context.username) {
    score += 10_000_000_000;
  }
  if (context.cwd && item.effectiveCwd === normalizeHistoryPath(context.cwd)) {
    score += 1_000_000_000;
  }
  return score;
}

/** Query layered history with optional context and free-text search. */
export function queryCommandHistory(
  historyItems: CommandHistoryItem[],
  options?: {
    context?: CommandHistoryContext;
    search?: string;
    limit?: number;
    preferCurrentContext?: boolean;
  },
): CommandHistoryItemView[] {
  const views = enrichHistoryItems(historyItems);
  const search = options?.search?.trim().toLowerCase();
  const context = options?.context;

  let filtered = views;
  if (search) {
    filtered = filtered.filter((item) => (
      item.command.toLowerCase().includes(search)
      || (item.host || '').toLowerCase().includes(search)
      || (item.username || '').toLowerCase().includes(search)
      || item.effectiveCwd.toLowerCase().includes(search)
      || (item.connectionName || '').toLowerCase().includes(search)
    ));
  }

  if (context && !options?.preferCurrentContext) {
    filtered = filtered.filter((item) => matchesContext(item, context));
  }

  const sorted = [...filtered].sort((left, right) => {
    if (options?.preferCurrentContext) {
      const scoreDiff = scoreHistoryItem(right, context) - scoreHistoryItem(left, context);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
    }
    return compareHistoryItems(left, right);
  });

  if (options?.limit && options.limit > 0) {
    return sorted.slice(0, options.limit);
  }
  return sorted;
}

/** Deduped recent commands useful for autocomplete-style suggestions. */
export function getRecentCommandsForContext(
  historyItems: CommandHistoryItem[],
  context?: CommandHistoryContext,
  limit = 20,
): string[] {
  const items = queryCommandHistory(historyItems, {
    context,
    preferCurrentContext: true,
    limit: Math.max(limit * 3, 30),
  });

  const seen = new Set<string>();
  const commands: string[] = [];
  for (const item of items) {
    const command = item.command.trim();
    if (!command || seen.has(command)) {
      continue;
    }
    seen.add(command);
    commands.push(command);
    if (commands.length >= limit) {
      break;
    }
  }
  return commands;
}

/** Rank tree nodes so the active host/user/cwd bubble to the top. */
export function prioritizeHistoryTree(
  tree: CommandHistoryHostNode[],
  context?: CommandHistoryContext,
): CommandHistoryHostNode[] {
  if (!context?.host && !context?.username && !context?.cwd) {
    return tree;
  }

  const hostRank = (host: string) => (context.host && host === context.host ? 0 : 1);
  const userRank = (username: string) => (context.username && username === context.username ? 0 : 1);
  const cwdRank = (cwd: string) => (
    context.cwd && normalizeHistoryPath(context.cwd) === cwd ? 0 : 1
  );

  return [...tree]
    .map((hostNode) => ({
      ...hostNode,
      usernames: [...hostNode.usernames]
        .map((userNode) => ({
          ...userNode,
          cwds: [...userNode.cwds].sort((left, right) => (
            cwdRank(left.cwd) - cwdRank(right.cwd)
            || compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
            || left.cwd.localeCompare(right.cwd)
          )),
        }))
        .sort((left, right) => (
          userRank(left.username) - userRank(right.username)
          || compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
          || left.username.localeCompare(right.username)
        )),
    }))
    .sort((left, right) => (
      hostRank(left.host) - hostRank(right.host)
      || compareByTimestampDesc(left.latestTimestamp, right.latestTimestamp)
      || left.host.localeCompare(right.host)
    ));
}
