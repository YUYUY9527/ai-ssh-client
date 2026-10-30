import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { canSaveSftpDraft } from '../src/renderer/transfer/sftp-editor-save';

const base = { loaded: true, loading: false, saving: false, dirty: true, overLimit: false };

describe('canSaveSftpDraft', () => {
  it('允许保存：已加载、有改动、非加载/保存中、未超限', () => {
    expect(canSaveSftpDraft(base)).toBe(true);
  });

  it('读取失败（loaded=false）时禁止保存，即使 draft 有内容也不允许写回', () => {
    expect(canSaveSftpDraft({ ...base, loaded: false })).toBe(false);
    // 读取失败后 draft/original 会被清空，dirty=false；这里显式模拟“有内容”防止回归
    expect(canSaveSftpDraft({ ...base, loaded: false, dirty: true })).toBe(false);
  });

  it('加载中或保存中禁止保存', () => {
    expect(canSaveSftpDraft({ ...base, loading: true })).toBe(false);
    expect(canSaveSftpDraft({ ...base, saving: true })).toBe(false);
  });

  it('没有改动时禁止保存', () => {
    expect(canSaveSftpDraft({ ...base, dirty: false })).toBe(false);
  });

  it('超过体积上限时禁止保存', () => {
    expect(canSaveSftpDraft({ ...base, overLimit: true })).toBe(false);
  });
});

describe('SftpFileEditor 与保存条件接线', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/transfer/SftpFileEditor.tsx'),
    'utf8',
  );

  it('保存按钮与 handleSave 共用 canSave（快捷键经 handleSave 生效）', () => {
    // 按钮 disabled 直接由 canSave 决定
    expect(source).toContain('disabled={!canSave}');
    // handleSave 在 !canSave 时提前返回，Ctrl+S 调用 handleSave 因此同样被拦截
    expect(source).toMatch(/if \(!canSave \|\| !window\.electronAPI\?\.writeSftpTextFile\)/);
  });
});
