import { describe, expect, it } from 'vitest';
import {
  formatAgentExitNotice,
  formatAgentTerminalText,
  isAgentTaskRunningInSession,
  isShellPromptReadyForAgent,
  isTerminalAgentCommand,
  normalizeAgentTerminalText,
  parseTerminalAgentCommand,
  parseTerminalAgentPaste,
  resolveAgentSubmission,
  resolveTerminalAgentEscapeAction,
  resolveTerminalAgentLineAction,
  sanitizeAgentTerminalText,
  TERMINAL_AGENT_EXIT_REPAINT,
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

  it('collapses model alignment padding for readable terminal output', () => {
    expect(normalizeAgentTerminalText('1. 系统信息     2. 文件管理\n\n\n3.  网络排障')).toBe(
      '1. 系统信息 2. 文件管理\n\n3. 网络排障',
    );
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

  // 行为按用户要求变更：Agent 正在跑任务（'busy'）时，终端里的普通输入回 shell 执行，
  // 不再被整行吞进对话。要打断 Agent 用 Esc，要追问 Agent 需显式带 @ai。
  it('sends ordinary text to the shell while the Agent is busy', () => {
    expect(resolveTerminalAgentLineAction('继续检查内存', 'busy')).toEqual({ type: 'shell' });
    expect(resolveTerminalAgentLineAction('free -h', 'busy')).toEqual({ type: 'shell' });
  });

  it('still accepts an explicit @ai question while the Agent is busy', () => {
    expect(resolveTerminalAgentLineAction('@ai 继续检查内存', 'busy')).toEqual({
      type: 'agent',
      text: '继续检查内存',
    });
  });

  it('keeps ordinary shell commands in the shell', () => {
    expect(resolveTerminalAgentLineAction('free -h', null)).toEqual({ type: 'shell' });
    expect(resolveTerminalAgentLineAction('', null)).toEqual({ type: 'shell' });
  });
});

describe('终端 Esc 的语义', () => {
  // 真实反馈：任务运行中按 Esc 什么都不发生，终端像卡死了，还得再按 Ctrl+C。
  // 根因是 ESC 被原样发给 bash，readline 把裸 ESC 当 meta 前缀吃掉下一个键。
  it('任务运行中按 Esc 中断任务', () => {
    expect(resolveTerminalAgentEscapeAction({
      isTaskRunningHere: true,
      isFollowUpActive: false,
    })).toBe('interrupt-task');
  });

  it('连续对话中按 Esc 退出对话', () => {
    expect(resolveTerminalAgentEscapeAction({
      isTaskRunningHere: false,
      isFollowUpActive: true,
    })).toBe('exit-follow-up');
  });

  it('纯 Shell 场景放行 Esc（vim / less / 补全菜单依赖它）', () => {
    expect(resolveTerminalAgentEscapeAction({
      isTaskRunningHere: false,
      isFollowUpActive: false,
    })).toBe('passthrough');
  });
});

describe('Agent 任务是否在本会话运行', () => {
  it('本会话有在跑的任务时成立', () => {
    expect(isAgentTaskRunningInSession({
      sessionId: 'session-a',
      currentTaskState: 'thinking',
      currentTaskConnectionId: 'session-a',
      agentState: 'executing',
    })).toBe(true);
  });

  it('任务属于其它标签页时不成立', () => {
    expect(isAgentTaskRunningInSession({
      sessionId: 'session-b',
      currentTaskState: 'thinking',
      currentTaskConnectionId: 'session-a',
      agentState: 'executing',
    })).toBe(false);
  });

  it('任务已结束时（哪怕阶段状态滞后）不成立', () => {
    expect(isAgentTaskRunningInSession({
      sessionId: 'session-a',
      currentTaskState: 'finished',
      currentTaskConnectionId: 'session-a',
      agentState: 'executing',
    })).toBe(false);
    expect(isAgentTaskRunningInSession({
      sessionId: 'session-a',
      currentTaskState: 'error',
      currentTaskConnectionId: 'session-a',
      agentState: 'error',
    })).toBe(false);
  });

  it('没有任务或没有会话时不成立', () => {
    expect(isAgentTaskRunningInSession({
      sessionId: 'session-a',
      currentTaskState: null,
      currentTaskConnectionId: null,
      agentState: 'idle',
    })).toBe(false);
    expect(isAgentTaskRunningInSession({
      sessionId: null,
      currentTaskState: 'thinking',
      currentTaskConnectionId: null,
      agentState: 'thinking',
    })).toBe(false);
  });
});

describe('shared Agent submission routing', () => {
  it('opens a new conversation for the @ai new command', () => {
    expect(resolveAgentSubmission('new', READY_STATE)).toEqual({
      ok: true,
      action: { type: 'new-conversation' },
    });
  });

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

describe('退出连续对话后的提示符重画', () => {
  // 真实反馈：退出后能看到「已退出 Agent 连续对话。」，但看不到
  // `[root@k8s-slave1 ~]# `，光标孤零零停在行首（可以打字，只是没有提示符）。
  // 实测 bash 4.2 对 `^U` 只回一段退格 + `\x1b[K`，不会重画提示符。
  it('重画序列同时清掉光标左边和右边', () => {
    // 只发 `^U` 会留下光标右边的内容。实测光标退到 `ech` 后发 `^U\r`，
    // bash 会把剩下的 `o MID` 当命令执行，回一句 `bash: o: 未找到命令`。
    expect(TERMINAL_AGENT_EXIT_REPAINT).toBe('\x15\x0b\r');
  });

  it('提示行独占一行：回行首、清行、换行收尾', () => {
    const notice = formatAgentExitNotice('已退出 Agent 连续对话。');
    // 没有前导 `\r`，提示会拼在残留的 `@ai` 后面变成 `@ai 已退出 Agent 连续对话。`
    expect(notice).toBe('\r\x1b[2K\x1b[90m已退出 Agent 连续对话。\x1b[0m\r\n');
  });

  it('空文案不产生任何输出', () => {
    expect(formatAgentExitNotice('')).toBe('');
    expect(formatAgentExitNotice('   ')).toBe('');
  });
});
