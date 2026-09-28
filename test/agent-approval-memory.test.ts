import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearRememberedRiskDecisions,
  commandDecisionKey,
  getRememberedCommandDecision,
  isRememberableRisk,
  rememberCommandDecision,
} from '../src/renderer/assistant/risk-approval-memory';
import { isAutoRejected, requiresCommandApproval } from '../src/renderer/assistant/command-policy';
import type { CommandSuggestion } from '../src/shared/types';

/**
 * 审批记忆回归测试。
 *
 * 旧实现是 `Map<风险等级, 决定>`，并且 critical 也会被记住：
 * 用户对一条 critical 命令点一次「记住批准」，此后**所有** critical 命令
 * （包括 `rm -rf /`）都会在没有 UI 的情况下自动执行。现在改为按**具体命令**记忆，
 * 且 critical 永不记忆。
 */

const suggestion = (command: string, riskLevel: CommandSuggestion['riskLevel']): CommandSuggestion => ({
  command,
  description: '',
  isDangerous: riskLevel !== 'low',
  riskLevel,
});

describe('commandDecisionKey', () => {
  it('压缩空白但保留大小写', () => {
    expect(commandDecisionKey('  rm   report.txt ')).toBe('rm report.txt');
    expect(commandDecisionKey('rm /Data/x')).not.toBe(commandDecisionKey('rm /data/x'));
  });
});

describe('审批记忆粒度', () => {
  beforeEach(() => clearRememberedRiskDecisions());

  it('只对同一条命令生效，同风险等级的其它命令仍需审批', () => {
    rememberCommandDecision('rm report.txt', 'medium', 'approved');

    expect(getRememberedCommandDecision('rm report.txt', 'medium')).toBe('approved');
    expect(requiresCommandApproval(suggestion('rm report.txt', 'medium'))).toBe(false);
    // 同等级、不同命令 —— 旧实现会一起放行，现在必须重新审批
    expect(requiresCommandApproval(suggestion('rm -rf /var/lib', 'medium'))).toBe(true);
    expect(requiresCommandApproval(suggestion('chmod 755 x', 'medium'))).toBe(true);
  });

  it('空白差异视为同一条命令', () => {
    rememberCommandDecision('rm   report.txt', 'medium', 'approved');
    expect(getRememberedCommandDecision('rm report.txt', 'medium')).toBe('approved');
  });

  it('记住拒绝时标记自动拒绝', () => {
    rememberCommandDecision('systemctl stop nginx', 'medium', 'rejected');

    expect(isAutoRejected('systemctl stop nginx', 'medium')).toBe(true);
    expect(isAutoRejected('systemctl stop sshd', 'medium')).toBe(false);
  });

  it('清空后记忆失效', () => {
    rememberCommandDecision('rm report.txt', 'medium', 'approved');
    clearRememberedRiskDecisions();
    expect(getRememberedCommandDecision('rm report.txt', 'medium')).toBeNull();
  });
});

describe('critical 永不记忆', () => {
  beforeEach(() => clearRememberedRiskDecisions());

  it('批准 critical 不会建立记忆', () => {
    rememberCommandDecision('rm -rf /', 'critical', 'approved');

    expect(isRememberableRisk('critical')).toBe(false);
    expect(getRememberedCommandDecision('rm -rf /', 'critical')).toBeNull();
    expect(requiresCommandApproval(suggestion('rm -rf /', 'critical'))).toBe(true);
  });

  it('拒绝 critical 也不会建立自动拒绝记忆', () => {
    rememberCommandDecision('rm -rf /', 'critical', 'rejected');

    expect(getRememberedCommandDecision('rm -rf /', 'critical')).toBeNull();
    expect(isAutoRejected('rm -rf /', 'critical')).toBe(false);
  });

  it('medium/high 仍可记忆', () => {
    expect(isRememberableRisk('medium')).toBe(true);
    expect(isRememberableRisk('high')).toBe(true);
  });
});

describe('requiresCommandApproval 阈值', () => {
  beforeEach(() => clearRememberedRiskDecisions());

  it('low 不需要审批，medium 及以上需要', () => {
    expect(requiresCommandApproval(suggestion('ls -la', 'low'))).toBe(false);
    expect(requiresCommandApproval(suggestion('rm x', 'medium'))).toBe(true);
    expect(requiresCommandApproval(suggestion('rm -r /var', 'high'))).toBe(true);
  });

  it('关闭记忆时不使用既有记忆', () => {
    rememberCommandDecision('rm report.txt', 'medium', 'approved');

    expect(requiresCommandApproval(suggestion('rm report.txt', 'medium'), 'medium', {
      rememberEnabled: false,
    })).toBe(true);
  });
});
