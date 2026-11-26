import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  applyTerminalHighlights,
  compileHighlightRules,
  DEFAULT_TERMINAL_HIGHLIGHT_RULES,
} from '../src/renderer/session/terminal/terminal-highlight';
import {
  detectZmodemSequence,
  parseSzCommandFiles,
  resolveRemotePath,
} from '../src/renderer/session/terminal/terminal-zmodem';
import { resolveTerminalRuntimeSettings } from '../src/renderer/session/terminal/terminal-settings';
import { computeLineDiff } from '../src/renderer/transfer/line-diff';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dockerManager = require('../server/docker-manager.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const monitor = require('../server/monitor.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sftpOps = require('../server/sftp-ops.cjs');

function createMockSshClient(handler: (cmd: string) => { output?: string; stderr?: string; exitCode?: number }) {
  const calls: string[] = [];
  const client = {
    exec(command: string, callback: (err: Error | null, stream?: EventEmitter & { stderr: EventEmitter }) => void) {
      calls.push(command);
      const res = handler(command);
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      queueMicrotask(() => {
        if (res.output) stream.emit('data', Buffer.from(res.output, 'utf8'));
        if (res.stderr) stream.stderr.emit('data', Buffer.from(res.stderr, 'utf8'));
        stream.emit('close', res.exitCode ?? 0);
      });
    },
  };
  return { client, calls };
}

describe('Docker & Compose lifecycle enhancements', () => {
  it('pulls images and rejects invalid image names', async () => {
    const { client, calls } = createMockSshClient(() => ({ output: 'Status: Downloaded newer image', exitCode: 0 }));
    const res = await dockerManager.pullImage(client, 'nginx:alpine');
    expect(res.image).toBe('nginx:alpine');
    expect(calls[0]).toContain('docker pull nginx:alpine');
    await expect(dockerManager.pullImage(client, 'nginx; rm -rf /')).rejects.toThrow(/Invalid image/);
  });

  it('runs a new container with ports, volumes, env, restart policy, and command', async () => {
    const { client, calls } = createMockSshClient(() => ({ output: 'abcdef1234567890\n', exitCode: 0 }));
    const res = await dockerManager.runContainer(client, {
      image: 'redis:7-alpine',
      name: 'cache-01',
      ports: ['6379:6379'],
      volumes: ['/data/redis:/data'],
      env: ['TZ=Asia/Shanghai'],
      restart: 'unless-stopped',
      network: 'app-net',
      command: 'redis-server --appendonly yes',
    });
    expect(res.containerId).toBe('abcdef1234567890');
    expect(calls[0]).toContain('docker run -d --name cache-01 --restart unless-stopped --network app-net -p 6379:6379 -v /data/redis:/data -e TZ=Asia/Shanghai redis:7-alpine redis-server --appendonly yes');
  });

  it('executes compose project lifecycle actions and fetches aggregated logs', async () => {
    const { client, calls } = createMockSshClient(() => ({ output: 'ok\n', exitCode: 0 }));
    await dockerManager.composeProjectAction(client, '/srv/app/docker-compose.yml', 'app', 'restart');
    expect(calls[0]).toContain('docker compose -f /srv/app/docker-compose.yml -p app restart');

    await dockerManager.composeProjectAction(client, '/srv/app/docker-compose.yml', 'app', 'up');
    expect(calls[1]).toContain('up -d');

    const logsRes = await dockerManager.composeProjectLogs(client, '/srv/app/docker-compose.yml', 'app', 100);
    expect(logsRes.logs).toContain('ok');
    expect(calls[2]).toContain('logs --tail 100 --timestamps --no-color');
  });

  it('passes --since to containerLogs when valid', async () => {
    const { client, calls } = createMockSshClient(() => ({ output: 'line1\n', exitCode: 0 }));
    await dockerManager.containerLogs(client, 'abc123', 200, { since: '1h' });
    expect(calls[0]).toContain('--since 1h');
  });
});

describe('Server monitor extensions (GPU, systemd logs/autostart, crontab, firewall)', () => {
  it('parses NVIDIA GPU lines from monitor output', () => {
    const parsed = monitor.parseMonitorOutput([
      'cpu=12',
      'mem_total_kb=1024',
      'mem_available_kb=512',
      'mem_used_kb=512',
      'mem_percent=50',
      'gpu|0|NVIDIA RTX 4090|68|12000|24576|64|285.4',
    ].join('\n'));
    expect(parsed.gpus).toHaveLength(1);
    expect(parsed.gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA RTX 4090',
      utilizationPercent: 68,
      memoryUsedMb: 12000,
      memoryTotalMb: 24576,
      temperatureC: 64,
      powerW: 285.4,
    });
  });

  it('supports systemd enable/disable and journalctl logs', async () => {
    const { client, calls } = createMockSshClient((cmd) => {
      if (cmd.includes('journalctl')) return { output: '2026-11-26T10:00:00Z nginx started\n', exitCode: 0 };
      return { output: '', exitCode: 0 };
    });
    await monitor.controlSystemdService(client, 'nginx.service', 'enable');
    expect(calls[0]).toContain('systemctl enable --');
    const logRes = await monitor.getSystemdServiceLogs(client, 'nginx.service', 120);
    expect(logRes.logs).toContain('nginx started');
  });

  it('reads and saves crontab safely', async () => {
    const { client, calls } = createMockSshClient((cmd) => {
      if (cmd.includes('command -v crontab')) return { output: '__OK__\n', exitCode: 0 };
      if (cmd.includes('crontab -l')) return { output: '# comment\n0 3 * * * /usr/bin/backup.sh\n@reboot /srv/init.sh\n', exitCode: 0 };
      return { output: '', exitCode: 0 };
    });
    const res = await monitor.getCrontab(client);
    expect(res.available).toBe(true);
    expect(res.entries).toEqual([
      { schedule: '0 3 * * *', command: '/usr/bin/backup.sh' },
      { schedule: '@reboot', command: '/srv/init.sh' },
    ]);
    await monitor.saveCrontab(client, '0 4 * * * echo hi');
    expect(calls[2]).toContain('base64 -d | crontab -');
  });

  it('parses ufw status and adds/deletes rules', async () => {
    const { client, calls } = createMockSshClient((cmd) => {
      if (cmd.includes('__FW_BACKEND__')) {
        return {
          output: '__FW_BACKEND__=ufw\nStatus: active\n[ 1] 22/tcp                     ALLOW IN    Anywhere\n[ 2] 8080/tcp                   ALLOW IN    Anywhere\n',
          exitCode: 0,
        };
      }
      return { output: 'Rule updated', exitCode: 0 };
    });
    const status = await monitor.getFirewallStatus(client);
    expect(status.backend).toBe('ufw');
    expect(status.active).toBe(true);
    expect(status.rules).toHaveLength(2);
    expect(status.rules[1]).toMatchObject({ id: '2', target: '8080/tcp', action: 'ALLOW' });

    await monitor.manageFirewallRule(client, { backend: 'ufw', action: 'allow', port: '443', protocol: 'tcp' });
    expect(calls[1]).toBe('ufw allow 443/tcp');
  });
});

describe('Terminal highlight, ZMODEM detection, and settings', () => {
  it('highlights plain keywords while skipping ANSI sequences and alternate screen', () => {
    const rules = compileHighlightRules(DEFAULT_TERMINAL_HIGHLIGHT_RULES);
    const highlighted = applyTerminalHighlights('2026 ERROR connecting to 10.0.0.1\n', rules, false);
    expect(highlighted).toContain('\x1b[1;31mERROR\x1b[0m');
    expect(highlighted).toContain('\x1b[36m10.0.0.1\x1b[0m');

    // Alternate screen must be untouched
    const raw = 'ERROR in vim';
    expect(applyTerminalHighlights(raw, rules, true)).toBe(raw);

    // Already-colored ANSI segment must stay untouched
    const colored = '\x1b[32mERROR\x1b[0m plain WARN';
    const out = applyTerminalHighlights(colored, rules, false);
    expect(out).toContain('\x1b[32mERROR\x1b[0m');
    expect(out).toContain('\x1b[1;33mWARN\x1b[0m');
  });

  it('detects ZMODEM rz/sz headers and parses sz filenames', () => {
    const sz = detectZmodemSequence('rz\r**\x18B00000000000000\r\n');
    expect(sz.kind).toBe('sz');
    expect(sz.cleanedChunk).toBe('');

    const rz = detectZmodemSequence('**\x18B0100000023be50\r\n');
    expect(rz.kind).toBe('rz');

    expect(parseSzCommandFiles('sz -be "app log.txt" /var/log/a.log')).toEqual(['app log.txt', '/var/log/a.log']);
    expect(resolveRemotePath('/var/log', './nginx.log')).toBe('/var/log/nginx.log');
    expect(resolveRemotePath('/var/log', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('normalizes webgl, highlights, and zmodem runtime settings', () => {
    const defaults = resolveTerminalRuntimeSettings({});
    expect(defaults.webgl).toBe(false);
    expect(defaults.highlightsEnabled).toBe(false);
    expect(defaults.zmodem).toBe(true);

    const custom = resolveTerminalRuntimeSettings({
      terminalWebgl: true,
      terminalHighlightsEnabled: true,
      terminalZmodem: false,
    });
    expect(custom.webgl).toBe(true);
    expect(custom.highlightsEnabled).toBe(true);
    expect(custom.zmodem).toBe(false);
  });
});

describe('SFTP chunk reader & line diff', () => {
  it('computes accurate added/removed/unchanged lines', () => {
    const diff = computeLineDiff('a\nb\nc\nd', 'a\nb2\nc\nd\ne');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(3);
    expect(diff.lines.some((l) => l.kind === 'remove' && l.text === 'b')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'add' && l.text === 'b2')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'add' && l.text === 'e')).toBe(true);
  });

  it('reads remote file chunks and tail slices via SSH exec', async () => {
    const { client, calls } = createMockSshClient((cmd) => {
      if (cmd.includes('stat -c %s')) return { output: '204800\n', exitCode: 0 };
      return { output: 'chunk-body', exitCode: 0 };
    });
    const chunk = await sftpOps.readRemoteFileChunk(client, {
      remotePath: '/var/log/big.log',
      mode: 'chunk',
      offset: 65536,
      length: 65536,
    });
    expect(chunk.totalBytes).toBe(204800);
    expect(chunk.offset).toBe(65536);
    expect(chunk.hasMore).toBe(true);
    expect(chunk.content).toBe('chunk-body');
    expect(calls[1]).toContain('tail -c +65537');
  });
});
