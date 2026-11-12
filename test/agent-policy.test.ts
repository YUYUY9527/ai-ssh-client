import { describe, expect, it } from 'vitest';
import {
  evaluateAgentPolicy,
  needsApprovalForRisk,
  policyModeFromConfig,
} from '../src/renderer/agent/runtime/policy';

describe('agent policy', () => {
  it('needsApprovalForRisk 与旧内联逻辑一致', () => {
    const defaults = {};
    expect(needsApprovalForRisk('critical', defaults)).toBe(true);
    expect(needsApprovalForRisk('high', defaults)).toBe(true);
    expect(needsApprovalForRisk('medium', defaults)).toBe(true);
    expect(needsApprovalForRisk('low', defaults)).toBe(false);

    const relaxed = { approveHighRisk: false, approveMediumRisk: false };
    expect(needsApprovalForRisk('critical', relaxed)).toBe(true);
    expect(needsApprovalForRisk('high', relaxed)).toBe(false);
    expect(needsApprovalForRisk('medium', relaxed)).toBe(false);
  });

  it('policyModeFromConfig 由现有开关推导模式', () => {
    expect(policyModeFromConfig({ readOnlyMode: true, approveHighRisk: false })).toBe('readonly');
    expect(policyModeFromConfig({ approveHighRisk: false, approveMediumRisk: false })).toBe('full');
    expect(policyModeFromConfig({})).toBe('ask');
    expect(policyModeFromConfig({ approveHighRisk: false })).toBe('ask');
  });

  it('只读模式拒绝写操作，读取不受影响', () => {
    const verdict = evaluateAgentPolicy({ tool: 'write_file', path: '/etc/hosts', write: true }, { readOnlyMode: true });
    expect(verdict).toEqual({ run: false, needsApproval: false, reason: 'readonly:write-blocked' });

    const read = evaluateAgentPolicy({ tool: 'read_file', path: '/etc/hosts' }, { readOnlyMode: true });
    expect(read.run).toBe(true);
    expect(read.needsApproval).toBe(false);
  });

  it('写操作默认按 medium 风险判断是否需要审批', () => {
    expect(evaluateAgentPolicy({ tool: 'write_file', write: true }, {}).needsApproval).toBe(true);
    expect(
      evaluateAgentPolicy({ tool: 'write_file', write: true }, { approveMediumRisk: false, approveHighRisk: false })
        .needsApproval,
    ).toBe(false);
  });

  it('未显式给出风险时按读取=low', () => {
    const verdict = evaluateAgentPolicy({ tool: 'list_dir' }, {});
    expect(verdict).toEqual({ run: true, needsApproval: false, reason: 'auto:list_dir' });
  });
});
