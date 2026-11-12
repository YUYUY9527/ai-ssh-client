/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TerminalToolbar } from '../src/renderer/session/terminal/TerminalToolbar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/renderer/session/terminal/ServerMonitorButton', () => ({
  ServerMonitorButton: () => createElement('button', { type: 'button', 'data-testid': 'monitor' }),
}));
vi.mock('../src/renderer/session/terminal/PortForwardButton', () => ({
  PortForwardButton: () => createElement('button', { type: 'button', 'data-testid': 'port-forward' }),
}));
vi.mock('../src/renderer/session/terminal/BroadcastButton', () => ({
  BroadcastButton: () => createElement('button', { type: 'button', 'data-testid': 'broadcast' }),
}));
vi.mock('../src/renderer/session/terminal/DockerButton', () => ({
  DockerButton: () => createElement('button', { type: 'button', 'data-testid': 'docker' }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderToolbar() {
  root.render(createElement(TerminalToolbar, {
    fontSize: 14,
    isSearchOpen: false,
    terminalTheme: 'dark',
    themeNames: { dark: 'Dark' },
    themes: { dark: { background: '#000' } },
    translate: (key: string) => key,
    isThemeSelectorOpen: false,
    canInsertAgentPrefix: true,
    connectionId: 'connection-1',
    onDecreaseFontSize: vi.fn(),
    onInsertAgentPrefix: vi.fn(),
    onIncreaseFontSize: vi.fn(),
    onToggleSearch: vi.fn(),
    onToggleThemeSelector: vi.fn(),
    onSelectTheme: vi.fn(),
    onSaveLog: vi.fn(),
  }));
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.terminal-toolbar-trigger');
  if (!button) throw new Error('Terminal toolbar trigger not found');
  return button;
}

describe('TerminalToolbar compact menu', () => {
  it('opens the toolbar controls and closes on Escape', async () => {
    await act(async () => renderToolbar());

    await act(async () => trigger().click());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-terminal-save-log]')).not.toBeNull();
    expect(container.querySelector('[data-testid="docker"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('closes when the user clicks outside the toolbar', async () => {
    await act(async () => renderToolbar());
    await act(async () => trigger().click());

    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});
