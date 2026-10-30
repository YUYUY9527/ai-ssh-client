import { describe, expect, it } from 'vitest';

import {
  connectionFingerprint,
  createBudget,
  createOutputCollector,
  describeAttributes,
} from '../server/mcp/ssh.cjs';

describe('connection fingerprint', () => {
  const base = {
    host: '10.0.0.9',
    port: 22,
    username: 'root',
    password: 'pw',
  };

  it('is stable for identical config and changes whenever a connection field changes', () => {
    expect(connectionFingerprint({ ...base })).toBe(connectionFingerprint({ ...base }));

    const variants = [
      { ...base, host: '10.0.0.10' },
      { ...base, port: 2222 },
      { ...base, username: 'admin' },
      { ...base, password: 'other' },
      { ...base, password: '', privateKey: '-----BEGIN KEY-----' },
      { ...base, password: '', privateKey: '-----BEGIN KEY-----', passphrase: 'pp' },
    ];
    for (const variant of variants) {
      expect(connectionFingerprint(variant)).not.toBe(connectionFingerprint(base));
    }
  });

  it('never embeds raw credentials in the fingerprint', () => {
    const fingerprint = connectionFingerprint({ ...base, password: 'super-secret' });
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('super-secret');
    expect(fingerprint).not.toContain('root');
  });
});

describe('mcp ssh output budget', () => {
  it('caps output at the configured byte budget', () => {
    const collector = createOutputCollector(createBudget(10));
    collector.append(Buffer.from('abcdef'));
    collector.append(Buffer.from('ghijkl'));

    expect(collector.toString()).toBe('abcdefghij');
    expect(collector.bytes).toBe(10);
    expect(collector.truncated).toBe(true);
  });

  it('shares one budget between stdout and stderr', () => {
    const budget = createBudget(8);
    const stdout = createOutputCollector(budget);
    const stderr = createOutputCollector(budget);
    stdout.append(Buffer.from('123456'));
    stderr.append(Buffer.from('abcdef'));

    expect(stdout.toString()).toBe('123456');
    expect(stderr.toString()).toBe('ab');
    expect(stderr.truncated).toBe(true);
    expect(budget.exhausted).toBe(true);
  });

  it('does not truncate output that fits exactly', () => {
    const collector = createOutputCollector(createBudget(3));
    collector.append(Buffer.from('abc'));
    expect(collector.truncated).toBe(false);
  });

  it('normalizes ssh2 attributes into JSON-safe values', () => {
    const attrs = {
      isDirectory: () => false,
      isSymbolicLink: () => true,
      mode: 0o100644,
      size: 42,
      mtime: 1700000000,
      uid: 0,
      gid: 1000,
    };
    expect(describeAttributes(attrs)).toEqual({
      type: 'symlink',
      size: 42,
      mode: '644',
      modifiedAt: new Date(1700000000 * 1000).toISOString(),
      uid: 0,
      gid: 1000,
    });
  });
});