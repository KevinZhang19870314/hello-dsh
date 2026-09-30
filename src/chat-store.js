/**
 * Conversation model for the web chat app.
 *
 * Deliberately free of I/O and HTTP so it can be unit tested directly:
 * persistence lives in `storage.js`, transport lives in `server.js`.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TITLE,
  MAX_PREVIEW_LENGTH,
  MAX_TITLE_LENGTH,
  deriveTitle,
  truncate,
} from './text-utils.js';

// Re-exported so existing importers of `chat-store.js` keep working; the
// implementations live in `text-utils.js` so the browser build can share them.
export { DEFAULT_TITLE, MAX_PREVIEW_LENGTH, MAX_TITLE_LENGTH, deriveTitle };

/** @typedef {'system' | 'user' | 'assistant'} Role */
/** @typedef {{ id: string, role: Role, content: string, createdAt: string }} Message */
/** @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, messages: Message[] }} Conversation */
/** @typedef {{ id: string, title: string, createdAt: string, updatedAt: string, messageCount: number, preview: string }} ConversationSummary */

const ROLES = new Set(['system', 'user', 'assistant']);

/** @param {unknown} value */
function asIsoString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** @returns {Error} */
function notFoundError(id) {
  return Object.assign(new Error(`找不到 id 为 ${id} 的对话`), { code: 'NOT_FOUND' });
}

/**
 * @param {Message} message
 * @returns {Message}
 */
function cloneMessage(message) {
  return { ...message };
}

/**
 * @param {Conversation} conversation
 * @returns {Conversation}
 */
function cloneConversation(conversation) {
  return { ...conversation, messages: conversation.messages.map(cloneMessage) };
}

export class ChatStore {
  /** @type {Conversation[]} */
  #conversations = [];
  /** @type {() => string} */
  #idFactory;
  /** @type {() => Date} */
  #now;

  /**
   * @param {object[]} [conversations] Conversations loaded from disk.
   * @param {{ idFactory?: () => string, now?: () => Date }} [options]
   */
  constructor(conversations = [], { idFactory = randomUUID, now = () => new Date() } = {}) {
    if (!Array.isArray(conversations)) {
      throw new TypeError('ChatStore 需要一个对话数组');
    }
    this.#idFactory = idFactory;
    this.#now = now;
    this.#conversations = conversations.map((raw, index) => this.#normalizeConversation(raw, index));
  }

  /** Number of conversations currently held. */
  get size() {
    return this.#conversations.length;
  }

  /**
   * Sidebar-friendly summaries, most recently updated first.
   * @returns {ConversationSummary[]}
   */
  list() {
    return this.#conversations
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
        preview: truncate(conversation.messages.at(-1)?.content ?? '', 64),
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /**
   * Start a new, empty conversation.
   * @param {string} [title]
   * @returns {Conversation}
   */
  create(title) {
    const timestamp = this.#now().toISOString();
    /** @type {Conversation} */
    const conversation = {
      id: this.#idFactory(),
      title: deriveTitle(title),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    this.#conversations.push(conversation);
    return cloneConversation(conversation);
  }

  /**
   * @param {string} id
   * @returns {Conversation} a copy, safe for callers to mutate
   */
  get(id) {
    return cloneConversation(this.#find(id));
  }

  /**
   * @param {string} id
   * @param {string} title
   * @returns {Conversation}
   */
  rename(id, title) {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new TypeError('对话标题不能为空');
    const conversation = this.#find(id);
    conversation.title = deriveTitle(clean);
    conversation.updatedAt = this.#now().toISOString();
    return cloneConversation(conversation);
  }

  /**
   * Drop a conversation and all of its messages.
   * @param {string} id
   * @returns {Conversation} the removed conversation
   */
  remove(id) {
    const conversation = this.#find(id);
    this.#conversations = this.#conversations.filter((candidate) => candidate.id !== conversation.id);
    return cloneConversation(conversation);
  }

  /**
   * Delete every conversation.
   * @returns {number} how many were removed
   */
  clear() {
    const removed = this.#conversations.length;
    this.#conversations = [];
    return removed;
  }

  /**
   * Append a message and, for the first user message, auto-title the conversation.
   * @param {string} id
   * @param {{ role: Role, content: string, createdAt?: string }} input
   * @returns {Message}
   */
  appendMessage(id, { role, content, createdAt } = {}) {
    if (!ROLES.has(role)) {
      throw new TypeError(`未知的消息角色 "${role}"`);
    }
    const text = typeof content === 'string' ? content : '';
    if (!text.trim()) {
      throw new TypeError('消息内容不能为空');
    }
    const conversation = this.#find(id);
    /** @type {Message} */
    const message = {
      id: this.#idFactory(),
      role,
      content: text,
      createdAt: asIsoString(createdAt) ?? this.#now().toISOString(),
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;

    const isFirstUserMessage =
      role === 'user' && conversation.messages.filter((item) => item.role === 'user').length === 1;
    if (isFirstUserMessage && conversation.title === DEFAULT_TITLE) {
      conversation.title = deriveTitle(text);
    }
    return cloneMessage(message);
  }

  /** Serialization hook used by `JSON.stringify` and `storage.save`. */
  toJSON() {
    return this.#conversations.map(cloneConversation);
  }

  /**
   * Coerce an untrusted object (e.g. from a hand-edited JSON file) into a Conversation.
   * @param {object} raw
   * @param {number} index
   * @returns {Conversation}
   */
  #normalizeConversation(raw, index) {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`对话 #${index + 1} 不是一个对象`);
    }
    const messages = Array.isArray(raw.messages)
      ? raw.messages.map((message, messageIndex) => this.#normalizeMessage(message, messageIndex, index))
      : [];
    const createdAt = asIsoString(raw.createdAt) ?? this.#now().toISOString();
    const lastMessage = messages.at(-1);
    return {
      id: asIsoString(raw.id) ?? this.#idFactory(),
      title: deriveTitle(raw.title, messages.length > 0 ? deriveTitle(messages.find((m) => m.role === 'user')?.content) : DEFAULT_TITLE),
      createdAt,
      updatedAt: asIsoString(raw.updatedAt) ?? lastMessage?.createdAt ?? createdAt,
      messages,
    };
  }

  /**
   * @param {object} raw
   * @param {number} messageIndex
   * @param {number} conversationIndex
   * @returns {Message}
   */
  #normalizeMessage(raw, messageIndex, conversationIndex) {
    if (!raw || typeof raw !== 'object' || !ROLES.has(raw.role)) {
      throw new TypeError(`对话 #${conversationIndex + 1} 的消息 #${messageIndex + 1} 缺少合法的 role`);
    }
    return {
      id: asIsoString(raw.id) ?? this.#idFactory(),
      role: raw.role,
      content: typeof raw.content === 'string' ? raw.content : '',
      createdAt: asIsoString(raw.createdAt) ?? this.#now().toISOString(),
    };
  }

  /**
   * @param {string} id
   * @returns {Conversation} the live object, so callers can mutate it in place
   */
  #find(id) {
    const conversation = this.#conversations.find((candidate) => candidate.id === String(id));
    if (!conversation) throw notFoundError(id);
    return conversation;
  }
}
