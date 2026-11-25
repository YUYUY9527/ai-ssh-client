import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const totp = require('../server/totp.cjs');
const { createAuditLogger } = require('../server/audit-log.cjs');
const sshKeys = require('../server/ssh-keys.cjs');
const { createPortForwardManager } = require('../server/port-forward.cjs');
const agentTools = require('../server/agent-tools.cjs');
const sftpOps = require('../server/sftp-ops.cjs');
const monitor = require('../server/monitor.cjs');
const dockerManager = require('../server/docker-manager.cjs');
const { createAuth } = require('../server/auth.cjs');
const mcpPolicy = require('../server/mcp/policy.cjs');
const mcpPolicyFile = require('../server/mcp/policy-file.cjs');

/** 创建一个假 ssh2 client，拦截 exec 调用并返回预设 stdout/stderr/exitCode。 */
function makeMockExecClient(handler: (cmd: string) => { stdout?: string; stderr?: string; exitCode?: number }) {
  return {
    exec(cmd: string, cb: (err: Error | null, stream?: EventEmitter & { stderr: EventEmitter }) => void) {
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      cb(null, stream);
      queueMicrotask(() => {
        const res = handler(cmd);
        if (res.stdout) stream.emit('data', Buffer.from(res.stdout, 'utf8'));
        if (res.stderr) stream.stderr.emit('data', Buffer.from(res.stderr, 'utf8'));
        stream.emit('close', res.exitCode ?? 0);
      });
    },
  };
}

describe('TOTP 2FA (RFC 6238)', () => {
  it('generates valid Base32 secret, deterministic codes, and verifies within ±1 window', () => {
    const secret = totp.generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const t0 = 1_700_000_000_000;
    const code = totp.generateTotpCode(secret, t0);
    expect(code).toMatch(/^\d{6}$/);
    expect(totp.verifyTotpCode(secret, code, { nowMs: t0 })).toBe(true);
    expect(totp.verifyTotpCode(secret, code, { nowMs: t0 + 30_000 })).toBe(true);
    expect(totp.verifyTotpCode(secret, code, { nowMs: t0 + 120_000 })).toBe(false);
    expect(totp.verifyTotpCode(secret, '00000', { nowMs: t0 })).toBe(false);

    const uri = totp.buildOtpAuthUri({ secret, account: 'ops@example.com', issuer: 'AI SSH Client' });
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('period=30');
  });
});

describe('Global Operational Audit Log', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aissh-audit-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records JSONL entries and filters by category/search newest-first', () => {
    const logger = createAuditLogger(tmpDir);
    logger.record({ category: 'ssh', action: 'connect', actor: 'alice', target: 'prod-1', outcome: 'ok' });
    logger.record({ category: 'sftp', action: 'delete', actor: 'bob', target: '/etc/foo', outcome: 'denied', detail: 'readonly' });
    logger.record({ category: 'docker', action: 'restart', actor: 'alice', target: 'nginx', outcome: 'ok' });

    const all = logger.query({ limit: 10 });
    expect(all).toHaveLength(3);
    expect(all[0].action).toBe('restart');
    expect(all[2].action).toBe('connect');

    const sftpOnly = logger.query({ category: 'sftp' });
    expect(sftpOnly).toHaveLength(1);
    expect(sftpOnly[0].outcome).toBe('denied');

    const byAlice = logger.query({ search: 'alice' });
    expect(byAlice).toHaveLength(2);
  });
});

describe('SSH Key Vault & credential resolution', () => {
  it('generates Ed25519 and RSA key pairs, summarizes without private key, and resolves connection + jump host refs', () => {
    const ed = sshKeys.generateSshKeyPair({ name: 'ops-ed', algorithm: 'ed25519' });
    expect(ed.algorithm).toBe('ssh-ed25519');
    expect(ed.fingerprint).toMatch(/^SHA256:/);
    expect(ed.publicKey).toMatch(/^ssh-ed25519 /);
    expect(ed.privateKey).toContain('BEGIN PRIVATE KEY');

    const summary = sshKeys.summarizeSshKey(ed);
    expect((summary as Record<string, unknown>).privateKey).toBeUndefined();
    expect(summary.fingerprint).toBe(ed.fingerprint);

    const rsa = sshKeys.generateSshKeyPair({ name: 'ops-rsa', algorithm: 'rsa-2048' });
    expect(rsa.algorithm).toBe('ssh-rsa');
    expect(rsa.publicKey).toMatch(/^ssh-rsa /);

    const inspected = sshKeys.inspectPrivateKey(rsa.privateKey);
    expect(inspected.fingerprint).toBe(rsa.fingerprint);

    const store = {
      sshKeys: [ed, rsa],
      connections: [
        { id: 'bastion', host: '10.0.0.1', port: 2222, username: 'jump', keyId: rsa.id },
      ],
    };
    const resolved = sshKeys.resolveConnectionCredentials(
      {
        id: 'app',
        host: '10.0.1.5',
        port: 22,
        username: 'ubuntu',
        keyId: ed.id,
        jumpHosts: [{ connectionId: 'bastion' }],
      },
      store,
    );
    expect(resolved.privateKey).toBe(ed.privateKey);
    expect(resolved.jumpHosts[0].host).toBe('10.0.0.1');
    expect(resolved.jumpHosts[0].port).toBe(2222);
    expect(resolved.jumpHosts[0].username).toBe('jump');
    expect(resolved.jumpHosts[0].privateKey).toBe(rsa.privateKey);
  });

  it('deploys OpenSSH public key idempotently via base64 script', async () => {
    const ed = sshKeys.generateSshKeyPair({ name: 'deploy-test', algorithm: 'ed25519' });
    let capturedCmd = '';
    const client = makeMockExecClient((cmd) => {
      capturedCmd = cmd;
      return { stdout: 'DEPLOYED\n', exitCode: 0 };
    });
    const res = await sshKeys.deployPublicKeyToServer(client, ed.publicKey);
    expect(res).toEqual({ deployed: true, alreadyPresent: false });
    expect(capturedCmd).toContain('authorized_keys');
    expect(capturedCmd).toContain('base64 -d');

    await expect(sshKeys.deployPublicKeyToServer(client, 'not-a-valid-key')).rejects.toThrow(/Invalid OpenSSH public key/);
  });
});

describe('Agent pane_output tool & ANSI stripping', () => {
  it('strips ANSI sequences and returns last N lines within byte cap', () => {
    const raw = '\x1b[32mhello\x1b[0m\nline2\n\x1b]0;title\x07line3\nline4';
    expect(agentTools.stripAnsiSequences(raw)).toBe('hello\nline2\nline3\nline4');

    const res = agentTools.readPaneOutput(raw, { lines: 2 });
    expect(res.totalLines).toBe(4);
    expect(res.lines).toBe(2);
    expect(res.content).toBe('line3\nline4');
    expect(agentTools.TOOL_NAMES).toContain('pane_output');
  });
});

describe('SSH Remote Port Forwarding (-R)', () => {
  it('calls client.forwardIn on start and client.unforwardIn on stop', () => {
    const calls: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      forwardIn(host: string, port: number, cb: (err: Error | null, assigned?: number) => void) {
        calls.push(`forwardIn:${host}:${port}`);
        cb(null, port || 18080);
      },
      unforwardIn(host: string, port: number, cb: () => void) {
        calls.push(`unforwardIn:${host}:${port}`);
        cb();
      },
    });
    const manager = createPortForwardManager({
      getClientForSession: () => ({ client }),
    });
    const state = manager.start({
      clientId: 'c1',
      connectionId: 'conn-1',
      rule: {
        id: 'rf-1',
        type: 'remote',
        bindHost: '127.0.0.1',
        bindPort: 9090,
        targetHost: '127.0.0.1',
        targetPort: 3000,
      },
    });
    expect(state.type).toBe('remote');
    expect(state.bindPort).toBe(9090);
    expect(calls).toContain('forwardIn:127.0.0.1:9090');

    manager.stop({ clientId: 'c1', connectionId: 'conn-1', ruleId: 'rf-1' });
    expect(calls).toContain('unforwardIn:127.0.0.1:9090');
  });
});

describe('SFTP advanced ops (archive/extract/copy/move/symlink/chown)', () => {
  it('constructs POSIX-quoted commands and rejects NUL or traversal names', async () => {
    const executed: string[] = [];
    const client = makeMockExecClient((cmd) => {
      executed.push(cmd);
      return { stdout: '', exitCode: 0 };
    });

    await sftpOps.archiveRemoteItems(client, { baseDir: '/var/log', names: ['app.log', 'nginx.log'], archiveName: 'logs', format: 'tar.gz' });
    expect(executed[0]).toContain("tar -czf '/var/log/logs.tar.gz' -C '/var/log' -- 'app.log' 'nginx.log'");

    await sftpOps.extractRemoteArchive(client, { archivePath: '/tmp/bundle.zip', destinationDir: '/tmp/out' });
    expect(executed[1]).toContain("unzip -qo '/tmp/bundle.zip' -d '/tmp/out'");

    await sftpOps.copyOrMoveRemoteItems(client, { sources: ['/a/b'], destinationDir: '/c', mode: 'move' });
    expect(executed[2]).toBe("mv -- '/a/b' '/c'");

    await sftpOps.createRemoteSymlink(client, { targetPath: '/opt/v2', linkPath: '/opt/current' });
    expect(executed[3]).toBe("ln -s -- '/opt/v2' '/opt/current'");

    await sftpOps.chownRemoteItem(client, { remotePath: '/srv/app', owner: 'www-data', group: 'www-data', recursive: true });
    expect(executed[4]).toBe("chown -R -- 'www-data:www-data' '/srv/app'");

    await expect(sftpOps.archiveRemoteItems(client, { baseDir: '/tmp', names: ['../etc'] })).rejects.toThrow(/Invalid archive entry/);
    await expect(sftpOps.chownRemoteItem(client, { remotePath: '/tmp/x', owner: 'root;rm -rf /' })).rejects.toThrow(/Invalid owner\/group/);
  });
});

describe('Cross-platform Monitor, Ports, Services & Process Kill', () => {
  it('supports macOS/FreeBSD branches and validates killRemoteProcess / controlSystemdService', async () => {
    expect(monitor.MONITOR_SCRIPT).toContain('Darwin');
    expect(monitor.MONITOR_SCRIPT).toContain('FreeBSD');
    expect(monitor.MONITOR_SCRIPT).not.toContain('${');

    const cmds: string[] = [];
    const client = makeMockExecClient((cmd) => {
      cmds.push(cmd);
      if (cmd.includes('ss -tulnp')) {
        return { stdout: 'tcp|LISTEN|0.0.0.0:80|users:(("nginx",pid=1234,fd=6))\n', exitCode: 0 };
      }
      if (cmd.includes('systemctl list-units')) {
        return { stdout: 'nginx.service loaded active running Nginx HTTP Server\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });

    const portsRes = await monitor.listListeningPorts(client);
    expect(portsRes.ports).toEqual([{ protocol: 'tcp', state: 'LISTEN', address: '0.0.0.0:80', process: 'users:(("nginx",pid=1234,fd=6))' }]);

    const servicesRes = await monitor.listSystemdServices(client);
    expect(servicesRes.available).toBe(true);
    expect(servicesRes.services[0]).toMatchObject({ name: 'nginx.service', active: 'active', sub: 'running' });

    await monitor.killRemoteProcess(client, 4321, 'TERM');
    expect(cmds[cmds.length - 1]).toBe('kill -TERM 4321');

    await expect(monitor.killRemoteProcess(client, 1, 'KILL')).rejects.toThrow();
    await expect(monitor.controlSystemdService(client, 'bad;name', 'restart')).rejects.toThrow();
  });
});

describe('Docker extended management & sudo fallback', () => {
  it('falls back to sudo -n docker on permission denied and parses images/volumes/networks/stats', async () => {
    const seen: string[] = [];
    const client = makeMockExecClient((cmd) => {
      seen.push(cmd);
      if (cmd.startsWith('docker ')) {
        return { stderr: 'permission denied while trying to connect to the Docker daemon socket', exitCode: 1 };
      }
      if (cmd.includes('images --format')) {
        return { stdout: '{"ID":"abc123","Repository":"nginx","Tag":"latest","Size":"142MB","CreatedSince":"2 weeks ago"}\n', exitCode: 0 };
      }
      if (cmd.includes('stats --no-stream')) {
        return { stdout: '{"ID":"c1","Name":"web","CPUPerc":"1.50%","MemUsage":"20MiB / 4GiB","MemPerc":"0.50%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"4"}\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });

    const imagesRes = await dockerManager.listImages(client);
    expect(imagesRes.images).toHaveLength(1);
    expect(imagesRes.images[0]).toMatchObject({ id: 'abc123', repository: 'nginx', tag: 'latest' });
    expect(seen.some((c) => c.startsWith('sudo -n docker '))).toBe(true);

    const statsRes = await dockerManager.containerStats(client);
    expect(statsRes.stats[0]).toMatchObject({ id: 'c1', name: 'web', cpuPerc: '1.50%' });
  });
});

describe('Web Auth TOTP 2FA & Multi-User RBAC', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aissh-rbac-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces TOTP 2FA setup/enable/disable and multi-user RBAC connection scoping', () => {
    const auth = createAuth(tmpDir);
    expect(auth.isTotpEnabled()).toBe(false);

    const setup = auth.setupTotp();
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    const code = totp.generateTotpCode(setup.secret);
    const enabled = auth.enableTotp(code);
    expect(enabled.totpEnabled).toBe(true);
    expect(auth.isTotpEnabled()).toBe(true);

    const disabled = auth.disableTotp(totp.generateTotpCode(setup.secret));
    expect(disabled.totpEnabled).toBe(false);

    // Multi-user RBAC
    const created = auth.saveUser({
      username: 'viewer1',
      password: 'viewer-password-123',
      role: 'viewer',
      allowedConnectionIds: ['conn-a'],
    });
    expect(created.username).toBe('viewer1');
    expect(created.role).toBe('viewer');
    expect(auth.listUsers()).toHaveLength(1);

    // Simulate login for viewer1 to obtain signed session cookie
    let setCookie = '';
    let loginStatus = 200;
    auth.handleLogin(
      { body: { username: 'viewer1', password: 'viewer-password-123' }, headers: {}, ip: '127.0.0.1' },
      {
        status(code: number) { loginStatus = code; return this; },
        cookie(name: string, value: string) { setCookie = `${name}=${value}`; return this; },
        json() {},
      },
    );
    expect(loginStatus).toBe(200);
    const cookieHeader = setCookie.split(';')[0];
    const viewerReq = { headers: { cookie: cookieHeader } };
    expect(auth.getSessionUser(viewerReq)?.username).toBe('viewer1');
    expect(auth.canAccessConnection(viewerReq, 'conn-a')).toBe(true);
    expect(auth.canAccessConnection(viewerReq, 'conn-b')).toBe(false);

    expect(auth.deleteUser(created.id)).toBe(true);
    expect(auth.listUsers()).toHaveLength(0);
  });
});

describe('MCP extended policy (allowWrite, connectionRoots, connectionCommandPrefixes)', () => {
  it('validates and enforces per-connection roots and command prefixes', () => {
    const normalized = mcpPolicyFile.normalizePolicy({
      defaultMode: 'exec',
      allowWrite: true,
      connectionRoots: { prod: ['/srv/app', '/var/log'] },
      connectionCommandPrefixes: { prod: ['systemctl status', 'docker ps'] },
    });
    expect(normalized.allowWrite).toBe(true);
    expect(normalized.connectionRoots.prod).toEqual(['/srv/app', '/var/log']);

    const policy = mcpPolicy.createPolicy({}, { filePolicy: normalized });
    const conn = { id: 'prod', name: 'prod' };

    expect(policy.allowWrite).toBe(true);
    expect(policy.checkPathAllowed('/srv/app/config.yaml', conn).allowed).toBe(true);
    expect(policy.checkPathAllowed('/etc/shadow', conn).allowed).toBe(false);

    expect(policy.evaluateCommand('docker ps -a', { connection: conn }).allowed).toBe(true);
    expect(policy.evaluateCommand('ls -la', { connection: conn }).allowed).toBe(false);
    // Chaining must not bypass prefix whitelist
    expect(policy.evaluateCommand('docker ps && cat /etc/passwd', { connection: conn }).allowed).toBe(false);
  });
});
