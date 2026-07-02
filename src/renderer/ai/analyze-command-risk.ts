/**
 * 命令风险分析器
 *
 * 该模块负责分析 Linux/Unix 命令的风险级别，用于在 AI Agent 执行前进行安全检查。
 * 通过模式匹配识别危险命令，并提供详细的风险描述和建议。
 */

import type { CommandSuggestion } from '../../shared/types';
import {
  DANGEROUS_COMMANDS,
  HIGH_RISK_COMMANDS,
  MEDIUM_RISK_COMMANDS,
} from '../../shared/constants';

/**
 * 风险级别类型
 * - low: 低风险，普通操作命令
 * - medium: 中风险，会修改文件或系统状态
 * - high: 高风险，可能删除或修改重要数据
 * - critical: 严重风险，可能造成不可逆的系统损坏
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 风险分析结果接口
 */
export interface RiskAnalysis {
  /** 分析的命令 */
  command: string;
  /** 风险级别 */
  riskLevel: RiskLevel;
  /** 是否为危险命令 */
  isDangerous: boolean;
  /** 风险描述 */
  description: string;
  /** 详细的风险说明（可选） */
  riskDescription?: string;
  /** 匹配到的危险模式（可选） */
  matchedPattern?: string;
}

/**
 * 各风险级别的描述信息
 */
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

/**
 * 风险模式配置
 * 按风险级别分组的命令模式列表
 */
const RISK_PATTERNS: Array<{ riskLevel: RiskLevel; patterns: string[] }> = [
  { riskLevel: 'critical', patterns: DANGEROUS_COMMANDS },
  { riskLevel: 'high', patterns: HIGH_RISK_COMMANDS },
  { riskLevel: 'medium', patterns: MEDIUM_RISK_COMMANDS },
];

/**
 * 规范化命令字符串
 *
 * 移除多余的空格并转换为小写，便于模式匹配
 *
 * @param command - 原始命令字符串
 * @returns 规范化后的命令字符串
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 通过模式匹配分析命令风险
 *
 * @param command - 要分析的命令
 * @returns 包含风险级别和匹配模式的对象
 */
function analyzePattern(command: string): { riskLevel: RiskLevel; matchedPattern?: string } {
  const normalizedCommand = normalizeCommand(command);

  for (const { riskLevel, patterns } of RISK_PATTERNS) {
    const matchedPattern = patterns.find((pattern) => (
      normalizedCommand.includes(normalizeCommand(pattern))
    ));
    if (matchedPattern) {
      return { riskLevel, matchedPattern };
    }
  }

  return { riskLevel: 'low' };
}

/**
 * 分析命令风险
 *
 * 主要的风险分析函数，返回详细的风险分析结果
 *
 * @param command - 要分析的命令字符串
 * @returns 风险分析结果对象
 */
export function analyzeCommandRisk(command: string): RiskAnalysis {
  const trimmedCmd = command.trim();
  const { riskLevel, matchedPattern } = analyzePattern(trimmedCmd);

  return {
    command: trimmedCmd,
    riskLevel,
    isDangerous: riskLevel !== 'low',
    description: RISK_DESCRIPTIONS[riskLevel].description,
    riskDescription: RISK_DESCRIPTIONS[riskLevel].riskDescription,
    matchedPattern,
  };
}

/**
 * 将风险分析结果转换为命令建议格式
 *
 * 用于 UI 显示和用户确认
 *
 * @param command - 要分析的命令
 * @returns 命令建议对象
 */
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

/**
 * 批量分析多个命令的风险
 *
 * @param commands - 命令字符串数组
 * @returns 风险分析结果数组
 */
export function analyzeCommandsRisk(commands: string[]): RiskAnalysis[] {
  return commands.map((cmd) => analyzeCommandRisk(cmd));
}

/**
 * 判断命令是否需要用户审批
 *
 * 当命令风险级别达到或超过阈值时，需要用户确认后才能执行
 *
 * @param command - 要检查的命令
 * @param threshold - 风险级别阈值（默认为 medium）
 * @returns 如果需要审批返回 true
 */
export function requiresApproval(command: string, threshold: RiskLevel = 'medium'): boolean {
  return getRiskWeight(analyzeCommandRisk(command).riskLevel) >= getRiskWeight(threshold);
}

/**
 * 获取风险级别的权重值
 *
 * 用于风险级别的比较和排序
 *
 * @param level - 风险级别
 * @returns 风险权重（0-3）
 */
export function getRiskWeight(level: RiskLevel): number {
  const weights: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return weights[level];
}

/**
 * 比较两个风险级别
 *
 * @param a - 第一个风险级别
 * @param b - 第二个风险级别
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b
 */
export function compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
  return Math.sign(getRiskWeight(a) - getRiskWeight(b));
}
