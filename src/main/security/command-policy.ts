import { DANGEROUS_COMMANDS, HIGH_RISK_COMMANDS, MEDIUM_RISK_COMMANDS } from '../../shared/constants';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface TokenizedCommand {
  executable: string;
  tokens: string[];
  normalized: string;
}

export interface CommandCheckResult {
  allowed: boolean;
  riskLevel: RiskLevel;
  reason?: string;
  matchedPattern?: string;
}

function tokenizeCommand(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((token) => token.trim()).filter(Boolean);
}

export function parseCommand(command: string): TokenizedCommand {
  const normalized = command.trim();
  const tokens = tokenizeCommand(normalized);
  const executable = tokens[0]?.replace(/^sudo\s+/, '') || '';
  return {
    executable: executable === 'sudo' ? tokens[1] || '' : executable,
    tokens,
    normalized,
  };
}

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

function matchRiskPattern(command: TokenizedCommand, patterns: string[]): string | undefined {
  const normalizedTokens = command.tokens.map((token) => unquote(token));

  for (const pattern of patterns) {
    const patternTokens = pattern.split(/\s+/);
    const matches = patternTokens.every((patternToken, index) => {
      const current = normalizedTokens[index] || '';
      if (patternToken === 'dd' || patternToken === 'rm' || patternToken === 'mv' || patternToken === 'cp' || patternToken === 'chmod' || patternToken === 'chown' || patternToken === 'kill') {
        return current === patternToken || (index === 0 && command.executable === patternToken);
      }
      return current === patternToken || normalizedTokens.includes(patternToken);
    });

    if (matches) {
      return pattern;
    }
  }

  return undefined;
}

export function analyzeCommandRisk(command: string): { riskLevel: RiskLevel; matchedPattern?: string } {
  const parsed = parseCommand(command);

  const dangerousMatch = matchRiskPattern(parsed, DANGEROUS_COMMANDS);
  if (dangerousMatch) {
    return { riskLevel: 'critical', matchedPattern: dangerousMatch };
  }

  const highRiskMatch = matchRiskPattern(parsed, HIGH_RISK_COMMANDS);
  if (highRiskMatch) {
    return { riskLevel: 'high', matchedPattern: highRiskMatch };
  }

  const mediumRiskMatch = matchRiskPattern(parsed, MEDIUM_RISK_COMMANDS);
  if (mediumRiskMatch) {
    return { riskLevel: 'medium', matchedPattern: mediumRiskMatch };
  }

  return { riskLevel: 'low' };
}

export function shouldBlockCommand(command: string, threshold: RiskLevel = 'critical'): CommandCheckResult {
  const { riskLevel, matchedPattern } = analyzeCommandRisk(command);

  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const thresholdIndex = levels.indexOf(threshold);
  const commandIndex = levels.indexOf(riskLevel);
  const blocked = commandIndex >= thresholdIndex;

  return {
    allowed: !blocked,
    riskLevel,
    reason: blocked ? `命令包含高风险操作: ${matchedPattern}` : undefined,
    matchedPattern,
  };
}

export function requiresApproval(command: string, threshold: RiskLevel = 'medium'): boolean {
  const { riskLevel } = analyzeCommandRisk(command);
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return levels.indexOf(riskLevel) >= levels.indexOf(threshold);
}

export function getRiskDescription(level: RiskLevel): string {
  const descriptions: Record<RiskLevel, string> = {
    low: '普通系统操作命令',
    medium: '此命令会修改文件或系统状态',
    high: '此命令具有较高风险，可能删除或修改重要数据',
    critical: '此命令可能会造成不可逆的系统损坏或数据丢失',
  };
  return descriptions[level];
}
