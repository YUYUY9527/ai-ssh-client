import type { TerminalHighlightColor, TerminalHighlightRule } from '../../../shared/types';

export interface CompiledHighlightRule {
  id: string;
  regex: RegExp;
  ansiStart: string;
}

const COLOR_TO_ANSI: Record<TerminalHighlightColor, string> = {
  danger: '\x1b[1;31m',
  warning: '\x1b[1;33m',
  success: '\x1b[1;32m',
  info: '\x1b[36m',
  accent: '\x1b[1;35m',
};

export const DEFAULT_TERMINAL_HIGHLIGHT_RULES: TerminalHighlightRule[] = [
  {
    id: 'builtin-error',
    pattern: '\\b(?:ERROR|FATAL|CRITICAL|PANIC|Exception|Traceback)\\b',
    color: 'danger',
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: 'builtin-warn',
    pattern: '\\b(?:WARN|WARNING)\\b',
    color: 'warning',
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: 'builtin-ok',
    pattern: '\\b(?:SUCCESS|PASSED|READY)\\b',
    color: 'success',
    enabled: true,
    caseInsensitive: false,
  },
  {
    id: 'builtin-ip',
    pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    color: 'info',
    enabled: true,
    caseInsensitive: false,
  },
];

// 匹配 ANSI CSI / OSC / ESC 转义序列，确保高亮只作用于纯文本段，不破坏控制码。
const ANSI_TOKEN_RE = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/g;

export function compileHighlightRules(rules?: TerminalHighlightRule[]): CompiledHighlightRule[] {
  const source = Array.isArray(rules) ? rules : DEFAULT_TERMINAL_HIGHLIGHT_RULES;
  const compiled: CompiledHighlightRule[] = [];
  for (const rule of source) {
    if (!rule || !rule.enabled || !rule.pattern || !rule.pattern.trim()) continue;
    try {
      const flags = rule.caseInsensitive ? 'gi' : 'g';
      const regex = new RegExp(rule.pattern, flags);
      compiled.push({
        id: rule.id,
        regex,
        ansiStart: COLOR_TO_ANSI[rule.color] || COLOR_TO_ANSI.warning,
      });
    } catch {
      // 忽略用户输入中的非法正则，避免终端崩溃
    }
  }
  return compiled;
}

function highlightPlainSegment(segment: string, rules: CompiledHighlightRule[]): string {
  if (!segment || rules.length === 0) return segment;
  let current = segment;
  for (const rule of rules) {
    // 仅对尚未被前序规则包裹的纯文本片段进行替换，防止嵌套损坏 ANSI 码
    const parts = current.split(ANSI_TOKEN_RE);
    let insideAnsi = false;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) continue;
      if (part.startsWith('\x1b')) {
        if (part === '\x1b[0m' || part === '\x1b[m') {
          insideAnsi = false;
        } else if (part.startsWith('\x1b[') && part.endsWith('m')) {
          insideAnsi = true;
        }
        continue;
      }
      if (insideAnsi) continue;
      rule.regex.lastIndex = 0;
      parts[i] = part.replace(rule.regex, (match) => {
        if (!match) return match;
        return `${rule.ansiStart}${match}\x1b[0m`;
      });
    }
    current = parts.join('');
  }
  return current;
}

/**
 * 对终端输出分片按规则进行关键词高亮着色。
 * - 全屏程序（alternate screen）下不介入；
 * - 严格避开已有的 ANSI 控制序列（含带颜色的输出段），防止破坏终端排版。
 */
export function applyTerminalHighlights(
  chunk: string,
  rules: CompiledHighlightRule[],
  isAlternateScreen = false,
): string {
  if (!chunk || isAlternateScreen || rules.length === 0) {
    return chunk;
  }
  const parts = chunk.split(ANSI_TOKEN_RE);
  let activeColor = false;
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (part.startsWith('\x1b')) {
      if (part === '\x1b[0m' || part === '\x1b[m') {
        activeColor = false;
      } else if (part.startsWith('\x1b[') && part.endsWith('m')) {
        activeColor = true;
      }
      continue;
    }
    // 保留远端程序自己已经着色的片段，只高亮无色普通日志文本
    if (activeColor) continue;
    const next = highlightPlainSegment(part, rules);
    if (next !== part) {
      parts[i] = next;
      changed = true;
    }
  }
  return changed ? parts.join('') : chunk;
}
