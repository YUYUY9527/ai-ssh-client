import { describe, expect, it } from 'vitest';

import {
  extractCwdFromTerminalOutput,
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
  });

  it('does not let tilde cwd replace absolute cwd', () => {
    expect(shouldReplaceCwd('/home/docker/buildkit', '~/docker/buildkit')).toBe(false);
    expect(shouldReplaceCwd('/etc/xdg', '~')).toBe(false);
    expect(shouldReplaceCwd('~/docker', '/home/docker')).toBe(true);
    expect(shouldReplaceCwd('/root', '/etc/xdg')).toBe(true);
  });

  it('prefers absolute paths when opening transfer', () => {
    // PS1 显示 ~/docker/buildkit，但 OSC7 已有绝对路径
    expect(resolveTransferOpenPath({
      livePromptCwd: '~/docker/buildkit',
      shellCwd: '/home/docker/buildkit',
      sessionCwd: '/home/docker/buildkit',
      browserPath: '/root',
      fallbackPath: '~',
    })).toBe('/home/docker/buildkit');

    expect(resolveTransferOpenPath({
      livePromptCwd: '/etc/xdg',
      shellCwd: '/root',
      sessionCwd: '~/something',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/etc/xdg');

    // 错误 cd 推断的 session 不得压过 OSC7 真实 PWD
    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: '/etc/xdg',
      sessionCwd: '/otetc/xdg',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/etc/xdg');

    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: '/root',
      sessionCwd: '/home',
      browserPath: '/tmp',
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
