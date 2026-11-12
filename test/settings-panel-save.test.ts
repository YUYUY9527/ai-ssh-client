/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SettingsPanel } from '../src/renderer/components/SettingsPanel';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { AppSettings } from '../src/shared/types';

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
  vi.restoreAllMocks();
});

function saveButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => (
    item.textContent?.trim() === '保存'
  ));
  if (!button) throw new Error('Save button not found');
  return button;
}

describe('SettingsPanel save behavior', () => {
  it('keeps the settings panel open after a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    await act(async () => {
      root.render(createElement(SettingsPanel, {
        settings: { ...DEFAULT_SETTINGS } as AppSettings,
        onSave,
        onClose,
      }));
    });

    await act(async () => {
      saveButton().click();
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('设置已保存。');
  });

  it('shows save failures and keeps the settings panel open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    const onClose = vi.fn();

    await act(async () => {
      root.render(createElement(SettingsPanel, {
        settings: { ...DEFAULT_SETTINGS } as AppSettings,
        onSave,
        onClose,
      }));
    });

    await act(async () => {
      saveButton().click();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('disk unavailable');
  });
});
