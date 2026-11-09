/**
 * @vitest-environment jsdom
 *
 * 文件列表搜索过滤：
 * 搜索只过滤当前目录的名称，不等同于切换目录；清空后恢复完整列表。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FileTransfer } from '../src/renderer/components/FileTransfer';
import { useSessionStore } from '../src/renderer/session/useSessionStore';
import { useSftpTransferStore } from '../src/renderer/store/useSftpTransferStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION_ID = 'conn-search';

const FILES = [
  {
    name: 'alpha.txt',
    path: '/root/alpha.txt',
    isDirectory: false,
    size: 12,
    mtime: 1_700_000_000_000,
    mode: '100644',
    fileType: 'file',
  },
  {
    name: 'beta.log',
    path: '/root/beta.log',
    isDirectory: false,
    size: 24,
    mtime: 1_700_000_000_000,
    mode: '100644',
    fileType: 'file',
  },
  {
    name: 'photos',
    path: '/root/photos',
    isDirectory: true,
    size: 0,
    mtime: 1_700_000_000_000,
    mode: '040755',
    fileType: 'directory',
  },
];

let container: HTMLDivElement;
let root: Root;

function renderFileTransfer() {
  act(() => {
    root.render(createElement(FileTransfer, { connectionId: CONNECTION_ID, isLive: true }));
  });
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  useSessionStore.setState({ sessions: {} } as never);
  useSftpTransferStore.setState({ browserByConnection: {}, tasks: [] } as never);

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onSftpTransferEvent: () => () => undefined,
    listSftpTransfers: async () => ({ success: true, data: { tasks: [] } }),
    listDirectory: async (_connectionId: string, path: string) => ({
      success: true,
      data: { path, files: FILES },
    }),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderFileTransfer();
  await flushAsync();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FileTransfer — 文件列表搜索', () => {
  it('按名称过滤当前目录，清空后恢复', async () => {
    expect(container.textContent).toContain('alpha.txt');
    expect(container.textContent).toContain('beta.log');
    expect(container.textContent).toContain('photos');

    const searchButton = container.querySelector<HTMLButtonElement>('button[title="搜索文件"]');
    expect(searchButton).not.toBeNull();
    act(() => {
      searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[placeholder="搜索当前目录..."]');
    expect(input).not.toBeNull();

    setInputValue(input!, 'beta');
    await flushAsync();

    expect(container.textContent).toContain('beta.log');
    expect(container.textContent).not.toContain('alpha.txt');
    expect(container.textContent).not.toContain('photos');
    expect(container.textContent).toContain('1/3');

    setInputValue(input!, '');
    await flushAsync();

    expect(container.textContent).toContain('alpha.txt');
    expect(container.textContent).toContain('photos');
  });

  it('没有匹配项时显示空提示', async () => {
    const searchButton = container.querySelector<HTMLButtonElement>('button[title="搜索文件"]');
    act(() => {
      searchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[placeholder="搜索当前目录..."]');

    setInputValue(input!, 'not-found');
    await flushAsync();

    expect(container.textContent).toContain('没有匹配的文件');
    expect(container.textContent).not.toContain('alpha.txt');
  });
});
