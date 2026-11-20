import { describe, expect, it } from 'vitest';
import {
  buildVimSafePasteSequence,
  looksLikeVimScreen,
  normalizeVimPasteText,
} from '../src/renderer/session/terminal/vim-paste';

describe('vim-paste', () => {
  it('规范多行文本：CRLF/CR 统一为 LF，并剔除 bracketed 结束标记', () => {
    expect(normalizeVimPasteText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeVimPasteText('a\x1b[201~b')).toBe('ab');
  });

  it('生成安全粘贴序列：ESC → :set paste → i → 文本 → ESC → :set nopaste → i', () => {
    expect(buildVimSafePasteSequence('# a\r\n# b')).toBe(
      '\x1b:set paste\ri# a\n# b\x1b:set nopaste\ri',
    );
  });

  it('模式行即可确认是 Vim', () => {
    expect(looksLikeVimScreen(['~', '~', '-- INSERT --'])).toBe(true);
    expect(looksLikeVimScreen(['foo', '-- VISUAL --'])).toBe(true);
  });

  it('标尺行需要配合空行标记 ~ 才判定为 Vim', () => {
    expect(looksLikeVimScreen(['"x.txt" 3L, 20B', '~', '~'])).toBe(true);
    expect(looksLikeVimScreen(['1,1           All', '~'])).toBe(true);
    expect(looksLikeVimScreen(['"x.txt" 3L, 20B'])).toBe(false);
  });

  it('普通 shell / less 屏幕不会被误判为 Vim', () => {
    expect(looksLikeVimScreen(['root@host:~# ls', 'a.txt  b.txt', 'root@host:~#'])).toBe(false);
    expect(looksLikeVimScreen(['total 2', '-rw-r--r-- a.txt', 'file (END)', '~'])).toBe(false);
  });
});
