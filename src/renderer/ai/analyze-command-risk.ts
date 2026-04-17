import type { CommandSuggestion } from '../../shared/types';
import {
  analyzeCommandRisk as analyzeMainCommandRisk,
  getRiskDescription,
  requiresApproval as requiresMainApproval,
  type RiskLevel,
} from '../../main/security/command-policy';

export type { RiskLevel };

export interface RiskAnalysis {
  command: string;
  riskLevel: RiskLevel;
  isDangerous: boolean;
  description: string;
  riskDescription?: string;
  matchedPattern?: string;
}

const RISK_DESCRIPTIONS: Record<RiskLevel, { description: string; riskDescription?: string }> = {
  critical: {
    description: '此命令可能会造成不可逆的系统损坏或数据丢失',
    riskDescription: '警告：此命令非常危险！可能导致系统崩溃或数据永久丢失。请确保你完全理解此命令的后果。',
  },
  high: {
    description: '此命令具有较高风险，可能删除或修改重要数据',
    riskDescription: '注意：此命令可能删除文件或修改系统配置。请确认这是你想要执行的操作。',
  },
  medium: {
    description: '此命令会修改文件或系统状态',
  },
  low: {
    description: '普通系统操作命令',
  },
};

export function analyzeCommandRisk(command: string): RiskAnalysis {
  const trimmedCmd = command.trim();
  const { riskLevel, matchedPattern } = analyzeMainCommandRisk(trimmedCmd);

  return {
    command: trimmedCmd,
    riskLevel,
    isDangerous: riskLevel !== 'low',
    description: RISK_DESCRIPTIONS[riskLevel].description || getRiskDescription(riskLevel),
    riskDescription: RISK_DESCRIPTIONS[riskLevel].riskDescription,
    matchedPattern,
  };
}

export function riskAnalysisToSuggestion(command: string): CommandSuggestion {
  const analysis = analyzeCommandRisk(command);
  return {
    command: analysis.command,
    description: analysis.description,
    isDangerous: analysis.isDangerous,
    riskLevel: analysis.riskLevel,
    riskDescription: analysis.riskDescription,
  };
}

export function analyzeCommandsRisk(commands: string[]): RiskAnalysis[] {
  return commands.map((cmd) => analyzeCommandRisk(cmd));
}

export function requiresApproval(command: string, threshold: RiskLevel = 'medium'): boolean {
  return requiresMainApproval(command, threshold);
}

export function getRiskWeight(level: RiskLevel): number {
  const weights: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return weights[level];
}

export function compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
  return Math.sign(getRiskWeight(a) - getRiskWeight(b));
}
