'use strict';

/**
 * Agent 会话持久化（按 clientId + connectionId）。
 *
 * 设计要点：
 * - 只持久化对话消息与附件元数据，不落任何凭据/终端原始输出之外的敏感信息。
 * - 附件仅存元数据（名称/类型/大小/临时文件 id），真实字节由 agent-attachments 管。
 * - 加载时把悬空的工具调用（status=pending）标记为 cancelled，避免恢复后永远等待。
 */

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_CONTENT_CHARS = 200000;

function conversationKey(clientId, connectionId) {
  return `${clientId || 'local'}::${connectionId || 'default'}`;
}

function sanitizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const name = typeof attachment.name === 'string' ? attachment.name : '';
  const type = typeof attachment.type === 'string' ? attachment.type : 'application/octet-stream';
  const size = Number.isFinite(attachment.size) ? Math.max(0, Math.trunc(attachment.size)) : 0;
  const id = typeof attachment.id === 'string' ? attachment.id : '';
  if (!id) return null;
  return { id, name, type, size };
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
  let content = typeof message.content === 'string' ? message.content : '';
  if (content.length > MAX_CONTENT_CHARS) content = content.slice(0, MAX_CONTENT_CHARS);
  const result = {
    id: typeof message.id === 'string' ? message.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
  };
  if (Array.isArray(message.attachments)) {
    const attachments = message.attachments.map(sanitizeAttachment).filter(Boolean);
    if (attachments.length) result.attachments = attachments;
  }
  if (Array.isArray(message.toolCalls)) {
    result.toolCalls = message.toolCalls
      .filter((call) => call && typeof call === 'object')
      .map((call) => ({
        id: typeof call.id === 'string' ? call.id : '',
        name: typeof call.name === 'string' ? call.name : '',
        arguments: typeof call.arguments === 'string' ? call.arguments : '',
        status: call.status === 'completed' || call.status === 'cancelled' ? call.status : 'pending',
      }))
      .filter((call) => call.id && call.name);
  }
  return result;
}

/** 把悬空工具调用标记为 cancelled（历史遗留 pending）。 */
function cancelDanglingToolCalls(conversation) {
  let changed = false;
  for (const message of conversation.messages) {
    if (!Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      if (call.status === 'pending') {
        call.status = 'cancelled';
        changed = true;
      }
    }
  }
  return changed;
}

function createAgentConversationStore({ dataDir, fileName = 'agent-conversations.json' } = {}) {
  const directory = dataDir || path.join(__dirname, '..', 'data');
  const storePath = path.join(directory, fileName);
  let state = null;
  let writeTimer = null;

  function load() {
    if (state) return state;
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        version: STORE_VERSION,
        conversations: parsed && typeof parsed.conversations === 'object' && parsed.conversations ? parsed.conversations : {},
      };
    } catch {
      state = { version: STORE_VERSION, conversations: {} };
    }
    return state;
  }

  function persistNow() {
    if (!state) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const temporary = `${storePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state));
      fs.renameSync(temporary, storePath);
    } catch {
      // 持久化失败不打断主流程；下次写入重试。
    }
  }

  function schedulePersist() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      persistNow();
    }, 400);
    writeTimer.unref?.();
  }

  function list(clientId) {
    const data = load();
    const summaries = [];
    for (const [key, conversation] of Object.entries(data.conversations)) {
      if (clientId && conversation.clientId !== clientId) continue;
      summaries.push({
        key,
        connectionId: conversation.connectionId,
        messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
        updatedAt: conversation.updatedAt || 0,
      });
    }
    summaries.sort((left, right) => right.updatedAt - left.updatedAt);
    return summaries;
  }

  function get(clientId, connectionId) {
    const data = load();
    const key = conversationKey(clientId, connectionId);
    let conversation = data.conversations[key];
    if (!conversation) {
      conversation = { clientId, connectionId, messages: [], updatedAt: 0 };
      data.conversations[key] = conversation;
    }
    if (cancelDanglingToolCalls(conversation)) schedulePersist();
    return {
      connectionId,
      messages: conversation.messages,
      updatedAt: conversation.updatedAt || 0,
    };
  }

  function save(clientId, connectionId, { messages } = {}) {
    const data = load();
    const key = conversationKey(clientId, connectionId);
    const sanitized = (Array.isArray(messages) ? messages : [])
      .map(sanitizeMessage)
      .filter(Boolean)
      .slice(-MAX_MESSAGES_PER_CONVERSATION);
    const conversation = {
      clientId,
      connectionId,
      messages: sanitized,
      updatedAt: Date.now(),
    };
    cancelDanglingToolCalls(conversation);
    data.conversations[key] = conversation;
    persistNow();
    return { connectionId, messages: conversation.messages, updatedAt: conversation.updatedAt };
  }

  function remove(clientId, connectionId) {
    const data = load();
    const key = conversationKey(clientId, connectionId);
    const existed = Boolean(data.conversations[key]);
    delete data.conversations[key];
    persistNow();
    return existed;
  }

  return { list, get, save, remove, flush: persistNow, cancelDanglingToolCalls, sanitizeMessage, conversationKey };
}

module.exports = { createAgentConversationStore, sanitizeMessage, cancelDanglingToolCalls, conversationKey };
