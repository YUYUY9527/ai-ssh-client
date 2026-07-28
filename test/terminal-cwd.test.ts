import { describe, expect, it } from 'vitest';

import {
  extractCwdFromTerminalOutput,
  parsePromptCwd,
  resolveTransferOpenPath,
} from '../src/renderer/session/terminal/terminal-cwd';

describe('terminal-cwd', () => {
  it('parses common prompt cwd formats', () => {
    expect(parsePromptCwd('root@host:/home#')).toBe('/home');
    expect(parsePromptCwd('user@host:~/projects$')).toBe('~/projects');
    expect(parsePromptCwd('[root@host /home]#')).toBe('/home');
    expect(parsePromptCwd('[root@host ~]#')).toBe('~');
    expect(parsePromptCwd('user@host:/var/log%')).toBe('/var/log');
  });

  it('extracts latest prompt cwd from mixed terminal output', () => {
    const output = [
      'root@host:/root# cd /home',
      'root@host:/home#',
    ].join('\n');
    expect(extractCwdFromTerminalOutput(output)).toBe('/home');
  });

  it('prefers live prompt and session cwd over stale shell cwd', () => {
    expect(resolveTransferOpenPath({
      livePromptCwd: '/home',
      shellCwd: '/root',
      sessionCwd: '/var',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/home');

    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: '/root',
      sessionCwd: '/home',
      browserPath: '/tmp',
      fallbackPath: '~',
    })).toBe('/home');

    expect(resolveTransferOpenPath({
      livePromptCwd: null,
      shellCwd: null,
      sessionCwd: null,
      browserPath: '/root',
      fallbackPath: '~',
    })).toBe('/root');
  });
});
