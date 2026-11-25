import { StreamLanguage, type StringStream } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import type { CodeLanguage } from './code-format';

function readQuoted(stream: StringStream, quote: string): string {
  let escaped = false;
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === quote && !escaped) break;
    escaped = ch === '\\' && !escaped;
  }
  return 'string';
}

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'set',
  'unset', 'shift', 'source', 'break', 'continue', 'trap', 'exec', 'eval',
]);

const shellLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^\$\{[^}]+\}/) || stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/) || stream.match(/^\$[0-9?@*#$!-]/)) {
      return 'variableName';
    }
    if (stream.match(/^--?[A-Za-z0-9_-]+/)) return 'attributeName';
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?/)) return 'number';
    if (stream.match(/^(?:&&|\|\||>>|<<|[|&;<>]=?)/)) return 'operator';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_-]*(?==)/)) return 'propertyName';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/)) {
      return SHELL_KEYWORDS.has(stream.current()) ? 'keyword' : null;
    }
    stream.next();
    return null;
  },
});

const confLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.sol() && stream.match(/^\s*\[[^\]]+\]/)) return 'heading';
    if (stream.match('#') || stream.match(';')) {
      stream.skipToEnd();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^(?:true|false|on|off|yes|no)\b/i)) return 'bool';
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?(?:[kKmMgGtT]|[mM]?s)?\b/)) return 'number';
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_.-]*(?=\s*[=:]|\s+)/)) return 'propertyName';
    if (stream.match(/^[={};]/)) return 'operator';
    stream.next();
    return null;
  },
});

const DOCKER_KEYWORDS = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY',
  'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL',
  'HEALTHCHECK', 'SHELL', 'AS',
]);

const dockerfileLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^\$\{[^}]+\}/) || stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_-]*/)) {
      return DOCKER_KEYWORDS.has(stream.current().toUpperCase()) ? 'keyword' : null;
    }
    stream.next();
    return null;
  },
});

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'try', 'except', 'finally', 'raise', 'with', 'as', 'import', 'from', 'pass', 'lambda',
  'yield', 'async', 'await', 'in', 'is', 'not', 'and', 'or', 'global', 'nonlocal', 'assert', 'del',
]);

const pythonLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^@[A-Za-z_][A-Za-z0-9_.]*/)) return 'meta';
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^(?:True|False|None)\b/)) return 'bool';
    if (stream.match(/^0x[0-9a-fA-F]+/) || stream.match(/^[0-9]+(?:\.[0-9]+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      return PYTHON_KEYWORDS.has(stream.current()) ? 'keyword' : null;
    }
    stream.next();
    return null;
  },
});

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS',
  'IN', 'LIKE', 'BETWEEN', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
  'DISTINCT', 'UNION', 'ALL', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'EXPLAIN', 'ANALYZE', 'GRANT', 'REVOKE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

const sqlLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      while (!stream.eol() && !stream.match('*/')) stream.next();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === "'" || ch === '"' || ch === '`') {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      return SQL_KEYWORDS.has(stream.current().toUpperCase()) ? 'keyword' : null;
    }
    stream.next();
    return null;
  },
});

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
  'new', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'export',
  'from', 'async', 'await', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'this', 'super',
]);

const javascriptLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      while (!stream.eol() && !stream.match('*/')) stream.next();
      return 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^(?:true|false|null|undefined)\b/)) return 'bool';
    if (stream.match(/^0x[0-9a-fA-F]+/) || stream.match(/^[0-9]+(?:\.[0-9]+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)) {
      return JS_KEYWORDS.has(stream.current()) ? 'keyword' : null;
    }
    stream.next();
    return null;
  },
});

const xmlLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('<!--')) {
      while (!stream.eol() && !stream.match('-->')) stream.next();
      return 'comment';
    }
    if (stream.match(/^<\/?[A-Za-z_][A-Za-z0-9:._-]*/)) return 'tagName';
    if (stream.match(/^\/?>/)) return 'bracket';
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      return readQuoted(stream, ch);
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9:._-]*(?=\s*=)/)) return 'attributeName';
    stream.next();
    return null;
  },
});

const markdownLang = StreamLanguage.define({
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^#{1,6}\s.*/)) return 'heading';
      if (stream.match(/^>\s.*/)) return 'quote';
      if (stream.match(/^```.*/)) return 'meta';
      if (stream.match(/^\s*(?:[-*+]|\d+\.)\s/)) return 'keyword';
    }
    if (stream.match(/^`[^`]+`/)) return 'string';
    if (stream.match(/^\*\*[^*]+\*\*/)) return 'strong';
    if (stream.match(/^\[[^\]]+\]\([^)]+\)/)) return 'link';
    stream.next();
    return null;
  },
});

/** 根据 CodeLanguage 返回对应的 CodeMirror 6 语法高亮扩展。 */
export function resolveCodeMirrorLanguage(language: CodeLanguage): Extension {
  switch (language) {
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'shell':
      return shellLang;
    case 'conf':
      return confLang;
    case 'dockerfile':
      return dockerfileLang;
    case 'python':
      return pythonLang;
    case 'sql':
      return sqlLang;
    case 'javascript':
      return javascriptLang;
    case 'xml':
      return xmlLang;
    case 'markdown':
      return markdownLang;
    default:
      return [];
  }
}
