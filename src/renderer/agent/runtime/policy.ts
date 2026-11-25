import type { CommandSuggestion, Message } from '../../../shared/types';
import type { AIChatResult, IPCResult } from '../../../shared/ipc-types';

/**
 * 统一的 Agent 授权策略。
 * 支持四种模式（ask / auto / full / readonly）、按连接白名单以及可选独立审核模型。
 */
export type AgentPolicyMode = 'ask' | 'auto' | 'full' | 'readonly';

export type AgentRiskLevel = CommandSuggestion['riskLevel'];

export interface AgentPolicyConfigLike {
  approveHighRisk?: boolean;
  approveMediumRisk?: boolean;
  readOnlyMode?: boolean;
  /** 按连接 ID 维护的命令白名单（整条精确匹配或安全前缀匹配）。 */
  connectionAllowlist?: Record<string, string[]>;
  /** 可选独立审核模型（AI Provider ID）。 */
  reviewerProviderId?: string;
}

/** 由现有设置推导策略模式。 */
export function policyModeFromConfig(config: AgentPolicyConfigLike): AgentPolicyMode {
  if (config.readOnlyMode) return 'readonly';
  if (config.approveHighRisk === false && config.approveMediumRisk === false) return 'full';
  return 'ask';
}

/**
 * 规范化单条命令：折叠空白，去除首尾空格。
 */
function normalizeAllowlistCommand(command: string): string {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

/**
 * 判断命令是否命中当前连接的白名单。
 * - critical 级别命令永远不走前缀匹配，只允许整条完全一致；
 * - 含链式操作符（&& / || / ; / | / ` / $(）的复合命令不走前缀放行，防止注入搭便车。
 */
export function isCommandAllowlisted(
  command: string | undefined,
  connectionId: string | undefined,
  allowlist: Record<string, string[]> | undefined,
  riskLevel?: AgentRiskLevel,
): boolean {
  if (!command || !connectionId || !allowlist) return false;
  const entries = allowlist[connectionId];
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const normalized = normalizeAllowlistCommand(command);
  if (!normalized) return false;
  const hasChaining = /[;&|`\n]|\$\(/.test(normalized);

  for (const rawRule of entries) {
    const rule = normalizeAllowlistCommand(rawRule);
    if (!rule) continue;
    if (normalized === rule) return true;
    if (riskLevel === 'critical' || hasChaining) continue;
    if (normalized.startsWith(`${rule} `)) return true;
  }
  return false;
}

/**
 * 与重构前 AgentRuntime 内联表达式完全一致：
 * critical 必审；high 在 approveHighRisk !== false 时审；medium 在 approveMediumRisk !== false 时审。
 */
export function needsApprovalForRisk(
  riskLevel: AgentRiskLevel,
  config: AgentPolicyConfigLike,
  context?: { command?: string; connectionId?: string },
): boolean {
  if (
    context?.command
    && isCommandAllowlisted(context.command, context.connectionId, config.connectionAllowlist, riskLevel)
  ) {
    return false;
  }
  return (
    riskLevel === 'critical' ||
    (riskLevel === 'high' && config.approveHighRisk !== false) ||
    (riskLevel === 'medium' && config.approveMediumRisk !== false)
  );
}

/** 一次工具调用的策略输入（命令、文件读写等统一走这里）。 */
export interface AgentPolicyRequest {
  /** 工具名，如 run_command / read_file / write_file / list_dir / search_files / pane_output。 */
  tool: string;
  /** run_command 的命令文本。 */
  command?: string;
  /** 当前连接 ID（用于按连接白名单检查）。 */
  connectionId?: string;
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
  if (
    request.command
    && isCommandAllowlisted(request.command, request.connectionId, config.connectionAllowlist, riskLevel)
  ) {
    return { run: true, needsApproval: false, reason: 'allowlist:approved' };
  }
  const needsApproval = needsApprovalForRisk(riskLevel, config);
  return {
    run: true,
    needsApproval,
    reason: needsApproval ? `risk:${riskLevel}` : `auto:${request.tool}`,
  };
}

export interface ReviewerModelResult {
  approved: boolean;
  reason: string;
}

/**
 * 使用独立审核模型对中高风险命令做二次评估。
 * 仅对非 critical 命令启用；解析失败或请求异常时保守返回 approved: false（回退人工审批）。
 */
export async function reviewCommandWithModel(input: {
  reviewerProviderId: string;
  command: string;
  riskLevel: AgentRiskLevel;
  userGoal?: string;
  aiChat: (providerId: string, messages: Message[], options?: { requestId?: string }) => Promise<IPCResult<AIChatResult>>;
}): Promise<ReviewerModelResult> {
  if (input.riskLevel === 'critical') {
    return { approved: false, reason: 'critical commands always require human approval' };
  }
  const messages: Message[] = [
    {
      id: 'reviewer-system',
      role: 'system',
      content: [
        '你是一名严格的生产运维安全审核员。判断以下待执行的 Linux 命令是否安全可控、符合用户目标、无不可逆破坏风险。',
        '必须只返回纯 JSON：{"approve": true或false, "reason": "简短中文原因"}。',
        '若存在数据丢失、误删、断网、提权破坏或范围不明确风险，一律返回 approve: false。',
      ].join('\n'),
      timestamp: Date.now(),
    },
    {
      id: 'reviewer-user',
      role: 'user',
      content: `用户目标：${input.userGoal || '未提供'}\n风险等级：${input.riskLevel}\n待执行命令：\n${input.command}`,
      timestamp: Date.now(),
    },
  ];
  try {
    const result = await input.aiChat(input.reviewerProviderId, messages, {
      requestId: `agent-review-${Date.now()}`,
    });
    if (!result.success || !result.data?.content) {
      return { approved: false, reason: result.success ? 'empty reviewer response' : (result.error || 'reviewer request failed') };
    }
    const raw = result.data.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as { approve?: unknown; reason?: unknown };
    return {
      approved: parsed.approve === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'reviewed by model',
    };
  } catch (error) {
    return {
      approved: false,
      reason: error instanceof Error ? error.message : 'reviewer parse error',
    };
  }
}
