import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearSessionCommands,
  getSessionCommands,
  recordSessionCommand,
} from '../src/renderer/history/session-command-buffer';
import {
  isHistoryNoise,
  mergeHistorySources,
  parseUnixHistory,
} from '../src/renderer/history/server-history';

describe('server-history', () => {
  it('parses bash history timestamps and keeps command order', () => {
    const entries = parseUnixHistory([
      '#1700000000',
      'ls -la',
      '#1700000600',
      'cd /var/log',
      '',
    ].join('\n'));

    expect(entries.map((entry) => entry.command)).toEqual(['ls -la', 'cd /var/log']);
    expect(entries[0].timestamp).toBe(1700000000000);
    expect(entries[1].timestamp).toBe(1700000600000);
  });

  it('parses zsh extended history', () => {
    const entries = parseUnixHistory([
      ': 1700000000:0;git status',
      ': 1700000060:3;docker ps',
    ].join('\n'));

    expect(entries.map((entry) => entry.command)).toEqual(['git status', 'docker ps']);
    expect(entries[1].timestamp).toBe(1700000060000);
  });

  it('filters app probe and agent wrapper noise', () => {
    const entries = parseUnixHistory([
      'ls',
      "stty -echo 2>/dev/null; printf '%s:%s\\n' '__AIS_PWD_abc__' \"$PWD\"; stty echo 2>/dev/null",
      "printf '\\n__AGENT_DONE_xyz__:%s\\n' \"$?\"",
      'pwd',
    ].join('\n'));

    expect(entries.map((entry) => entry.command)).toEqual(['ls', 'pwd']);
    expect(isHistoryNoise('__ais_ec=$?; printf ...')).toBe(true);
  });

  it('merges session commands first and remote history newest-first', () => {
    const merged = mergeHistorySources(
      [{ id: 'session-1', command: 'pwd', timestamp: 3, executedBy: 'user' }],
      [
        { id: 'remote-0', command: 'ls', timestamp: 1, executedBy: 'user' },
        { id: 'remote-1', command: 'cd /tmp', timestamp: 2, executedBy: 'user' },
      ],
    );

    expect(merged.map((entry) => entry.command)).toEqual(['pwd', 'cd /tmp', 'ls']);
  });
});

describe('session-command-buffer', () => {
  beforeEach(() => {
    clearSessionCommands('conn-1');
  });

  it('records commands in memory newest-first without persistence', () => {
    recordSessionCommand('conn-1', { command: ' ls ', executedBy: 'user' });
    recordSessionCommand('conn-1', { command: 'pwd', executedBy: 'ai' });

    expect(getSessionCommands('conn-1').map((entry) => entry.command)).toEqual(['pwd', 'ls']);
    expect(getSessionCommands('conn-1')[0].executedBy).toBe('ai');
  });
});
