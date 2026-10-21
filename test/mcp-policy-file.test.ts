import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultPolicy,
  normalizePolicy,
  overriddenEnvVars,
  readPolicyFile,
  resolvePolicyPath,
  writePolicyFile,
} from '../server/mcp/policy-file.cjs';

let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ssh-mcp-policy-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('mcp policy file', () => {
  it('returns the read-only default when no file exists', () => {
    const snapshot = readPolicyFile({ dataDir, env: {} });
    expect(snapshot.exists).toBe(false);
    expect(snapshot.path).toBe(path.join(dataDir, 'mcp-policy.json'));
    expect(snapshot.policy).toEqual(createDefaultPolicy());
    expect(snapshot.policy.defaultMode).toBe('read-only');
  });

  it('writes a canonical file and reads it back', () => {
    const saved = writePolicyFile({
      dataDir,
      env: {},
      policy: {
        defaultMode: 'exec',
        connections: { lab: 'exec', prod: 'read-only' },
        commands: { exceptions: ['systemctl restart nginx'] },
      },
    });

    expect(saved.exists).toBe(true);
    expect(saved.path).toBe(path.join(dataDir, 'mcp-policy.json'));
    expect(saved.policy.limits.maxOutputBytes).toBe(createDefaultPolicy().limits.maxOutputBytes);

    const raw = JSON.parse(fs.readFileSync(saved.path, 'utf8'));
    expect(raw.connections).toEqual({ lab: 'exec', prod: 'read-only' });
    expect(raw.trustOnFirstUse).toBe(false);
    expect(raw.audit.enabled).toBe(true);

    const snapshot = readPolicyFile({ dataDir, env: {} });
    expect(snapshot.policy).toEqual(saved.policy);
  });

  it('rejects unknown fields and invalid values instead of silently ignoring them', () => {
    expect(() => writePolicyFile({ dataDir, env: {} })).toThrow(/必须提供 policy/);
    expect(() => normalizePolicy({ defualtMode: 'exec' })).toThrow(/未知字段 "defualtMode"/);
    expect(() => normalizePolicy({ defaultMode: 'write' })).toThrow(/defaultMode/);
    expect(() => normalizePolicy({ connections: { lab: 'root' } })).toThrow(/connections\["lab"\]/);
    expect(() => normalizePolicy({ commands: { deny: ['('] } })).toThrow(/commands\.deny\[0\]/);
    expect(() => normalizePolicy({ commands: { exceptions: [''] } })).toThrow(/commands\.exceptions\[0\]/);
    expect(() => normalizePolicy({ limits: { execTimeoutMs: 999 } })).toThrow(/limits\.execTimeoutMs/);
    expect(() => normalizePolicy({ limits: { maxOutputBytes: 'big' } })).toThrow(/limits\.maxOutputBytes/);
    expect(() => normalizePolicy({ audit: { enabled: 'yes' } })).toThrow(/audit\.enabled/);
  });

  it('deduplicates exceptions and keeps order', () => {
    const policy = normalizePolicy({
      commands: { exceptions: ['b', 'a', 'b'] },
    });
    expect(policy.commands.exceptions).toEqual(['b', 'a']);
  });

  it('fails loudly on malformed JSON and reports the path', () => {
    const file = path.join(dataDir, 'mcp-policy.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => readPolicyFile({ dataDir, env: {} })).toThrow(/不是合法 JSON/);
    expect(() => readPolicyFile({ dataDir, env: {} })).toThrow(file);
  });

  it('honors MCP_POLICY_FILE for both absolute and relative paths', () => {
    expect(resolvePolicyPath({ dataDir, env: { MCP_POLICY_FILE: 'custom.json' } }))
      .toBe(path.join(dataDir, 'custom.json'));
    const absolute = path.join(dataDir, 'absolute.json');
    expect(resolvePolicyPath({ dataDir, env: { MCP_POLICY_FILE: absolute } })).toBe(absolute);
  });

  it('lists env vars that override the file', () => {
    expect(overriddenEnvVars({})).toEqual([]);
    expect(overriddenEnvVars({
      MCP_ALLOW_EXEC: '1',
      MCP_AUDIT: '0',
      MCP_POLICY_FILE: '/tmp/x.json',
      UNRELATED: '1',
    })).toEqual(['MCP_ALLOW_EXEC', 'MCP_AUDIT']);
  });
});