import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadRecentConnectionIds,
  markRecentConnection,
  sortConnectionsByRecent,
} from '../src/renderer/connection/recent-connections';

function installStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('ai-ssh-client:recent-connections:v1', initial);
  }
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal('window', { localStorage: storage });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sortConnectionsByRecent', () => {
  const connections = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
    { id: 'd', name: 'D' },
  ];

  it('puts recently connected connections first in recency order', () => {
    expect(sortConnectionsByRecent(connections, ['c', 'a']).map((item) => item.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('keeps the original order for connections that were never connected', () => {
    expect(sortConnectionsByRecent(connections, ['d']).map((item) => item.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });

  it('returns the same order when there is no recent history', () => {
    expect(sortConnectionsByRecent(connections, []).map((item) => item.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('recent connection persistence', () => {
  it('stores the newest connection first and de-duplicates it', () => {
    const storage = installStorage(JSON.stringify(['b', 'a']));

    expect(markRecentConnection('a')).toEqual(['a', 'b']);
    expect(storage.get('ai-ssh-client:recent-connections:v1')).toBe(JSON.stringify(['a', 'b']));
  });

  it('ignores malformed storage content', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installStorage('{not-json');

    expect(loadRecentConnectionIds()).toEqual([]);
  });
});
