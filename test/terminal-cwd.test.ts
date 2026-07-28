import { describe, expect, it } from 'vitest';

import {
  extractCwdFromTerminalOutput,
  extractLastPathHint,
  isPlausibleTildeExpansion,
  parsePromptCwd,
  resolveTransferOpenPath,
  shouldReplaceCwd,
} from '../src/renderer/session/terminal/terminal-cwd';

describe('terminal-cwd', () => {
  it('parses common prompt cwd formats', () => {
    expect(parsePromptCwd('root@host:/home#')).toBe('/home');
    expect(parsePromptCwd('user@host:~/projects$')).toBe('~/projects');
    expect(parsePromptCwd('[root@host /home]#')).toBe('/home');
    expect(parsePromptCwd('[root@host ~]#')).toBe('~');
    expect(parsePromptCwd('user@host:/var/log%')).toBe('/var/log');
    expect(parsePromptCwd('root@host:/etc/xdg#')).toBe('/etc/xdg');
    expect(parsePromptCwd('root@host:/home/docker/buildkit#')).toBe('/home/docker/buildkit');
    expect(parsePromptCwd('user@host:/opt/app ❯')).toBe('/opt/app');
    expect(parsePromptCwd('(base) [root@vm /var/log]#')).toBe('/var/log');
  });

  it('extracts latest prompt cwd from mixed terminal output', () => {
    expect(extractCwdFromTerminalOutput([
      'root@host:/root# cd /home/docker/buildkit',
      'root@host:/home/docker/buildkit#',
    ].join('\n'))).toBe('/home/docker/buildkit');

    expect(extractCwdFromTerminalOutput([
      'root@host:/etc/xdg#',
    ].join('\n'))).toBe('/etc/xdg');

    expect(extractCwdFromTerminalOutput([
      'root@host:/home/docker/buildkit# cd ~',
      'root@host:~#',
    ].join('\n'))).toBe('~');

    // 当前行已开始输入命令时，仍能取到提示符路径
    expect(extractCwdFromTerminalOutput(
      'root@host:/var/log# ls -la',
    )).toBe('/var/log');

    expect(extractLastPathHint(
      '[root@vm /home/docker/buildkit]# cd /tmp\nsomething',
    )).toBe('/home/docker/buildkit');
  });

  it('guards tilde vs absolute cwd replacement', () => {
    // 已在具体绝对目录时，不用 ~/... 降级覆盖
    expect(shouldReplaceCwd('/home/docker/buildkit', '~/docker/buildkit')).toBe(false);
    expect(shouldReplaceCwd('/etc/xdg', '~')).toBe(false);
    expect(shouldReplaceCwd('~/docker', '/home/docker')).toBe(true);
    expect(shouldReplaceCwd('/root', '/etc/xdg')).toBe(true);
    // 登录 OSC7 停在裸家目录时，允许提示符 ~/sub 推进，避免会话钉死 /root
    expect(shouldReplaceCwd('/root', '~/docker/buildkit')).toBe(true);
    expect(shouldReplaceCwd('/home/ubuntu', '~/projects')).toBe(true);
    // 裸 ~ 仍不覆盖绝对路径
    expect(shouldReplaceCwd('/root', '~')).toBe(false);
  });

  it('detects plausible tilde expansions only', () => {
    expect(isPlausibleTildeExpansion('~/docker/buildkit', '/home/docker/buildkit')).toBe(true);
    expect(isPlausibleTildeExpansion('~/docker/buildkit', '/root/docker/buildkit')).toBe(true);
    expect(isPlausibleTildeExpansion('~/docker/buildkit', '/root')).toBe(false);
    expect(isPlausibleTildeExpansion('~', '/root')).toBe(true);
    expect(isPlausibleTildeExpansion('~', '/home/ubuntu')).toBe(true);
    expect(isPlausibleTildeExpansion('~', '/home/ubuntu/projects')).toBe(false);
  });

  it('prefers live/session paths over stale OSC7 /root', () => {
    // 提示符 ~/x + 会话已展开 → 用绝对路径
    expect(resolveTransferOpenPath({
      livePromptCwd: '~/docker/buildkit',
      shellCwd: '/root',
      sessionCwd: '/home/docker/buildkit',
      browserPath: '/root',
      fallbackPath: '~',
    })).toBe('/home/docker/buildkit');

    // 提示符 ~/x 但会话/OSC7 仍是登录家目录 → 不能被 /root 钉死
    expect(resolveTransferOpenPath({
      livePromptCwd: '~/docker/buildkit',
      shellCwd: '/root',
      sessionCwd: '/root',
      browserPath: '/root',
      fallbackPath: '~',
    })).toBe('~/docker/buildkit');

    // 屏幕提示符为真路径，纠正错误 cd 推断
    expect(resolveTransferOpenPath({
      livePromptCwd: '/etc/xdg',
      shellCwd: '/root',
      sessionCwd: '/otetc/xdg',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/etc/xdg');

    // 无提示符时：会话 cd 路径优先于过期 OSC7=/root
    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: '/root',
      sessionCwd: '/home/docker/buildkit',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/home/docker/buildkit');

    // 裸 ~ 可用家目录绝对路径升级
    expect(resolveTransferOpenPath({
      livePromptCwd: '~',
      shellCwd: '/root',
      sessionCwd: '/root',
      browserPath: null,
      fallbackPath: '~',
    })).toBe('/root');

    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: null,
      sessionCwd: null,
      browserPath: '/root',
      fallbackPath: '~',
    })).toBe('/root');
  });
});
