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
    expect(panel!.style.width).toBe('400px');
    expect(panel!.style.visibility).toBe('visible');

    const close = panel!.querySelector<HTMLButtonElement>('button[title="common.close"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(document.body.querySelector('[data-terminal-monitor-panel]')).toBeNull();
  });

  it('shows at most ten CPU processes and expands network interfaces on demand', async () => {
    const api = vi.fn().mockResolvedValue({
      success: true,
      data: {
        cpuPercent: 35,
        cpuCores: [35],
        coreCount: 1,
        memory: { totalKb: 1024, availableKb: 512, usedKb: 512, percent: 50 },
        load: { load1: 0.5, load5: 0.4, load15: 0.3 },
        uptimeSeconds: 3600,
        disk: { totalKb: 1024, usedKb: 512, availableKb: 512, percent: 50 },
        processCpu: Array.from({ length: 12 }, (_, index) => ({
          pid: 100 + index,
          name: `process-${index}`,
          percent: 12 - index,
        })),
        network: Array.from({ length: 7 }, (_, index) => ({
          name: `eth${index}`,
          rxBytesPerSec: (7 - index) * 1024,
          txBytesPerSec: 0,
        })),
        hostname: 'test-host',
        os: 'Linux',
      },
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = { getServerMonitor: api };

    await act(async () => {
      root.render(createElement(ServerMonitorButton, {
        connectionId: 'connection-1',
        translate: (key: string, params?: Record<string, string | number>) =>
          key === 'features.monitor.showAllInterfaces' ? `All interfaces (${params?.count})` : key,
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-terminal-monitor-toggle]');
    await act(async () => trigger!.click());

    const panel = document.body.querySelector<HTMLDivElement>('[data-terminal-monitor-panel]')!;
    expect(panel.textContent).toContain('process-0');
    expect(panel.textContent).toContain('process-9');
    expect(panel.textContent).not.toContain('process-10');
    expect(panel.textContent).toContain('eth0');
    expect(panel.textContent).toContain('eth4');
    expect(panel.textContent).not.toContain('eth5');

    const expand = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent?.includes('All interfaces (7)'));
    expect(expand).not.toBeUndefined();
    await act(async () => expand!.click());

    expect(panel.textContent).toContain('eth6');
    expect(panel.textContent).toContain('eth5');
  });
});
