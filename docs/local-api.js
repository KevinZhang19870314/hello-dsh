/**
 * Browser-side stand-in for `src/server.js`.
 *
 * GitHub Pages can only serve static files, so the real Node/JSON/SSE API is
 * replaced by this module: it patches `window.fetch` for `/api/**` and answers
 * from `localStorage` using the exact same reply engine the server uses for its
 * offline mode (`src/local-replies.js`).
 *
 * `public/app.js` is therefore completely unchanged — it still speaks REST +
 * SSE, it just never reaches the network.
 */

import { DEFAULT_TITLE, deriveTitle, truncate } from './text-utils.js';
import { streamLocalReply } from './local-replies.js';

export const STORAGE_KEY = 'hello-dsh:conversations:v1';
const CHUNK_DELAY_MS = 12;
const FALLBACK_REPLY = '（模型没有返回任何内容）';

/** What the sidebar badge says when the app runs as a static site. */
export const STATIC_BADGE = {
  mode: 'local',
  label: '静态演示模式（GitHub Pages）',
  hint: '纯前端演示：对话保存在浏览器 localStorage，回复由内置规则生成；本地运行 npm start 可接入 DeepSeek API',
};

/* ------------------------------------------------------------------ helpers */

/** @param {unknown} value */
function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** @param {number} status @param {unknown} payload */
function jsonResponse(status, payload) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {unknown} body */
function parseBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof body === 'object' ? body : {};
}

/** @returns {() => string} */
function defaultIdFactory() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return () => cryptoApi.randomUUID();
  }
  return () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `localStorage` throws in private-mode / sandboxed iframes, and is missing in
 * Node. Degrade to an in-memory store so the UI always works.
 * @returns {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>}
 */
export function safeStorage() {
  try {
    const candidate = globalThis.localStorage;
    const probe = '__hello_dsh_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    /** @type {Map<string, string>} */
    const memory = new Map();
    return {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => void memory.set(key, String(value)),
      removeItem: (key) => void memory.delete(key),
    };
  }
}

/** @param {string} id */
function notFoundError(id) {
  return Object.assign(new Error(`找不到 id 为 ${id} 的对话`), { code: 'NOT_FOUND' });
}

/** @param {any} error */
function statusFor(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error?.code === 'NOT_FOUND') return 404;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

/* --------------------------------------------------------------- the "API" */

/**
 * Build the request handler. Kept free of `window` so it can be unit tested in
 * Node against a fake storage object.
 *
 * @param {{
 *   storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
 *   now?: () => Date,
 *   idFactory?: () => string,
 *   chunkDelayMs?: number,
 * }} [options]
 * @returns {(pathname: string, init?: RequestInit) => Promise<Response | null>}
 *   Resolves to `null` when the path is not an `/api/**` route, which tells the
 *   caller to fall through to the real network.
 */
export function createLocalApi({
  storage = safeStorage(),
  now = () => new Date(),
  idFactory = defaultIdFactory(),
  chunkDelayMs = CHUNK_DELAY_MS,
} = {}) {
  /** @type {{ id: string, title: string, createdAt: string, updatedAt: string, messages: any[] }[]} */
  let conversations = load();

  /* ------------------------------------------------------------ the model */

  /** @param {string} iso */
  function isIso(iso) {
    return typeof iso === 'string' && iso.trim() ? iso : null;
  }

  /** @param {any} raw */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const roles = new Set(['system', 'user', 'assistant']);
    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((message) => message && typeof message === 'object' && roles.has(message.role))
      .map((message) => ({
        id: isIso(message.id) ?? idFactory(),
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
        createdAt: isIso(message.createdAt) ?? now().toISOString(),
      }));
    const createdAt = isIso(raw.createdAt) ?? now().toISOString();
    const firstUserMessage = messages.find((message) => message.role === 'user');
    return {
      id: isIso(raw.id) ?? idFactory(),
      title: deriveTitle(
        raw.title,
        messages.length > 0 ? deriveTitle(firstUserMessage?.content) : DEFAULT_TITLE,
      ),
      createdAt,
      updatedAt: isIso(raw.updatedAt) ?? messages.at(-1)?.createdAt ?? createdAt,
      messages,
    };
  }

  function load() {
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.conversations)
          ? parsed.conversations
          : [];
      return items.map(normalize).filter(Boolean);
    } catch {
      return [];
    }
  }

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      /* quota exceeded or storage disabled — the session still works in memory */
    }
  }

  /** Sidebar summaries, most recently updated first. */
  function list() {
    return conversations
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

  /** @param {string} id */
  function find(id) {
    const conversation = conversations.find((candidate) => candidate.id === String(id));
    if (!conversation) throw notFoundError(id);
    return conversation;
  }

  /** @param {string} id */
  function get(id) {
    return clone(find(id));
  }

  /** @param {string} [title] */
  function create(title) {
    const timestamp = now().toISOString();
    const conversation = {
      id: idFactory(),
      title: deriveTitle(title),
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    conversations.push(conversation);
    persist();
    return clone(conversation);
  }

  /** @param {string} id @param {string} title */
  function rename(id, title) {
    const clean = String(title ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) throw new TypeError('对话标题不能为空');
    const conversation = find(id);
    conversation.title = deriveTitle(clean);
    conversation.updatedAt = now().toISOString();
    persist();
    return clone(conversation);
  }

  /** @param {string} id */
  function remove(id) {
    const conversation = find(id);
    conversations = conversations.filter((candidate) => candidate.id !== conversation.id);
    persist();
    return clone(conversation);
  }

  function clear() {
    const removed = conversations.length;
    conversations = [];
    persist();
    return removed;
  }

  /** @param {string} id @param {{ role: string, content: string }} input */
  function appendMessage(id, { role, content } = /** @type {any} */ ({})) {
    const roles = new Set(['system', 'user', 'assistant']);
    if (!roles.has(role)) throw new TypeError(`未知的消息角色 "${role}"`);
    const text = typeof content === 'string' ? content : '';
    if (!text.trim()) throw new TypeError('消息内容不能为空');

    const conversation = find(id);
    const message = { id: idFactory(), role, content: text, createdAt: now().toISOString() };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;

    const isFirstUserMessage =
      role === 'user' && conversation.messages.filter((item) => item.role === 'user').length === 1;
    if (isFirstUserMessage && conversation.title === DEFAULT_TITLE) {
      conversation.title = deriveTitle(text);
    }
    persist();
    return clone(message);
  }

  /* ----------------------------------------------------------- the routing */

  /**
   * Stream the offline reply as server-sent events, mirroring the frame order of
   * `src/server.js`: `start` → `delta`* → `done`.
   * @param {string} id
   * @param {any} userMessage
   */
  function eventStream(id, userMessage) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let open = true;
        /** @param {object} event */
        const send = (event) => {
          if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        send({ type: 'start', userMessage, conversation: get(id) });

        let text = '';
        try {
          for await (const delta of streamLocalReply(get(id).messages, chunkDelayMs)) {
            text += delta;
            send({ type: 'delta', text: delta });
          }
        } catch (error) {
          send({ type: 'error', message: error.message });
        }

        try {
          const assistantMessage = appendMessage(id, {
            role: 'assistant',
            content: text.trim() || FALLBACK_REPLY,
          });
          send({
            type: 'done',
            assistantMessage,
            conversation: get(id),
            conversations: list(),
          });
        } catch (error) {
          send({ type: 'error', message: error.message });
        }

        open = false;
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      },
    });
  }

  /**
   * @param {string} pathname
   * @param {RequestInit} [init]
   * @returns {Promise<Response | null>}
   */
  return async function handle(pathname, init = {}) {
    const match = /\/api(?:\/(.*))?$/.exec(pathname);
    if (!match) return null;

    const segments = (match[1] ?? '').split('/').filter(Boolean);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = parseBody(init.body);
    const [resource, id, action] = segments;

    try {
      if (resource === 'health') {
        if (method !== 'GET') return jsonResponse(405, { error: `不支持的方法 ${method}` });
        return jsonResponse(200, {
          ok: true,
          assistant: STATIC_BADGE,
          conversations: conversations.length,
          dataFile: '浏览器 localStorage（静态演示）',
        });
      }

      if (resource !== 'conversations') {
        return jsonResponse(404, { error: `未知接口 ${pathname}` });
      }

      if (!id) {
        if (method === 'GET') return jsonResponse(200, { conversations: list() });
        if (method === 'POST') {
          const conversation = create(typeof body.title === 'string' ? body.title : undefined);
          return jsonResponse(201, { conversation, conversations: list() });
        }
        if (method === 'DELETE') return jsonResponse(200, { removed: clear(), conversations: [] });
        return jsonResponse(405, { error: `不支持的方法 ${method}` });
      }

      if (action === 'messages') {
        if (method !== 'POST') return jsonResponse(405, { error: `不支持的方法 ${method}` });
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) return jsonResponse(400, { error: '消息内容不能为空' });

        const userMessage = appendMessage(id, { role: 'user', content });
        if (body.stream === false) {
          let text = '';
          for await (const delta of streamLocalReply(get(id).messages, chunkDelayMs)) text += delta;
          const assistantMessage = appendMessage(id, {
            role: 'assistant',
            content: text.trim() || FALLBACK_REPLY,
          });
          return jsonResponse(200, {
            userMessage,
            assistantMessage,
            conversation: get(id),
            conversations: list(),
          });
        }
        return eventStream(id, userMessage);
      }

      if (action) return jsonResponse(404, { error: `未知接口 ${pathname}` });

      if (method === 'GET') return jsonResponse(200, { conversation: get(id) });
      if (method === 'PATCH') {
        const conversation = rename(id, body.title);
        return jsonResponse(200, { conversation, conversations: list() });
      }
      if (method === 'DELETE') {
        const conversation = remove(id);
        return jsonResponse(200, { conversation, conversations: list() });
      }
      return jsonResponse(405, { error: `不支持的方法 ${method}` });
    } catch (error) {
      return jsonResponse(statusFor(error), { error: error?.message ?? '内部错误' });
    }
  };
}

/**
 * Patch `globalThis.fetch` so `/api/**` never leaves the browser.
 * @param {Parameters<typeof createLocalApi>[0]} [options]
 * @returns {() => void} restore function
 */
export function installLocalApi(options) {
  const handle = createLocalApi(options);
  const original = globalThis.fetch;
  const base = globalThis.location?.href ?? 'http://localhost/';

  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
    let pathname;
    try {
      pathname = new URL(raw, base).pathname;
    } catch {
      pathname = raw;
    }

    const response = await handle(pathname, init);
    if (response) return response;

    if (typeof original !== 'function') {
      throw new Error(`离线演示模式下无法访问 ${raw}`);
    }
    return original.call(globalThis, input, init);
  };

  return () => {
    globalThis.fetch = original;
  };
}

// Auto-install in a real browser; Node (tests, tooling) imports the factories.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installLocalApi();
}
