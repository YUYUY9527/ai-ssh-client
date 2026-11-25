/**
 * 快捷命令变量模板工具：
 * 支持 `{{varName}}` 与带默认值的 `{{varName:defaultValue}}` 占位符。
 */

export interface SnippetVariable {
  name: string;
  defaultValue: string;
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)(?::([^}]*))?\s*\}\}/g;

/** 按首次出现顺序提取模板变量（自动去重）。 */
export function extractTemplateVariables(template: string): SnippetVariable[] {
  const seen = new Map<string, SnippetVariable>();
  const text = String(template || '');
  let match: RegExpExecArray | null;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(text)) !== null) {
    const name = match[1];
    const defaultValue = match[2] ?? '';
    if (!seen.has(name)) {
      seen.set(name, { name, defaultValue });
    }
  }
  return Array.from(seen.values());
}

/** 用用户输入替换模板中的全部变量占位符。 */
export function renderSnippetTemplate(template: string, values: Record<string, string>): string {
  return String(template || '').replace(VARIABLE_PATTERN, (_full, name: string, fallback?: string) => {
    const provided = values[name];
    if (provided !== undefined && provided !== '') return provided;
    return fallback ?? '';
  });
}
