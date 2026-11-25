import { dump, load } from 'js-yaml';

/** 编辑器支持的语法语言（覆盖常见运维配置与脚本语言）。 */
export type CodeLanguage =
  | 'json'
  | 'yaml'
  | 'shell'
  | 'conf'
  | 'dockerfile'
  | 'python'
  | 'sql'
  | 'javascript'
  | 'xml'
  | 'markdown'
  | 'text';

const SHELL_NAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.profile',
  '.zprofile',
  'makefile',
  'gnumakefile',
]);

const CONF_NAMES = new Set([
  'nginx.conf',
  'sshd_config',
  'ssh_config',
  'hosts',
  'fstab',
  'crontab',
  'resolv.conf',
  'sysctl.conf',
  'caddyfile',
  '.env',
]);

/** 按远端文件名或扩展名判断语言；不认识的一律按纯文本。 */
export function detectCodeLanguage(remotePath: string): CodeLanguage {
  const clean = remotePath.split('?')[0].split('#')[0];
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const base = clean.slice(slash + 1);
  const lower = base.toLowerCase();

  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (SHELL_NAMES.has(lower)) return 'shell';
  if (CONF_NAMES.has(lower) || lower.startsWith('.env.')) return 'conf';

  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  switch (ext) {
    case 'json':
    case 'jsonc':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ksh':
    case 'mk':
      return 'shell';
    case 'conf':
    case 'cfg':
    case 'ini':
    case 'toml':
    case 'env':
    case 'properties':
    case 'service':
    case 'socket':
    case 'timer':
    case 'target':
    case 'nginx':
    case 'htaccess':
      return 'conf';
    case 'py':
    case 'pyw':
    case 'pyi':
      return 'python';
    case 'sql':
    case 'ddl':
    case 'dml':
      return 'sql';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
    case 'ts':
    case 'mts':
    case 'cts':
    case 'tsx':
      return 'javascript';
    case 'xml':
    case 'html':
    case 'htm':
    case 'svg':
    case 'xhtml':
    case 'plist':
      return 'xml';
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'markdown';
    default:
      return 'text';
  }
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
