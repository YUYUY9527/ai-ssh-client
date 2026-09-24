import { describe, expect, it } from 'vitest';
import {
  formatAgentTerminalText,
  isTerminalAgentCommand,
  parseTerminalAgentCommand,
  parseTerminalAgentPaste,
  resolveAgentSubmission,
  sanitizeAgentTerminalText,
  type AgentSubmissionState,
} from '../src/renderer/agent/terminal-agent-chat';

const READY_STATE: AgentSubmissionState = {
  agentEnabled: true,
  hasProvider: true,
  hasConnection: true,
  currentTaskActive: false,
  pendingQuestion: null,
  pendingApproval: null,
};

describe('terminal @ai command parsing', () => {
  it('recognizes the prefix without intercepting ordinary shell commands', () => {
    expect(isTerminalAgentCommand('@ai 检查 nginx')).toBe(true);
    expect(isTerminalAgentCommand('  @AI   check disk  ')).toBe(true);
    expect(isTerminalAgentCommand('echo @ai hello')).toBe(false);
    expect(isTerminalAgentCommand('mail@example.com')).toBe(false);
  });

  it('returns trimmed input and preserves intentional multiline questions', () => {
    expect(parseTerminalAgentCommand('@ai  第一行\n第二行  ')).toEqual({
      text: '第一行\n第二行',
    });
    expect(parseTerminalAgentCommand('@ai')).toEqual({ text: '' });
  });

  it('submits an @ai request pasted with its trailing newline', () => {
    expect(parseTerminalAgentPaste('@ai 检查磁盘\r')).toEqual({ text: '检查磁盘' });
    expect(parseTerminalAgentPaste('检查磁盘\r', '@ai ')).toEqual({ text: '检查磁盘' });
    expect(parseTerminalAgentPaste('@ai 还没有回车')).toBeNull();
  });

  it('removes terminal control bytes before writing Agent output', () => {
    expect(sanitizeAgentTerminalText('safe\u001b[31mred\u0007\u009b32mgreen\nnext')).toBe('saferedgreen\nnext');
    expect(formatAgentTerminalText('line 1\nline 2')).toBe('line 1\r\nline 2\r\n');
  });
});

describe('shared Agent submission routing', () => {
  it('starts a task when the Agent is idle', () => {
    expect(resolveAgentSubmission(' 检查磁盘 ', READY_STATE)).toEqual({
      ok: true,
      action: { type: 'start', text: '检查磁盘' },
    });
  });

  it('routes a question response while the Agent is waiting', () => {
    expect(resolveAgentSubmission('端口是 8080', {
      ...READY_STATE,
      currentTaskActive: true,
      pendingQuestion: '服务使用哪个端口？',
    })).toEqual({
      ok: true,
      action: { type: 'answer', text: '端口是 8080' },
    });
  });

  it('accepts yes/no approval replies in the terminal', () => {
    const state = {
      ...READY_STATE,
      currentTaskActive: true,
      pendingApproval: { command: 'rm -rf old', riskLevel: 'high' as const },
    };
    expect(resolveAgentSubmission('yes', state)).toEqual({
      ok: true,
      action: { type: 'approval', result: 'approved' },
    });
    expect(resolveAgentSubmission('拒绝', state)).toEqual({
      ok: true,
      action: { type: 'approval', result: 'rejected' },
    });
    expect(resolveAgentSubmission('继续', state)).toEqual({
      ok: false,
      error: 'approvalResponseRequired',
    });
  });

  it('rejects a second task while the current task is still running', () => {
    expect(resolveAgentSubmission('另一个任务', {
      ...READY_STATE,
      currentTaskActive: true,
    })).toEqual({ ok: false, error: 'taskRunning' });
  });
});
