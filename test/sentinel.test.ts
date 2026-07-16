import { describe, it, expect } from 'vitest';
import {
  createSentinelStripper,
  makeSentinelMarker,
  parseSentinel,
  stripCompleteSentinelArtifacts,
  stripVisibleAgentArtifacts,
  wrapCommandWithSentinel,
} from '../server/sentinel.cjs';

function stripChunks(chunks: string[]): string {
  const stripper = createSentinelStripper();
  let output = '';
  for (const chunk of chunks) {
    output += stripper.feed(chunk);
  }
  return output + stripper.flush();
}

describe('sentinel', () => {
  it('builds and parses sentinel markers', () => {
    expect(makeSentinelMarker('run-1')).toBe('__AGENT_DONE_run-1__');
    expect(wrapCommandWithSentinel('pwd', 'run-1')).toBe(
      "\r(pwd); printf '\\n__AGENT_DONE_run-1__:%s\\n' \"$?\"\n",
    );
    expect(parseSentinel('output\r\n__AGENT_DONE_run-1__:7\r\n', '__AGENT_DONE_run-1__')).toEqual({
      output: 'output\r\n',
      exitCode: 7,
    });
  });

  it('passes through normal output', () => {
    expect(stripChunks(['hello world\r\n', 'another line\r\n'])).toBe(
      'hello world\r\nanother line\r\n',
    );
  });

  it('strips sentinel split across chunks', () => {
    expect(stripChunks(['root\r\n__AGENT_', 'DONE_run1__:', '0\r\nprompt$ '])).toBe(
      'root\r\nprompt$ ',
    );
    expect(
      stripChunks([
        'output\r\n__ais_',
        'ec=$?; printf \'\\n__AGENT_DONE_run__:%s\\n\' "$__ais_ec"\r\n',
        'prompt$ ',
      ]),
    ).toBe('output\r\nprompt$ ');
  });

  it('holds a partial trailing sentinel', () => {
    const stripper = createSentinelStripper();
    expect(stripper.feed('output\r\n__AGENT_DONE_run-half__:0')).toBe('output\r\n');
    expect(stripper.feed('\r\n')).toBe('');
    expect(stripper.flush()).toBe('');
  });

  it('does not swallow prompt-like text', () => {
    expect(stripChunks(['user@host:/tmp/foo_bar$ '])).toBe('user@host:/tmp/foo_bar$ ');
    expect(stripChunks(['l', 's', '\r'])).toBe('ls\r');
    expect(stripChunks(['('])).toBe('(');
    expect(stripChunks(['(cmd)', '; ', 'echo next\r\n'])).toBe('(cmd); echo next\r\n');
  });

  it('strips echoed command with sentinel', () => {
    const input = '\r(echo hi); printf \'\\n__AGENT_DONE_x__:%s\\n\' "$?"\r\nhi\r\n__AGENT_DONE_x__:0\r\n';
    expect(stripChunks([...input])).toBe('hi\r\n');
  });

  it('strips complete sentinel artifacts', () => {
    expect(
      stripCompleteSentinelArtifacts('line1\r\n\r\n__AGENT_DONE_r__:0\r\nprompt$ '),
    ).toBe('line1\r\n\r\nprompt$ ');
  });

  it('strips visible agent artifacts across calls', () => {
    const session = { agentEchoPending: true };
    let output = stripVisibleAgentArtifacts(session, '(echo hi); printf \'\\n__AGEN');
    output += stripVisibleAgentArtifacts(session, 'T_DONE_x__:%s\\n\' "$?"\r\nhi\r\n__AGENT_DONE_x__:0\r\n');
    expect(output).toBe('hi\r\n');
  });
});
