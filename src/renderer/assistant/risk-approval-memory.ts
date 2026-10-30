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
 * - 签名保留大小写（远端路径大小写敏感），仅压缩**引号外**的空白；引号内的空白
 *   原样保留，避免 `rm "/tmp/report 1"` 与 `rm "/tmp/report  1"` 混同。
 */
const decisions = new Map<string, RiskApprovalDecision>();

/** 判断 index 处的字符是否被紧邻的奇数个反斜杠转义。 */
function isEscapedByBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

/**
 * 记忆签名：去掉首尾空白、仅压缩引号外的空白为单个空格；引号内字符（含连续空格）
 * 原样保留，不做大小写折叠。
 *
 * 引号内的空白是命令语义的一部分：`rm "/tmp/report 1"` 与 `rm "/tmp/report  1"`
 * 删除的是不同文件，必须得到不同的记忆键。引号外的空白不改变语义，仍压缩成一个空格，
 * 让 `rm   report.txt` 与 `rm report.txt` 视为同一条命令。
 * 引号外的反斜杠转义下一个字符（如 `\ ` 是字面空格，不参与压缩）；
 * 单引号内容完全字面；双引号内被反斜杠转义的引号不算闭合（按前置反斜杠奇偶判断）。
 */
export function commandDecisionKey(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  // 引号外空白游程：仅在后面确有非空白内容时补一个空格，自然去掉首尾空白。
  let pendingSpace = false;

  const flushPendingSpace = () => {
    if (pendingSpace) {
      if (out.length > 0) {
        out += ' ';
      }
      pendingSpace = false;
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote) {
      out += ch;
      if (quote === "'") {
        // 单引号内容完全字面，反斜杠无特殊含义，遇 ' 即闭合。
        if (ch === "'") {
          quote = null;
        }
      } else if (ch === '"' && !isEscapedByBackslashes(command, i)) {
        // 双引号：只有未被反斜杠转义的 " 才是闭合引号。
        quote = null;
      }
      continue;
    }

    if (ch === '\\') {
      // 引号外：反斜杠转义下一个字符，整对原样保留（含 `\ ` 字面空格）。
      flushPendingSpace();
      if (i + 1 < command.length) {
        out += ch + command[i + 1];
        i += 1;
      } else {
        out += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      flushPendingSpace();
      quote = ch;
      out += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }

    flushPendingSpace();
    out += ch;
  }

  return out;
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
