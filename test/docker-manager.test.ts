import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  quoteArg,
  parseContainerLines,
  listContainers,
  inspectContainer,
  containerAction,
  containerLogs,
} = require('../server/docker-manager.cjs');

function fakeClient(handler: (command: string) => { stdout?: string; stderr?: string; code: number }) {
  return {
    exec(command: string, callback: (error: Error | null, stream: any) => void) {
      const stream: any = new EventEmitter();
      stream.stderr = new EventEmitter();
      const result = handler(command);
      setImmediate(() => {
        if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
        if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
        stream.emit('close', result.code);
      });
      callback(null, stream);
    },
  };
}

describe('docker-manager', () => {
  it('quoteArg 做 POSIX 单引号转义，防注入', () => {
    expect(quoteArg('web-1')).toBe("'web-1'");
    expect(quoteArg("a'b; rm -rf /")).toBe("'a'\\''b; rm -rf /'");
  });

  it('容器 id 只引用一次，不会被二次加引号', async () => {
    const commands: string[] = [];
    const client = fakeClient((command) => {
      commands.push(command);
      if (command.startsWith('docker inspect')) return { stdout: JSON.stringify([{ Id: 'cid', Name: '/web', State: { Running: true }, Config: { Image: 'nginx' }, NetworkSettings: { Networks: {} } }]), code: 0 };
      if (command.startsWith('docker logs')) return { stdout: 'ok\n', code: 0 };
      if (command.startsWith('docker stop')) return { stdout: 'cid\n', code: 0 };
      return { code: 0 };
    });
    await inspectContainer(client, 'cid');
    await containerLogs(client, 'cid', 5);
    await containerAction(client, 'cid', 'stop');
    expect(commands.some((command) => command.includes("'cid'"))).toBe(false);
    expect(commands.some((command) => command.includes('docker inspect cid'))).toBe(true);
    expect(commands.some((command) => command.includes('docker logs --tail 5 --timestamps cid'))).toBe(true);
    expect(commands.some((command) => command.includes('docker stop cid'))).toBe(true);
  });

  it('parseContainerLines 解析逐行 JSON 并忽略无效行', () => {
    const output = [
      JSON.stringify({ ID: 'abc', Names: 'web', Image: 'nginx:latest', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:80->80/tcp' }),
      'docker: some noise',
      JSON.stringify({ ID: 'def', Names: 'db', Image: 'postgres:16', State: 'exited', Status: 'Exited (0)', Ports: '' }),
    ].join('\n');
    const list = parseContainerLines(output);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'abc', name: 'web', image: 'nginx:latest', state: 'running' });
    expect(list[1].name).toBe('db');
  });

  it('listContainers 先探版本再拉列表', async () => {
    const commands: string[] = [];
    const client = fakeClient((command) => {
      commands.push(command);
      if (command.includes('version')) return { stdout: '24.0.7\n', code: 0 };
      if (command.includes('ps -a')) return { stdout: JSON.stringify({ ID: 'x', Names: 'web', Image: 'nginx', State: 'running' }), code: 0 };
      return { code: 1 };
    });
    const result = await listContainers(client);
    expect(result.available).toBe(true);
    expect(result.version).toBe('24.0.7');
    expect(result.containers).toHaveLength(1);
    // 含空格的格式串必须被引号包住，否则 docker 会把它拆成位置参数报 “accepts no arguments”。
    expect(commands.some((command) => command.includes("'{{json .}}'"))).toBe(true);
  });

  it('docker 不可用时返回 available=false 与错误信息', async () => {
    const client = fakeClient(() => ({ stderr: 'bash: docker: command not found', code: 127 }));
    const result = await listContainers(client);
    expect(result.available).toBe(false);
    expect(result.containers).toEqual([]);
    expect(result.error).toContain('docker');
  });

  it('inspectContainer 归一化详情', async () => {
    const payload = [{
      Id: 'cid',
      Name: '/web',
      Config: { Image: 'nginx', Cmd: ['nginx', '-g', 'daemon off;'], Env: ['A=1'] },
      State: { Status: 'running', Running: true, ExitCode: 0, StartedAt: '2026-01-01T00:00:00Z' },
      RestartCount: 3,
      Platform: 'linux',
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { bridge: {} } },
      Mounts: [{ Type: 'bind', Source: '/srv', Destination: '/data', Mode: '', RW: true }],
    }];
    const client = fakeClient(() => ({ stdout: JSON.stringify(payload), code: 0 }));
    const detail = await inspectContainer(client, 'cid');
    expect(detail.name).toBe('web');
    expect(detail.running).toBe(true);
    expect(detail.command).toBe('nginx -g daemon off;');
    expect(detail.ports[0]).toEqual({ container: '80/tcp', host: '0.0.0.0:8080' });
    expect(detail.networks).toEqual(['bridge']);
  });

  it('containerAction 拒绝未知动作并透传错误', async () => {
    const client = fakeClient(() => ({ code: 0 }));
    await expect(containerAction(client, 'cid', 'explode')).rejects.toThrow(/Unsupported/);
    const failing = fakeClient(() => ({ stderr: 'No such container', code: 1 }));
    await expect(containerAction(failing, 'cid', 'stop')).rejects.toThrow(/No such container/);
  });

  it('containerLogs 合并 stdout/stderr', async () => {
    const client = fakeClient((command) => {
      if (command.includes('logs')) return { stdout: 'line1\n', stderr: 'errline\n', code: 0 };
      return { code: 1 };
    });
    const result = await containerLogs(client, 'cid', 10);
    expect(result.logs).toContain('line1');
    expect(result.logs).toContain('errline');
  });
});
