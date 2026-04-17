/**
 * 命令执行守卫
 * 在执行 SSH 命令前进行安全检查
 */

import { shouldBlockCommand, analyzeCommandRisk, getRiskDescription, RiskLevel } from './command-policy';

export interface GuardResult {
  allowed: boolean;
  riskLevel: RiskLevel;
  reason?: string;
}

/**
 * 默认阻止阈值
 * - critical: 只阻止极度危险的命令
 * - high: 阻止高风险和极度危险的命令
 */
const DEFAULT_BLOCK_THRESHOLD: RiskLevel = 'critical';

/**
 * 检查命令是否允许执行
 * 这是主进程的安全兜底，即使前端绕过检查，这里也会拦截
 */
export function checkCommandGuard(command: string, threshold: RiskLevel = DEFAULT_BLOCK_THRESHOLD): GuardResult {
  // 空命令直接允许
  if (!command || !command.trim()) {
    return { allowed: true, riskLevel: 'low' };
  }

  const checkResult = shouldBlockCommand(command, threshold);
  
  return {
    allowed: checkResult.allowed,
    riskLevel: checkResult.riskLevel,
    reason: checkResult.reason,
  };
}

/**
 * 记录命令执行日志（用于审计）
 */
export function logCommandExecution(connectionId: string, command: string, riskLevel: RiskLevel): void {
  const timestamp = new Date().toISOString();
  const level = riskLevel.toUpperCase();
  console.log(`[CommandGuard][${timestamp}][${level}] connection=${connectionId}, command=${command.substring(0, 50)}...`);
}

/**
 * 获取命令的风险信息（用于返回给前端）
 */
export function getCommandRiskInfo(command: string): {
  riskLevel: RiskLevel;
  description: string;
} {
  const { riskLevel } = analyzeCommandRisk(command);
  return {
    riskLevel,
    description: getRiskDescription(riskLevel),
  };
}
