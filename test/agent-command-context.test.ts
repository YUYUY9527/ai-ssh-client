import { describe, it, expect } from 'vitest';

import {
  buildAgentEnvironmentContext,
  extractAgentCwdFromCommand,
  normalizeAgentCwdPath,
  prefixAgentCwd,
  shellSingleQuote,
  shouldPrefixAgentCwd,
} from '../src/renderer/agent/agent-command-context';

/**
 * 命令执行上下文（cwd 跟踪 + 环境提示）。
 *
 * 修的坑：哨兵包装把单行命令放进 `( ... )` 子 shell，模型发一条独立的 `cd /var/log`
 * 之后，下一步 `cat nginx.log` 仍在原目录执行 —— 任务静默失败，模型还不知道为什么。
 * 现在 Agent 自己跟踪绝对路径 `cd`，并给单行命令加 `cd '<cwd>' && ` 前缀。
 */

describe('normalizeAgentCwdPath', () => {
  it('接受绝对路径并规范化尾部斜杠', () => {
    expect(normalizeAgentCwdPath('/var/log')).toBe('/var/log');
    expect(normalizeAgentCwdPath('/var/log/')).toBe('/var/log');
    expect(normalizeAgentCwdPath('/')).toBe('/');
    expect(normalizeAgentCwdPath('/opt/my app')).toBe('/opt/my app');
  });

  it('拒绝无法可靠解析的目标', () => {
    expect(normalizeAgentCwdPath('relative/dir')).toBeNull();
    expect(normalizeAgentCwdPath('~')).toBeNull();
    expect(normalizeAgentCwdPath('$HOME')).toBeNull();
    expect(normalizeAgentCwdPath('/tmp/$USER')).toBeNull();
    expect(normalizeAgentCwdPath('/tmp/`whoami`')).toBeNull();
    expect(normalizeAgentCwdPath('/tmp/*')).toBeNull();
  });
});

describe('extractAgentCwdFromCommand', () => {
  it('解析首段绝对路径 cd', () => {
    expect(extractAgentCwdFromCommand('cd /var/log')).toBe('/var/log');
    expect(extractAgentCwdFromCommand('cd /var/log && tail -n 20 nginx.log')).toBe('/var/log');
    expect(extractAgentCwdFromCommand('cd /srv; ls')).toBe('/srv');
    expect(extractAgentCwdFromCommand('cd -- /srv/app')).toBe('/srv/app');
  });

  it('解析带引号的路径', () => {
    expect(extractAgentCwdFromCommand('cd "/opt/my app"')).toBe('/opt/my app');
    expect(extractAgentCwdFromCommand("cd '/opt/my app'")).toBe('/opt/my app');
  });

  it('不跟踪非首段或不可解析的 cd', () => {
    expect(extractAgentCwdFromCommand('ls && cd /tmp')).toBeNull();
    expect(extractAgentCwdFromCommand('cd ~')).toBeNull();
    expect(extractAgentCwdFromCommand('cd $HOME')).toBeNull();
    expect(extractAgentCwdFromCommand('cd -')).toBeNull();
    expect(extractAgentCwdFromCommand('cd relative')).toBeNull();
    expect(extractAgentCwdFromCommand('ls -la')).toBeNull();
  });
});

describe('shouldPrefixAgentCwd', () => {
  it('只给单行且非 cd 的命令加前缀', () => {
    expect(shouldPrefixAgentCwd('ls -la')).toBe(true);
    expect(shouldPrefixAgentCwd('cd /var/log')).toBe(false);
    expect(shouldPrefixAgentCwd('cd /var/log && ls')).toBe(false);
    expect(shouldPrefixAgentCwd('printf a\nprintf b')).toBe(false);
    expect(shouldPrefixAgentCwd('cat <<EOF\nhi\nEOF')).toBe(false);
    expect(shouldPrefixAgentCwd('   ')).toBe(false);
  });
});

describe('prefixAgentCwd', () => {
  it('加上带引号的 cd 前缀', () => {
    expect(prefixAgentCwd('ls -la', '/var/log')).toBe("cd '/var/log' && ls -la");
  });

  it('路径中的单引号按 POSIX 规则转义', () => {
    expect(shellSingleQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(prefixAgentCwd('ls', "/tmp/it's")).toBe("cd '/tmp/it'\\''s' && ls");
  });

  it('cwd 未知时保持原命令', () => {
    expect(prefixAgentCwd('ls -la', null)).toBe('ls -la');
    expect(prefixAgentCwd('ls -la', undefined)).toBe('ls -la');
  });

  it('多行命令不加前缀（避免污染用户会话 cwd）', () => {
    expect(prefixAgentCwd('cat <<EOF\nhi\nEOF', '/tmp')).toBe('cat <<EOF\nhi\nEOF');
  });
});

describe('buildAgentEnvironmentContext', () => {
  it('包含主机/用户/连接名与 cwd', () => {
    const context = buildAgentEnvironmentContext(
      { host: '10.0.0.8', username: 'deploy', connectionName: 'prod-web', port: 2222 },
      '/srv/app',
    );
    expect(context).toContain('deploy@10.0.0.8:2222');
    expect(context).toContain('prod-web');
    expect(context).toContain('/srv/app');
    expect(context).toContain('cd ');
  });

  it('默认端口不显示端口号', () => {
    const context = buildAgentEnvironmentContext({ host: 'h', username: 'u', port: 22 }, null);
    expect(context).toContain('u@h');
    expect(context).not.toContain('u@h:22');
  });

  it('环境与 cwd 都未知时不注入空提示', () => {
    expect(buildAgentEnvironmentContext(null, null)).toBeNull();
    expect(buildAgentEnvironmentContext({}, null)).toBeNull();
  });

  it('只有 cwd 时也能给出上下文', () => {
    expect(buildAgentEnvironmentContext({}, '/var/log')).toContain('/var/log');
  });
});
