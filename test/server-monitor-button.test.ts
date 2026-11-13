/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { ServerMonitorButton } from '../src/renderer/session/terminal/ServerMonitorButton';

const mocks = vi.hoisted(() => ({ loadConnections: vi.fn() }));

vi.mock('../src/renderer/store/useConnectionStore', () => ({
  useConnectionStore: (selector: (state: { connections: never[]; loadConnections: typeof mocks.loadConnections }) => unknown) =>
    selector({ connections: [], loadConnections: mocks.loadConnections }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
  mocks.loadConnections.mockClear();
});

describe('ServerMonitorButton popup', () => {
  it('renders its panel in the viewport layer instead of the clipped toolbar', async () => {
    const api = vi.fn().mockResolvedValue({ success: false, error: 'offline' });
    (window as unknown as { electronAPI: unknown }).electronAPI = { getServerMonitor: api };

    await act(async () => {
      root.render(createElement(ServerMonitorButton, {
        connectionId: 'connection-1',
        translate: (key: string) => key,
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-terminal-monitor-toggle]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger!.click();
    });

    const panel = document.body.querySelector<HTMLDivElement>('[data-terminal-monitor-panel]');
    expect(panel).not.toBeNull();
    expect(panel!.parentElement).toBe(document.body);
    expect(panel!.dataset.terminalToolbarPopup).toBe('true');
    expect(panel!.style.position).toBe('fixed');
    expect(panel!.style.width).toBe('340px');
    expect(panel!.style.visibility).toBe('visible');

    const close = panel!.querySelector<HTMLButtonElement>('button[title="common.close"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(document.body.querySelector('[data-terminal-monitor-panel]')).toBeNull();
  });
});
