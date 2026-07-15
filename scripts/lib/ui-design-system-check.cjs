/**
 * Structural contract for the shipped UI design system.
 * Reads real CSS + representative chrome components (no mocks of token values).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Extract a CSS block starting at the first match of selector (brace-balanced). */
function extractBlock(css, selectorRegex) {
  const match = css.match(selectorRegex);
  if (!match || match.index == null) {
    return null;
  }
  const start = match.index + match[0].length - 1; // at '{'
  if (css[start] !== '{') {
    return null;
  }
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(start + 1, i);
      }
    }
  }
  return null;
}

function assertIncludes(haystack, needles, label, failures) {
  for (const needle of needles) {
    if (!haystack.includes(needle)) {
      failures.push(`${label}: missing ${needle}`);
    }
  }
}

/**
 * Validate design tokens + shared classes + chrome consumers.
 * @returns {{ ok: boolean, failures: string[], notes: string[] }}
 */
function validateUiDesignSystem() {
  const failures = [];
  const notes = [];
  const css = read('src/renderer/index.css');

  const darkBlock = extractBlock(css, /:root,\s*\.dark\s*\{/);
  const lightBlock = extractBlock(css, /\.light\s*\{/);
  if (!darkBlock) failures.push('dark theme block (:root, .dark) not found');
  if (!lightBlock) failures.push('light theme block (.light) not found');

  const semanticTokens = [
    '--bg-primary',
    '--bg-secondary',
    '--border-color',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--accent-primary',
    '--success',
    '--warning',
    '--danger',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
  ];
  if (darkBlock) assertIncludes(darkBlock, semanticTokens, 'dark tokens', failures);
  if (lightBlock) {
    // light inherits radius from :root but must redefine colors
    assertIncludes(
      lightBlock,
      ['--bg-primary', '--accent-primary', '--success', '--warning', '--danger', '--text-primary'],
      'light tokens',
      failures,
    );
  }

  const sharedClasses = [
    '.app-shell',
    '.app-header',
    '.toolbar-button',
    '.toolbar-button-primary',
    '.icon-button',
    '.app-popover',
    '.workspace-tabbar',
    '.workspace-tab',
    '.workspace-empty',
    '.toast-host',
    '.toast-item',
    '.toast-item-success',
    '.toast-item-error',
    '.industrial-modal',
    '.industrial-input',
    '.industrial-card',
    '.industrial-button-primary',
    '.industrial-button-secondary',
    '.industrial-button-danger',
    '.modal-backdrop',
    '.settings-nav-item',
    '.connection-list-row',
    '.sftp-sidebar',
    '.terminal-toolbar',
  ];
  assertIncludes(css, sharedClasses, 'shared classes', failures);

  if (!css.includes('prefers-reduced-motion')) {
    failures.push('motion: prefers-reduced-motion media query missing');
  }
  assertIncludes(css, ['@keyframes ui-chrome-in', '@keyframes ui-toast-in', '@keyframes ui-fade-in'], 'motion keyframes', failures);

  const consumers = {
    'src/renderer/app/WorkspaceHeader.tsx': ['app-header', 'toolbar-button-primary', 'app-popover', 'connection-list-row'],
    'src/renderer/workspace/WorkspaceTabs.tsx': ['workspace-tabbar', 'workspace-tab', 'status-dot'],
    'src/renderer/workspace/WorkspaceEmptyState.tsx': ['workspace-empty', 'industrial-card'],
    'src/renderer/app/AppFooter.tsx': ['app-footer', 'text-success', 'text-warning', 'text-danger'],
    'src/renderer/app/ToastHost.tsx': ['toast-host', 'toast-item-success', 'toast-item-error'],
    'src/renderer/shared-ui/Modal.tsx': ['industrial-modal', 'modal-backdrop'],
    'src/renderer/components/ConfirmDialog.tsx': ['industrial-button-danger', 'industrial-button-primary', 'Modal'],
    'src/renderer/shared-ui/ConfirmDialog.tsx': ["from '../components/ConfirmDialog'"],
    'src/renderer/settings/SettingsPanel.tsx': ["from '../components/SettingsPanel'"],
    'src/renderer/components/SettingsPanel.tsx': ['settings-nav-item', 'industrial-modal', 'ui-toggle'],
    'src/renderer/components/CommandApproval.tsx': ['industrial-button-danger', 'industrial-card'],
    'src/renderer/components/HostTrustPrompt.tsx': ['industrial-modal-footer', 'industrial-button'],
    'src/renderer/transfer/SftpSidebar.tsx': ['sftp-sidebar'],
    'src/renderer/session/terminal/TerminalToolbar.tsx': ['terminal-toolbar', 'terminal-control'],
    'src/renderer/components/AgentPet.tsx': ['agent-pet', 'industrial-button-primary'],
  };

  for (const [rel, needles] of Object.entries(consumers)) {
    const src = read(rel);
    assertIncludes(src, needles, rel, failures);
  }

  notes.push(`css_bytes=${Buffer.byteLength(css, 'utf8')}`);
  notes.push(`consumer_files=${Object.keys(consumers).length}`);
  notes.push(`failures=${failures.length}`);

  return { ok: failures.length === 0, failures, notes };
}

module.exports = { validateUiDesignSystem, ROOT };
