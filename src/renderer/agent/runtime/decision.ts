/**
 * Agent 决策响应解析：批次一从 agent-runtime.ts 机械搬迁（行为不变）。
 * 负责把模型返回的 JSON / markdown / 散文解析成 AgentResponse，并支持流式投影。
 */

import type { AgentResponse } from '../../../shared/types';
import { normalizeTerminalText } from './text';

/** 本地安全策略拒绝命令时远端返回的错误前缀。 */
const POLICY_BLOCKED_MARKER = 'AGENT_POLICY_BLOCKED';

export const parseAgentResponse = (content: string): AgentResponse | null => {
  let cleanContent = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if ((cleanContent.startsWith('"') && cleanContent.endsWith('"')) ||
      (cleanContent.startsWith("'") && cleanContent.endsWith("'"))) {
    cleanContent = cleanContent.slice(1, -1);
  }

  // 1. 直接 JSON 解析
  try {
    const parsed = JSON.parse(cleanContent);
    if (typeof parsed === 'string') {
      return parseAgentResponse(parsed);
    }
    const response = normalizeAgentResponse(parsed);
    if (response) return response;
  } catch (e) {}

  // 2. 从 markdown 代码块中提取
  const patterns = [/```(?:json)?\s*([\s\S]*?)\s*```/, /`([\s\S]*?)`/];
  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const response = normalizeAgentResponse(parsed);
        if (response) return response;
      } catch (e) {}
    }
  }

  // 3. 提取第一个 { 到最后一个 } 之间的内容
  const firstBrace = cleanContent.indexOf('{');
  const lastBrace = cleanContent.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    const jsonCandidate = cleanContent.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      const response = normalizeAgentResponse(parsed);
      if (response) return response;
    } catch (e) {}

    // 4. 尝试修复常见的 JSON 格式问题
    const fixed = fixMalformedJson(jsonCandidate);
    if (fixed) {
      try {
        const parsed = JSON.parse(fixed);
        const response = normalizeAgentResponse(parsed);
        if (response) return response;
      } catch (e) {}
    }
  }

  // 5. 尝试从纯文本中推断意图（最后的兜底，永不产出 execute —— 见下方说明）
  return inferResponseFromText(cleanContent);
};

function normalizeAgentResponse(value: unknown): AgentResponse | null {
  if (!value || typeof value !== 'object') return null;

  const source = value as Partial<AgentResponse> & {
    thought?: AgentResponse['thought'] | string;
    reasoning?: string;
    observation?: string;
    action?: string | { type?: string; command?: string };
    cmd?: string;
    finish_reason?: string;
  };
  const rawDecision = typeof source.decision === 'string'
    ? source.decision
    : typeof source.action === 'string'
      ? source.action
      : source.action?.type;
  const decision = String(rawDecision || '').toLowerCase();
  if (!['execute', 'finish', 'ask'].includes(decision)) {
    return null;
  }

  const command = source.command
    || source.cmd
    || (typeof source.action === 'object' ? source.action.command : undefined);
  const finishReason = source.finishReason || source.finish_reason;
  const question = source.question;
  const fallbackReason = finishReason
    || question
    || command
    || source.reasoning
    || '';
  const thought = typeof source.thought === 'string'
    ? { reasoning: source.thought, observation: source.observation || '' }
    : {
      reasoning: source.thought?.reasoning || fallbackReason,
      observation: source.thought?.observation || source.observation || '',
    };

  return {
    ...source,
    thought,
    decision: decision as AgentResponse['decision'],
    ...(command ? { command } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(question ? { question } : {}),
  } as AgentResponse;
}

/** 去掉安全策略错误里的机器可读前缀，避免把它渲染给用户。 */
export function stripPolicyMarker(message: string): string {
  const stripped = message.replace(`${POLICY_BLOCKED_MARKER}:`, '').replace(POLICY_BLOCKED_MARKER, '').trim();
  return stripped || message;
}

/**
 * 修复常见的 JSON 格式问题 —— 只做「不改变取值」的修复。
 *
 * 历史缺陷（2026-09 修复）：
 * - 旧实现有一条 `fixed.replace(/'/g, '"')`，会把命令里的撇号一起换掉
 *   （`echo "it's"` → `echo "it"s"`），而被污染的字符串就是**最终执行的命令**。
 * - 尾逗号正则 `/,\s*([}\]])/g` 会误伤字符串值本身（`"a,}"`），同样篡改命令。
 * 现在两者都改为按「是否在字符串内」逐字符扫描；单引号替换只在整段完全没有
 * 双引号（即确为单引号 JSON）时才启用。
 */
function fixMalformedJson(json: string): string | null {
  let fixed = stripTrailingCommasOutsideStrings(json);
  fixed = escapeRawControlCharsInStrings(fixed);

  if (!fixed.includes('"') && fixed.includes("'")) {
    fixed = fixed.replace(/'/g, '"');
  }

  // 如果修复后和原始一样，返回 null 避免重复尝试
  if (fixed === json) return null;
  return fixed;
}

/** 删除字符串外的尾逗号（`{"a":1,}` → `{"a":1}`），字符串内的 `,}` 保持原样。 */
function stripTrailingCommasOutsideStrings(json: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < json.length && /\s/.test(json[lookahead])) lookahead += 1;
      if (json[lookahead] === '}' || json[lookahead] === ']') {
        continue;
      }
    }

    output += char;
  }

  return output;
}

/** 把字符串值里未转义的换行/制表符换成转义序列（模型常直接换行输出）。 */
function escapeRawControlCharsInStrings(json: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (!inString) {
      if (char === '"') inString = true;
      output += char;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = false;
      output += char;
      continue;
    }
    if (char === '\n') {
      output += '\\n';
      continue;
    }
    if (char === '\r') {
      output += '\\r';
      continue;
    }
    if (char === '\t') {
      output += '\\t';
      continue;
    }
    output += char;
  }

  return output;
}

/**
 * 从纯文本中推断 AI 的意图（兜底策略）。
 *
 * 安全约束（2026-09 起）：**本函数永不返回 `execute`**。
 * 旧实现会从散文里抓「执行命令：xxx」并据此构造 execute 决策，低风险命令会被
 * 直接执行、完全绕过审批 —— 对 SSH Agent 而言「模型提到过」不等于「用户批准过」。
 * 现在散文只用于判定 ask / finish；想执行命令必须给出结构化 JSON。
 */
function inferResponseFromText(text: string): AgentResponse | null {
  // 如果文本看起来像截断的 JSON，不要推断 — 返回 null 让上层处理
  if (text.includes('"thought"') || text.includes('"decision"') || text.includes('"reasoning"')) {
    return null;
  }

  // 检测是否是完成意图 — 要求更明确的表述
  if (/^(?:任务完成|已完成|done|completed|finished)[。.!]?\s*$/im.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 200), observation: '' },
      decision: 'finish',
      finishReason: text.slice(0, 100),
    };
  }

  const looksLikeConclusion = /(当前|系统|cpu|内存|负载|load average|memory|usage|状态|结果)[\s\S]{0,120}(正常|较低|良好|健康|无异常|没有异常|未发现异常|完成|达成)/i
    .test(text);
  if (looksLikeConclusion || /(no further action|nothing else is needed|looks normal)/i.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 300), observation: text.slice(0, 300) },
      decision: 'finish',
      finishReason: text.slice(0, 300),
    };
  }

  const looksLikeCollectedResult = (
    /(?:已|已经|成功)?(?:查看|看到|获取|获得|采集|检查|确认|分析)(?:到|了)?/i.test(text)
    && /(cpu|利用率|负载|load average|内存|memory|mem|swap|tasks|进程|状态)/i.test(text)
  );
  if (looksLikeCollectedResult || /(i have|i've|successfully).*(checked|collected|found|observed)/i.test(text)) {
    return {
      thought: { reasoning: text.slice(0, 300), observation: text.slice(0, 300) },
      decision: 'finish',
      finishReason: text.slice(0, 300),
    };
  }

  // 检测是否是提问意图
  if (/(?:请问|请确认|需要.*确认|你想|是否)[^。]*[?？]\s*$/m.test(text)) {
    return {
      thought: { reasoning: '需要用户确认', observation: '' },
      decision: 'ask',
      question: text.slice(0, 300),
    };
  }

  const meaningfulText = text.trim();
  if (meaningfulText.length >= 12) {
    const asksForMore = /(?:请(?:提供|告诉|说明|确认)|需要(?:更多|进一步)|what.*need|need.*information)/i.test(meaningfulText);
    if (asksForMore || /[?？]\s*$/.test(meaningfulText)) {
      return {
        thought: { reasoning: '需要用户补充信息', observation: '' },
        decision: 'ask',
        question: meaningfulText.slice(0, 1000),
      };
    }

    // 部分 OpenAI-compatible 模型会忽略“纯 JSON”要求而直接返回可读答复。
    // 将这类答复作为正常完成结果展示，避免把有效回答误报为“AI 响应无效”。
    return {
      thought: { reasoning: meaningfulText.slice(0, 500), observation: '' },
      decision: 'finish',
      finishReason: meaningfulText.slice(0, 2000),
    };
  }

  return null;
}

export const detectTerminalBlocking = (output: string): { isBlocking: boolean; prompt: string } => {
  const normalizedOutput = normalizeTerminalText(output);
  const lastLines = normalizedOutput.split('\n').slice(-5).join('\n').toLowerCase();
  const blockingPatterns: Array<{ pattern: RegExp; prompt: string }> = [
    { pattern: /\[y\/n\]/i, prompt: 'Y/N 确认' },
    { pattern: /\[y\]/i, prompt: 'Y 确认' },
    { pattern: /yes\/no/i, prompt: 'Yes/No 确认' },
    { pattern: /\(yes\/no\)/i, prompt: 'Yes/No 确认' },
    { pattern: /\(y\/n\)/i, prompt: 'Y/N 确认' },
    { pattern: /remove regular file.*[?？]/i, prompt: 'rm 删除确认' },
    { pattern: /remove directory.*[?？]/i, prompt: 'rm 目录删除确认' },
    { pattern: /overwrite .*[\?:：]?\s*$/i, prompt: '覆盖确认' },
    { pattern: /是否删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否删除(?:普通|常规)?文件.*[?？]/i, prompt: '删除确认' },
    { pattern: /是否覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /确认删除.*[?？]/i, prompt: '删除确认' },
    { pattern: /确认覆盖.*[?？]/i, prompt: '覆盖确认' },
    { pattern: /是否继续.*[?？]/i, prompt: '继续确认' },
    { pattern: /password:\s*$/i, prompt: '密码输入' },
    { pattern: /passphrase\s*(for|:)/i, prompt: '密钥密码' },
    { pattern: /enter passphrase/i, prompt: '密钥密码' },
    { pattern: /sudo.*password/i, prompt: 'sudo 密码' },
    { pattern: /continue\?/i, prompt: '继续确认' },
    { pattern: /proceed\?/i, prompt: '继续确认' },
    { pattern: /do you want/i, prompt: '操作确认' },
    { pattern: /are you sure/i, prompt: '操作确认' },
    { pattern: /confirm\s*\??/i, prompt: '操作确认' },
    { pattern: /apt.*\[y\/i\/n\]/i, prompt: 'apt 交互确认' },
    { pattern: /yum.*\[y\/n\]/i, prompt: 'yum 交互确认' },
    { pattern: /dnf.*\[y\/n\]/i, prompt: 'dnf 交互确认' },
    { pattern: /do you want to continue\?/i, prompt: '包管理器确认' },
    { pattern: /are you sure you want to continue connecting/i, prompt: 'SSH 首次连接确认' },
    { pattern: /fingerprint.*yes\/no/i, prompt: 'SSH 指纹确认' },
    { pattern: /:\s*$/m, prompt: '分页器等待' },
    { pattern: /--more--/i, prompt: '分页器等待' },
    { pattern: /\(end\)/i, prompt: '分页器结束' },
    { pattern: /vim.*\:$/m, prompt: 'Vim 编辑器等待' },
    { pattern: /nano.*\^G/i, prompt: 'Nano 编辑器等待' },
  ];

  for (const { pattern, prompt } of blockingPatterns) {
    if (pattern.test(lastLines)) {
      return { isBlocking: true, prompt };
    }
  }

  return { isBlocking: false, prompt: '' };
};

export const hasShellPrompt = (output: string): boolean => {
  const normalizedTail = normalizeTerminalText(output).slice(-4096);
  const tail = normalizedTail.split('\n').slice(-8).join('\n').trimEnd();
  const promptPatterns = [
    /\]\s*#\s*$/m,
    /\]\s*\$\s*$/m,
    /\w+@[\w.-]+:\S+#\s*$/m,
    /\w+@[\w.-]+:\S+\$\s*$/m,
    /\[[^\]]+@[^\]]+\][#$]\s*$/m,
    /\[[^\]\n]{1,120}@[^\]\n]{1,120}\][#$]/m,
    /\[[^\]\n]{1,120}@[^\]\n]{1,120}\s+[^\]\n]{0,120}\][#$]/m,
    /(?:^|\n)[^\n]{0,80}[#$]\s*$/m,
  ];

  return promptPatterns.some((pattern) => pattern.test(tail))
    || promptPatterns.some((pattern) => pattern.test(normalizedTail.trimEnd()));
};

export const isLikelyLongRunningCommand = (command: string): boolean => {
  const normalized = command.toLowerCase();
  const patterns = [
    /\bgit\s+clone\b/,
    /\bnpm\s+(install|ci|update)\b/,
    /\byarn\s+(install|add|upgrade)\b/,
    /\bpnpm\s+(install|add|update)\b/,
    /\bbun\s+install\b/,
    /\bpip(?:3)?\s+install\b/,
    /\buv\s+(pip\s+install|sync)\b/,
    /\bpoetry\s+install\b/,
    /\bcomposer\s+install\b/,
    /\bcargo\s+(build|install|check|test)\b/,
    /\bgo\s+(build|test|get|install)\b/,
    /\bapt(-get)?\s+(install|upgrade|update)\b/,
    /\byum\s+(install|update)\b/,
    /\bdnf\s+(install|update|upgrade)\b/,
    /\bpacman\s+-S\b/,
    /\bbrew\s+(install|upgrade|update)\b/,
    /\b(make|cmake|gradle|mvn|docker\s+build)\b/,
    /\b(wget|curl)\b/,
    /\bscp\b/,
    /\brsync\b/,
    /\bfind\s+\/\b/,
    /\bfind\s+\S+\s+.*(-name|-type|-exec|-size|-mtime|-ctime|-atime)\b/,
    /\bgrep\s+.*\s+\/\b/,
    /\bgrep\s+.*\s+(-r|-R|--recursive)\b/,
    /\bdu\s+.*\s+\/\b/,
    /\bjournalctl\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

export const shouldWaitForShellPrompt = (command: string): boolean => {
  const normalized = command.toLowerCase();
  const patterns = [
    /\bfind\s+\/\b/,
    /\bfind\s+\S+\s+.*(-name|-type|-exec|-size|-mtime|-ctime|-atime)\b/,
    /\bgrep\s+.*\s+\/\b/,
    /\bgrep\s+.*\s+(-r|-R|--recursive)\b/,
    /\bdu\s+.*\s+\/\b/,
    /\bjournalctl\b/,
    /\btail\s+-f\b/,
    /\btop\b/,
    /\bhtop\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
};

export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, ' ');

export const isSafeRepeatableCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command).toLowerCase();
  const patterns = [
    /^(ls|ll)\b/, /^pwd$/, /^whoami$/, /^id$/, /^stat\b/, /^test\b/,
    /^find\b/, /^cat\b/, /^head\b/, /^tail\b/, /^grep\b/, /^du\b/, /^df\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
};

export const appendTail = (current: string, chunk: string, maxSize: number): string => {
  if (!chunk) return current;
  const next = current + chunk;
  if (next.length <= maxSize) return next;
  return next.slice(-Math.floor(maxSize * 0.75));
};

type JsonObjectContext = {
  path: string[];
  key: string | null;
  mode: 'key' | 'colon' | 'value' | 'comma';
};

function decodePartialJsonString(source: string, start: number): {
  value: string;
  end: number;
  complete: boolean;
} {
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      return { value, end: index + 1, complete: true };
    }
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) break;
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped === 'u') {
      const digits = source.slice(index + 2, index + 6);
      if (digits.length < 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) break;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 6;
      continue;
    }
    value += escapes[escaped] ?? escaped;
    index += 2;
  }

  return { value, end: source.length, complete: false };
}

export function formatAgentResponseProjection(response: AgentResponse): string {
  return [
    response.thought.reasoning,
    response.thought.observation
      ? `观察：${response.thought.observation}`
      : '',
    response.finishReason
      ? `结论：${response.finishReason}`
      : '',
  ].filter(Boolean).join('\n\n');
}

export function extractAgentStreamProjection(source: string): string {
  const firstObject = source.indexOf('{');
  if (firstObject < 0) return '';

  const stack: JsonObjectContext[] = [];
  const values = new Map<string, string>();
  let index = firstObject;

  while (index < source.length) {
    const context = stack[stack.length - 1];
    const char = source[index];

    if (char === '{') {
      const path = context?.mode === 'value' && context.key
        ? [...context.path, context.key]
        : [];
      if (context?.mode === 'value') context.mode = 'comma';
      stack.push({ path, key: null, mode: 'key' });
      index += 1;
      continue;
    }
    if (char === '}') {
      stack.pop();
      index += 1;
      continue;
    }
    if (!context) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const token = decodePartialJsonString(source, index);
      if (context.mode === 'key') {
        if (token.complete) {
          context.key = token.value;
          context.mode = 'colon';
        }
      } else if (context.mode === 'value' && context.key) {
        const fieldPath = [...context.path, context.key].join('.');
        if (
          fieldPath === 'thought.reasoning'
          || fieldPath === 'thought.observation'
          || fieldPath === 'finishReason'
        ) {
          values.set(fieldPath, token.value);
        }
        if (token.complete) context.mode = 'comma';
      }
      index = token.end;
      continue;
    }
    if (char === ':' && context.mode === 'colon') {
      context.mode = 'value';
    } else if (char === ',' && context.mode === 'comma') {
      context.key = null;
      context.mode = 'key';
    } else if (context.mode === 'value' && !/\s/.test(char)) {
      context.mode = 'comma';
    }
    index += 1;
  }

  return [
    values.get('thought.reasoning'),
    values.get('thought.observation')
      ? `观察：${values.get('thought.observation')}`
      : '',
    values.get('finishReason')
      ? `结论：${values.get('finishReason')}`
      : '',
  ].filter(Boolean).join('\n\n');
}
