import { describe, expect, it } from 'vitest';
import {
  formatAgentTerminalText,
  isShellPromptReadyForAgent,
  isTerminalAgentCommand,
  parseTerminalAgentCommand,
  parseTerminalAgentPaste,
  resolveAgentSubmission,
  resolveTerminalAgentLineAction,
  sanitizeAgentTerminalText,
  type AgentSubmissionState,
} from '../src/renderer/agent/terminal-agent-chat';

const READY_STATE: AgentSubmissionState = {
  agentEnabled: true,
  hasProvider: true,
  hasConnection: true,
  expectedConnectionId: 'session-a',
  currentTaskConnectionId: null,
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

  it('only enables @ai at a conventional top-level shell prompt', () => {
    expect(isShellPromptReadyForAgent('user@host:~/src$ @ai check disk', '@ai check disk')).toBe(true);
    expect(isShellPromptReadyForAgent('user@host:~/src% @ai check disk', '@ai check disk')).toBe(true);
    expect(isShellPromptReadyForAgent('user@host:~/src$', '@ai check disk')).toBe(true);
    expect(isShellPromptReadyForAgent('> @ai literal heredoc', '@ai literal heredoc')).toBe(false);
    expect(isShellPromptReadyForAgent('# @ai literal continuation', '@ai literal continuation')).toBe(false);
    expect(isShellPromptReadyForAgent('user@host:~$ @ai check disk', '@ai check disk')).toBe(true);
    expect(isShellPromptReadyForAgent('custom-prompt @ai check disk', '@ai check disk')).toBe(false);
  });

  it('removes terminal control bytes before writing Agent output', () => {
    expect(sanitizeAgentTerminalText('safe\u001b[31mred\u0007\u009b32mgreen\nnext')).toBe('saferedgreen\nnext');
    expect(formatAgentTerminalText('line 1\nline 2')).toBe('line 1\r\nline 2\r\n');
  });
});

describe('terminal Agent follow-up routing', () => {
  it('routes a direct next question while follow-up mode is active', () => {
    expect(resolveTerminalAgentLineAction('继续检查内存', 'follow-up')).toEqual({
      type: 'agent',
      text: '继续检查内存',
    });
  });

  it('exits follow-up mode on an empty Enter or @sh shell escape', () => {
    expect(resolveTerminalAgentLineAction('', 'follow-up')).toEqual({ type: 'exit-follow-up' });
    expect(resolveTerminalAgentLineAction('@sh free -h', 'follow-up')).toEqual({
      type: 'shell-escape',
      text: 'free -h',
    });
  });

  it('does not send ordinary text to the shell while the Agent is busy', () => {
    expect(resolveTerminalAgentLineAction('继续检查内存', 'busy')).toEqual({
      type: 'agent',
      text: '继续检查内存',
    });
  });

  it('keeps ordinary shell commands in the shell', () => {
    expect(resolveTerminalAgentLineAction('free -h', null)).toEqual({ type: 'shell' });
    expect(resolveTerminalAgentLineAction('', null)).toEqual({ type: 'shell' });
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

  it('does not answer or approve a task from another terminal session', () => {
    expect(resolveAgentSubmission('yes', {
      ...READY_STATE,
      expectedConnectionId: 'session-b',
      currentTaskActive: true,
      currentTaskConnectionId: 'session-a',
      pendingApproval: { command: 'rm -rf old', riskLevel: 'high' },
    })).toEqual({ ok: false, error: 'wrongSession' });
  });

  it('rejects a second task while the current task is still running', () => {
    expect(resolveAgentSubmission('另一个任务', {
      ...READY_STATE,
      currentTaskActive: true,
    })).toEqual({ ok: false, error: 'taskRunning' });
  });
});
