import type { CommandSuggestion } from '../../shared/types';

export type RiskApprovalDecision = 'approved' | 'rejected';
type RiskLevel = CommandSuggestion['riskLevel'];

/**
 * 会话级「记住审批选择」。
 *
 * 2026-09 收紧：
 * - **按具体命令记忆**，不再按风险等级。旧实现是 `Map<RiskLevel, decision>`，
 *   用户对一条 critical 命令点一次「记住批准」，此后**所有** critical 命令（含
 *   `rm -rf /`）都会在无 UI 的情况下自动执行（`agent-runtime.ts` 的 auto-approve 分支）。
 * - **critical 永不记住**：无论批准还是拒绝一律不落盘，必须每次确认。
 * - 签名保留大小写（远端路径大小写敏感），仅压缩空白，避免 `rm /Data` 与 `rm /data` 混同。
 */
const decisions = new Map<string, RiskApprovalDecision>();

/** 记忆签名：压缩空白 + 去掉首尾空白，不做大小写折叠。 */
export function commandDecisionKey(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** 是否允许为这个风险等级建立记忆。critical 一律不记忆。 */
export function isRememberableRisk(riskLevel: RiskLevel): boolean {
  return riskLevel !== 'critical';
}

/** 记录一条命令的审批选择；critical 会被忽略。 */
export function rememberCommandDecision(
  command: string,
  riskLevel: RiskLevel,
  decision: RiskApprovalDecision,
): void {
  if (!isRememberableRisk(riskLevel)) return;
  const key = commandDecisionKey(command);
  if (!key) return;
  decisions.set(key, decision);
}

/** 查询这条命令是否已被记住批过/拒过；critical 永远返回 null。 */
export function getRememberedCommandDecision(
  command: string,
  riskLevel: RiskLevel,
): RiskApprovalDecision | null {
  if (!isRememberableRisk(riskLevel)) return null;
  const key = commandDecisionKey(command);
  if (!key) return null;
  return decisions.get(key) ?? null;
}

/** 清空全部记忆（设置里关闭「记住选择」时调用）。 */
export function clearRememberedRiskDecisions(): void {
  decisions.clear();
}
