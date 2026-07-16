import { describe, it, expect } from 'vitest';
import {
  nextTrackedCwd,
  normalizeHistoryPath,
} from '../src/renderer/history/command-history-index';

describe('command-history-index', () => {
  it('normalizes history paths', () => {
    expect(normalizeHistoryPath('~/..')).toBe('~/..');
    expect(normalizeHistoryPath('~/project/../..')).toBe('~/..');
  });

  it('tracks cwd changes from cd commands', () => {
    expect(nextTrackedCwd('~', 'cd ..')).toBe('~/..');
    expect(nextTrackedCwd('~', 'cd ../shared')).toBe('~/../shared');
    expect(nextTrackedCwd('/var/log', 'cd ..')).toBe('/var');
  });
});
