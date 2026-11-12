import { describe, expect, it } from 'vitest';

import { openaiContent, anthropicContent } from '../server/ai-providers/multimodal.cjs';

const png = { name: 'a.png', type: 'image/png', dataBase64: 'QUJD' };

describe('多模态内容转换', () => {
  it('openai 把图片转 data URL，文本在前', () => {
    const content = openaiContent('看看这张图', [png]);
    expect(content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('anthropic 把图片转 base64 source', () => {
    const content = anthropicContent('看图', [png]);
    expect(content[0]).toEqual({ type: 'text', text: '看图' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });

  it('纯文本附件内联为文本块', () => {
    const text = { type: 'text/plain', dataBase64: Buffer.from('日志内容').toString('base64') };
    const content = anthropicContent('', [text]);
    expect(content).toEqual([{ type: 'text', text: '日志内容' }]);
  });

  it('不支持的 PDF 给出占位说明而不是静默丢弃', () => {
    const content = openaiContent('', [{ name: 'doc.pdf', type: 'application/pdf', dataBase64: 'QUJD' }]);
    expect(content).toHaveLength(1);
    expect((content[0] as { text: string }).text).toContain('doc.pdf');
  });
});
