import { dump, load } from 'js-yaml';

/** 编辑器支持的语法语言。 */
export type CodeLanguage = 'json' | 'yaml' | 'text';

/** 按远端文件扩展名判断语言；不认识的一律按纯文本。 */
export function detectCodeLanguage(remotePath: string): CodeLanguage {
  const clean = remotePath.split('?')[0].split('#')[0];
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const base = clean.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return 'text';
}

export type FormatResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** 把 JSON/YAML 文本重新格式化（缩进 2 空格）；解析失败返回错误信息。 */
export function formatCodeContent(language: CodeLanguage, text: string): FormatResult {
  try {
    if (language === 'json') {
      const parsed = JSON.parse(text) as unknown;
      return { ok: true, content: `${JSON.stringify(parsed, null, 2)}\n` };
    }
    if (language === 'yaml') {
      const parsed = load(text);
      // lineWidth: -1 关闭自动折行，noRefs 避免生成 &/★ 锚点引用
      return { ok: true, content: dump(parsed, { indent: 2, lineWidth: -1, noRefs: true }) };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message || String(error) };
  }
  return { ok: false, error: '' };
}
