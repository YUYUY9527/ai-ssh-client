/**
 * Agent 运行时用到的纯文本工具：ANSI 清理、终端文本归一化、关键输出提取。
 * 抽到独立模块，便于单独测试，也避免运行时主文件继续膨胀。
 */

/** 去掉 ANSI 转义序列（含 OSC 序列）。 */
export const stripAnsi = (text: string): string => text
  .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
  .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

/** 终端原始输出归一化：去 ANSI、统一换行、去 NUL、压缩行尾空白。 */
export const normalizeTerminalText = (text: string): string => stripAnsi(text)
  .replace(/\r/g, '\n')
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n');

/**
 * 在长度受限时提取「关键输出」：优先保留疑似报错/结构和最后若干行。
 * 用于把长命令输出压到上下文预算内，同时尽量避免丢掉错误信息。
 */
export const extractKeyOutput = (output: string, maxLength: number): string => {
  if (output.length <= maxLength) return output;

  const lines = output.split('\n');
  const keyLines: string[] = [];
  let currentLength = 0;

  const errorPatterns = [
    /error/i, /failed/i, /exception/i, /warning/i, /fatal/i,
    /denied/i, /permission/i, /not found/i, /cannot/i, /unable/i,
  ];
  const importantPatterns = [/\[.*\]/, /^-{3,}/, /^={3,}/, /^\s*\d+/];

  for (const line of lines) {
    if (currentLength + line.length > maxLength * 0.7) break;
    const isError = errorPatterns.some(p => p.test(line));
    const isImportant = importantPatterns.some(p => p.test(line));
    if (isError || isImportant) {
      keyLines.push(line);
      currentLength += line.length + 1;
    }
  }

  const lastLines = lines.slice(-20);
  const result = [...new Set([...keyLines, ...lastLines])].join('\n');

  return result.length > maxLength ? '...\n' + result.slice(-maxLength + 10) : result;
};
