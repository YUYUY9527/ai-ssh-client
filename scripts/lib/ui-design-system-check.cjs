/**
 * Structural contract for the shipped UI design system.
 * Reads real CSS + representative chrome components (no mocks of token values),
 * and hard-fails on any drift away from the token system:
 *   - dark/light color tokens must be paired and complete
 *   - tailwind.config must expose the semantic palette and drop dead palettes
 *   - no Tailwind numbered palette classes in .tsx
 *   - no raw hex colors in .tsx (asset files excluded)
 *   - no bare numeric z-index in .tsx
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

/** Recursively collect files with the given extension under dir. */
function walk(dir, ext, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(p, ext, acc);
    } else if (entry.name.endsWith(ext)) {
      acc.push(p);
    }
  }
  return acc;
}

// Color tokens that MUST exist in both :root/.dark and .light (paired).
const COLOR_TOKENS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-hover',
  '--bg-elevated',
  '--bg-sunken',
  '--bg-inverse',
  '--border-color',
  '--border-subtle',
  '--border-strong',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-subtle',
  '--text-faint',
  '--text-inverse',
  '--accent-primary',
  '--accent-hover',
  '--accent-muted',
  '--accent-strong',
  '--accent-alt',
  '--accent-gradient-from',
  '--accent-gradient-to',
  '--success',
  '--success-muted',
  '--success-fg',
  '--warning',
  '--warning-muted',
  '--warning-fg',
  '--danger',
  '--danger-muted',
  '--danger-fg',
  '--info',
  '--info-muted',
  '--info-fg',
  '--overlay',
];

// Files allowed to contain raw hex / palette classes (brand assets & data, not theming).
const ASSET_ALLOWLIST = new Set([
  'src/renderer/session/terminal/terminal-theme.ts',
  'src/renderer/components/AppIcon.tsx',
  'src/renderer/components/FileTypeIcon.tsx',
  'src/renderer/components/QuickCommandsPanel.tsx',
]);

// Tailwind numbered palette utilities, e.g. text-slate-600, bg-red-500/10, border-teal-500.
const PALETTE_CLASS_RE =
  /\b(?:slate|zinc|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const BARE_Z_RE = /\bz-(?:\d+|\[\d+\])(?![\w-])/g;

/**
 * Validate design tokens + shared classes + chrome consumers + token-drift guard.
 * @returns {{ ok: boolean, failures: string[], notes: string[], violations: object[] }}
 */
function validateUiDesignSystem() {
  const failures = [];
  const notes = [];
  const violations = [];
  const css = read('src/renderer/index.css');

  const darkBlock = extractBlock(css, /:root,\s*\.dark\s*\{/);
  const lightBlock = extractBlock(css, /\.light\s*\{/);
  if (!darkBlock) failures.push('dark theme block (:root, .dark) not found');
  if (!lightBlock) failures.push('light theme block (.light) not found');

  // --- tokens: dark must have all color tokens + radius; light must mirror all color tokens ---
  if (darkBlock) {
    assertIncludes(darkBlock, COLOR_TOKENS, 'dark tokens', failures);
    assertIncludes(darkBlock, ['--radius-sm', '--radius-md', '--radius-lg'], 'dark radius', failures);
  }
  if (lightBlock) {
    assertIncludes(lightBlock, COLOR_TOKENS, 'light tokens', failures);
  }

  // --- tailwind config: semantic palette present, dead palettes removed ---
  const config = read('tailwind.config.js');
  for (const dead of ['primary', 'dark', 'light']) {
    const re = new RegExp(`(^|[\\s,{])${dead}\\s*:\\s*\\{`, 'm');
    if (re.test(config)) {
      failures.push(`tailwind.config: dead palette '${dead}' still defined (must be removed)`);
    }
  }
  assertIncludes(
    config,
    ['surface:', 'fg:', 'line:', 'accent:', 'danger:', 'zIndex:'],
    'tailwind semantic palette',
    failures,
  );

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

  // --- drift guard: scan every .tsx for palette classes / raw hex / bare z-index ---
  const tsxFiles = walk(path.join(ROOT, 'src/renderer'), '.tsx');
  for (const abs of tsxFiles) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (ASSET_ALLOWLIST.has(rel)) continue;
    const src = read(rel);
    const lines = src.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const pal = line.match(PALETTE_CLASS_RE);
      if (pal) {
        violations.push({ file: rel, line: idx + 1, kind: 'palette', match: pal[0] });
      }
      const hex = line.match(HEX_RE);
      if (hex) {
        violations.push({ file: rel, line: idx + 1, kind: 'hex', match: hex[0] });
      }
      const zs = line.match(BARE_Z_RE);
      if (zs) {
        for (const z of zs) violations.push({ file: rel, line: idx + 1, kind: 'zindex', match: z });
      }
    });
  }
  for (const v of violations) {
    failures.push(`${v.file}:${v.line} ${v.kind} '${v.match}' (use design tokens)`);
  }

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
    'src/renderer/settings/SettingsLayout.tsx': ['ui-toggle'],
    'src/renderer/components/SettingsPanel.tsx': ['settings-nav-item', 'industrial-modal', 'ToggleSwitch'],
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
  notes.push(`tsx_scanned=${tsxFiles.length}`);
  notes.push(`violations=${violations.length}`);
  notes.push(`failures=${failures.length}`);

  return { ok: failures.length === 0, failures, notes, violations };
}

module.exports = { validateUiDesignSystem, ROOT };
