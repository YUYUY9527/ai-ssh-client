'use strict';

/**
 * 多模态消息内容转换：把「文本 + 附件」转成各 provider 需要的 content 结构。
 * 附件对象需含 { type: mime, dataBase64 }。
 */

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((item) => item && typeof item.type === 'string' && typeof item.dataBase64 === 'string');
}

/** OpenAI / OpenAI 兼容 / Gemini(OpenAI 兼容层)：image_url + data URL。 */
function openaiContent(text, attachments) {
  const items = normalizeAttachments(attachments);
  if (items.length === 0) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${item.type};base64,${item.dataBase64}` } });
    } else if (item.type === 'text/plain') {
      parts.push({ type: 'text', text: Buffer.from(item.dataBase64, 'base64').toString('utf8') });
    } else {
      // PDF 等暂不支持直接入模，以文字占位说明，避免静默丢弃。
      parts.push({ type: 'text', text: `[附件 ${item.name || ''} (${item.type}) 未能直接解析]` });
    }
  }
  return parts;
}

/** Anthropic：image source base64 / document 仅图片与文本。 */
function anthropicContent(text, attachments) {
  const items = normalizeAttachments(attachments);
  if (items.length === 0) return [{ type: 'text', text: text || '' }];
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const item of items) {
    if (item.type === 'image/png' || item.type === 'image/jpeg' || item.type === 'image/webp' || item.type === 'image/gif') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: item.type, data: item.dataBase64 },
      });
    } else if (item.type === 'text/plain') {
      blocks.push({ type: 'text', text: Buffer.from(item.dataBase64, 'base64').toString('utf8') });
    } else {
      blocks.push({ type: 'text', text: `[附件 ${item.name || ''} (${item.type}) 未能直接解析]` });
    }
  }
  return blocks;
}

module.exports = { openaiContent, anthropicContent, normalizeAttachments };
