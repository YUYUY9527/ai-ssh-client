import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, CornerDownLeft } from 'lucide-react';

interface AgentMarkdownViewProps {
  content: string;
  /** 可选：将代码块内容直接填入当前终端输入行（不自动回车执行）。 */
  onInsertCommand?: (command: string) => void;
  copyLabel?: string;
  copiedLabel?: string;
  insertLabel?: string;
}

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'hr' }
  | { kind: 'paragraph'; lines: string[] };

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseMarkdownBlocks(raw: string): Block[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    // 围栏代码块
    const fenceMatch = trimmed.match(/^```([\w.+-]*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // 水平分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    // 标题
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    // Markdown 表格
    if (index + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[index + 1])) {
      const headers = splitTableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // 普通段落
    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      const nextTrim = next.trim();
      if (
        !nextTrim
        || nextTrim.startsWith('```')
        || /^#{1,3}\s+/.test(nextTrim)
        || /^[-*+]\s+/.test(nextTrim)
        || /^\d+\.\s+/.test(nextTrim)
        || nextTrim.startsWith('>')
        || /^(-{3,}|\*{3,}|_{3,})$/.test(nextTrim)
        || (index + 1 < lines.length && isTableRow(next) && isTableSeparator(lines[index + 1]))
      ) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraphLines });
  }

  return blocks;
}

const INLINE_TOKEN_RE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*)/g;

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_TOKEN_RE.lastIndex = 0;

  while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${match.index}-${token.length}`;
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={key} className="agent-md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (
      (token.startsWith('**') && token.endsWith('**'))
      || (token.startsWith('__') && token.endsWith('__'))
    ) {
      parts.push(<strong key={key} className="font-semibold text-fg">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={key} className="italic">{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-hover"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    } else {
      parts.push(token);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function isShellLikeCode(lang: string, code: string): boolean {
  const normalized = lang.trim().toLowerCase();
  if (['bash', 'sh', 'zsh', 'shell', 'console', 'cmd', 'powershell'].includes(normalized)) {
    return true;
  }
  return !normalized && code.trim().length > 0 && code.trim().split('\n').length <= 3;
}

/** 渲染终端 Agent 回复的轻量 Markdown（真实 HTML 表格 + 可复制/填入终端的代码块）。 */
export function AgentMarkdownView({
  content,
  onInsertCommand,
  copyLabel = '复制',
  copiedLabel = '已复制',
  insertLabel = '填入终端',
}: AgentMarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyCode = async (index: number, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIndex(index);
      window.setTimeout(() => {
        setCopiedIndex((current) => (current === index ? null : current));
      }, 1500);
    } catch {
      // 忽略剪贴板权限限制
    }
  };

  return (
    <div className="agent-md">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          const cls = block.level === 1
            ? 'agent-md-h1'
            : block.level === 2
              ? 'agent-md-h2'
              : 'agent-md-h3';
          return <div key={index} className={cls}>{renderInline(block.text)}</div>;
        }
        if (block.kind === 'hr') {
          return <hr key={index} className="border-line-subtle" />;
        }
        if (block.kind === 'quote') {
          return (
            <blockquote key={index} className="agent-md-quote">
              {block.lines.map((line, i) => (
                <div key={i}>{renderInline(line)}</div>
              ))}
            </blockquote>
          );
        }
        if (block.kind === 'ul') {
          return (
            <ul key={index} className="agent-md-ul">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'ol') {
          return (
            <ol key={index} className="agent-md-ol">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.kind === 'table') {
          return (
            <div key={index} className="agent-md-table-wrap scrollbar-thin">
              <table className="agent-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, cellIdx) => (
                      <th key={cellIdx}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIdx) => (
                    <tr key={rowIdx}>
                      {block.headers.map((_, cellIdx) => (
                        <td key={cellIdx}>{renderInline(row[cellIdx] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === 'code') {
          const canInsert = Boolean(onInsertCommand && isShellLikeCode(block.lang, block.code));
          const copied = copiedIndex === index;
          return (
            <div key={index} className="agent-md-code-block">
              <div className="agent-md-code-head">
                <span>{block.lang || 'code'}</span>
                <div className="flex items-center gap-1">
                  {canInsert && (
                    <button
                      type="button"
                      onClick={() => onInsertCommand?.(block.code.trim())}
                      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-accent"
                      title={insertLabel}
                    >
                      <CornerDownLeft className="h-3 w-3" />
                      <span>{insertLabel}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyCode(index, block.code)}
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
                    title={copied ? copiedLabel : copyLabel}
                  >
                    {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                    <span>{copied ? copiedLabel : copyLabel}</span>
                  </button>
                </div>
              </div>
              <pre className="agent-md-code-pre scrollbar-thin">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }
        return (
          <p key={index} className="agent-md-p">
            {block.lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
