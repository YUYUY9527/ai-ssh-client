import { describe, it, expect } from 'vitest';
import {
  detectHttpUrls,
  isOpenableHttpUrl,
  createShellIntegrationState,
  parseOsc7Cwd,
  parseOsc133Marker,
  consumeShellIntegrationChunk,
  applyOscPayload,
  ShellIntegrationParser,
} from '../src/renderer/session/terminal/shell-integration';

describe('shell-integration', () => {
  it('detects HTTP URLs', () => {
    const urls = detectHttpUrls('see https://example.com/path and http://localhost:8080/x');
    expect(urls).toEqual(['https://example.com/path', 'http://localhost:8080/x']);
    expect(isOpenableHttpUrl('https://example.com/path')).toBe(true);
    expect(isOpenableHttpUrl('ftp://example.com')).toBe(false);
    expect(isOpenableHttpUrl('not a url')).toBe(false);
  });

  it('parses OSC 7 cwd', () => {
    expect(parseOsc7Cwd('7;file://host/home/user/project')).toBe('/home/user/project');
    expect(parseOsc7Cwd('7;file:///tmp/foo')).toBe('/tmp/foo');
  });

  it('parses OSC 133 markers', () => {
    expect(parseOsc133Marker('133;A')).toEqual({ marker: 'A', exitCode: null });
    expect(parseOsc133Marker('133;B')).toEqual({ marker: 'B', exitCode: null });
    expect(parseOsc133Marker('133;C')).toEqual({ marker: 'C', exitCode: null });
    expect(parseOsc133Marker('133;D;0')).toEqual({ marker: 'D', exitCode: 0 });
    expect(parseOsc133Marker('133;D;127')).toEqual({ marker: 'D', exitCode: 127 });
  });

  it('consumes a full chunk', () => {
    let state = createShellIntegrationState();
    const chunk = [
      '\x1b]7;file://host/var/log\x07',
      '\x1b]133;A\x07',
      'prompt$ ',
      '\x1b]133;B\x07',
      'ls\r\n',
      '\x1b]133;C\x07',
      'file.txt\r\n',
      '\x1b]133;D;0\x07',
    ].join('');
    state = consumeShellIntegrationChunk(state, chunk);
    expect(state.cwd).toBe('/var/log');
    expect(state.lastMarker).toBe('D');
    expect(state.lastExitCode).toBe(0);
    expect(state.commandRunning).toBe(false);
  });

  it('does not throw on malformed input', () => {
    const state = createShellIntegrationState();
    expect(() => applyOscPayload(state, null as never)).not.toThrow();
    expect(() => consumeShellIntegrationChunk(state, '\x1b]7;not-a-uri\x07')).not.toThrow();
    expect(() => detectHttpUrls(null as never)).not.toThrow();
  });

  it('parses across chunks', () => {
    const parser = new ShellIntegrationParser();
    parser.feed('\x1b]7;file://h');
    expect(parser.getState().cwd).toBe(null);
    parser.feed('/opt/app\x07');
    expect(parser.getState().cwd).toBe('/opt/app');
  });
});
