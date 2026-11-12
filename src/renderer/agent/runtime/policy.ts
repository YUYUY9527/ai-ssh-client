import type { CommandSuggestion } from '../../../shared/types';

/**
 * 统一的 Agent 授权策略（批次一：先从 AgentRuntime 内联逻辑抽出，行为保持不变）。
 *
 * 现有 config 只有 approveHighRisk / approveMediumRisk / readOnlyMode 三个开关；
 * 这里把它们归一成四种模式，供后续（batch 2/4）扩展为显式设置项。
 */
export type AgentPolicyMode = 'ask' | 'auto' | 'full' | 'readonly';

export type AgentRiskLevel = CommandSuggestion['riskLevel'];

export interface AgentPolicyConfigLike {
  approveHighRisk?: boolean;
  approveMediumRisk?: boolean;
  readOnlyMode?: boolean;
}

/** 由现有设置推导策略模式（暂时用 ask/full/readonly 三种，auto 留给设置页显式开启）。 */
export function policyModeFromConfig(config: AgentPolicyConfigLike): AgentPolicyMode {
  if (config.readOnlyMode) return 'readonly';
  if (config.approveHighRisk === false && config.approveMediumRisk === false) return 'full';
  return 'ask';
}

/**
 * 与重构前 AgentRuntime 内联表达式完全一致：
 * critical 必审；high 在 approveHighRisk !== false 时审；medium 在 approveMediumRisk !== false 时审。
 */
export function needsApprovalForRisk(
  riskLevel: AgentRiskLevel,
  config: AgentPolicyConfigLike,
): boolean {
  return (
    riskLevel === 'critical' ||
    (riskLevel === 'high' && config.approveHighRisk !== false) ||
    (riskLevel === 'medium' && config.approveMediumRisk !== false)
  );
}

/** 一次工具调用的策略输入（命令、文件读写等统一走这里）。 */
export interface AgentPolicyRequest {
  /** 工具名，如 run_command / read_file / write_file / list_dir / search_files。 */
  tool: string;
  /** run_command 的命令文本。 */
  command?: string;
  /** 文件工具的远端路径。 */
  path?: string;
  /** 由风险分析得到的等级；缺省按写入=medium、其余=low。 */
  riskLevel?: AgentRiskLevel;
  /** 是否会产生远端写入（只读模式下直接拒绝）。 */
  write?: boolean;
}

export interface AgentPolicyVerdict {
  /** 是否允许执行。 */
  run: boolean;
  /** 是否需要用户/审核模型批准后才执行。 */
  needsApproval: boolean;
  /** 结构化原因，便于审计与 UI 展示。 */
  reason: string;
}

/**
 * 统一授权入口：所有工具调用都应先经过它。
 * 只做纯判断，不执行任何 I/O，便于确定性测试。
 */
export function evaluateAgentPolicy(
  request: AgentPolicyRequest,
  config: AgentPolicyConfigLike,
): AgentPolicyVerdict {
  if (config.readOnlyMode && request.write) {
    return { run: false, needsApproval: false, reason: 'readonly:write-blocked' };
  }
  const riskLevel = request.riskLevel ?? (request.write ? 'medium' : 'low');
  const needsApproval = needsApprovalForRisk(riskLevel, config);
  return {
    run: true,
    needsApproval,
    reason: needsApproval ? `risk:${riskLevel}` : `auto:${request.tool}`,
  };
}
