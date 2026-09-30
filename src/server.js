/**
 * Dependency-free HTTP server for the chat app.
 *
 * Serves the static UI in `public/` and a small JSON API:
 *
 *   GET    /api/health                          server + assistant mode
 *   GET    /api/conversations                   sidebar summaries
 *   POST   /api/conversations                   create a conversation
 *   DELETE /api/conversations                   delete every conversation
 *   GET    /api/conversations/:id               one conversation with messages
 *   PATCH  /api/conversations/:id               rename
 *   DELETE /api/conversations/:id               delete one conversation
 *   POST   /api/conversations/:id/messages      append a message and stream a reply
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { ChatStore } from './chat-store.js';
import { dataFilePath, load, save } from './storage.js';
import { assistantBadge, buildModelMessages, streamReply } from './assistant.js';

export const DEFAULT_PORT = 3210;
export const DEFAULT_HOST = '127.0.0.1';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY_BYTES = 1_000_000;
const FALLBACK_REPLY = '（模型没有返回任何内容）';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {http.IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw Object.assign(new Error('请求体必须是合法 JSON'), { statusCode: 400, cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * Map a thrown error to an HTTP status code.
 * @param {any} error
 * @returns {number}
 */
function statusFor(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error?.code === 'NOT_FOUND') return 404;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

/**
 * @param {object} context
 * @param {http.IncomingMessage} context.req
 * @param {http.ServerResponse} context.res
 * @param {URL} context.url
 * @param {ChatStore} context.store
 */
async function handleApi({ req, res, url, store }) {
  const [, resource, id, action] = url.pathname.split('/').filter(Boolean);
  const method = (req.method ?? 'GET').toUpperCase();

  if (resource === 'health') {
    if (method !== 'GET') return sendJson(res, 405, { error: `不支持的方法 ${method}` });
    return sendJson(res, 200, {
      ok: true,
      assistant: assistantBadge(),
      conversations: store.size,
      dataFile: dataFilePath(),
    });
  }

  if (resource !== 'conversations') {
    return sendJson(res, 404, { error: `未知接口 ${url.pathname}` });
  }

  if (!id) {
    if (method === 'GET') return sendJson(res, 200, { conversations: store.list() });

    if (method === 'POST') {
      const body = await readJson(req);
      const title = typeof body.title === 'string' ? body.title : undefined;
      const conversation = store.create(title);
      await save(store);
      return sendJson(res, 201, { conversation, conversations: store.list() });
    }

    if (method === 'DELETE') {
      const removed = store.clear();
      await save(store);
      return sendJson(res, 200, { removed, conversations: [] });
    }

    return sendJson(res, 405, { error: `不支持的方法 ${method}` });
  }

  if (action === 'messages') {
    if (method !== 'POST') return sendJson(res, 405, { error: `不支持的方法 ${method}` });
    return handleMessage({ req, res, store, id });
  }
  if (action) return sendJson(res, 404, { error: `未知接口 ${url.pathname}` });

  if (method === 'GET') {
    return sendJson(res, 200, { conversation: store.get(id) });
  }
  if (method === 'PATCH') {
    const body = await readJson(req);
    const conversation = store.rename(id, body.title);
    await save(store);
    return sendJson(res, 200, { conversation, conversations: store.list() });
  }
  if (method === 'DELETE') {
    const conversation = store.remove(id);
    await save(store);
    return sendJson(res, 200, { conversation, conversations: store.list() });
  }
  return sendJson(res, 405, { error: `不支持的方法 ${method}` });
}

/**
 * Append the user message, then reply either as JSON (`stream: false`) or as
 * server-sent events so the browser can render the answer while it is written.
 * @param {{ req: http.IncomingMessage, res: http.ServerResponse, store: ChatStore, id: string }} context
 */
async function handleMessage({ req, res, store, id }) {
  const body = await readJson(req);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return sendJson(res, 400, { error: '消息内容不能为空' });
  }

  const userMessage = store.appendMessage(id, { role: 'user', content });
  await save(store);
  const messages = buildModelMessages(store.get(id));

  if (body.stream === false) {
    let text = '';
    for await (const delta of streamReply(messages)) text += delta;
    const assistantMessage = store.appendMessage(id, { role: 'assistant', content: text.trim() || FALLBACK_REPLY });
    await save(store);
    return sendJson(res, 200, {
      userMessage,
      assistantMessage,
      conversation: store.get(id),
      conversations: store.list(),
    });
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  /** @param {object} event */
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({ type: 'start', userMessage, conversation: store.get(id) });

  let text = '';
  try {
    for await (const delta of streamReply(messages, { signal: controller.signal })) {
      text += delta;
      send({ type: 'delta', text: delta });
    }
  } catch (error) {
    if (error?.name !== 'AbortError') send({ type: 'error', message: error.message });
  }
  res.off('close', abort);

  try {
    const assistantMessage = store.appendMessage(id, {
      role: 'assistant',
      content: text.trim() || FALLBACK_REPLY,
    });
    await save(store);
    send({
      type: 'done',
      assistantMessage,
      conversation: store.get(id),
      conversations: store.list(),
    });
  } catch (error) {
    send({ type: 'error', message: error.message });
  }
  res.end();
}

/**
 * @param {{ req: http.IncomingMessage, res: http.ServerResponse, url: URL, publicDir: string }} context
 */
async function serveStatic({ req, res, url, publicDir }) {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { error: `不支持的方法 ${method}` });
  }

  let relative;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(res, 400, { error: '非法的请求路径' });
  }
  if (relative.endsWith('/')) relative += 'index.html';
  if (!relative) relative = 'index.html';

  let target = resolve(publicDir, relative);
  if (target !== publicDir && !target.startsWith(`${publicDir}${sep}`)) {
    return sendJson(res, 403, { error: '禁止访问该路径' });
  }

  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) target = join(target, 'index.html');

  const body = await readFile(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!body) {
    return sendJson(res, 404, { error: `未找到 ${url.pathname}` });
  }

  res.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(target).toLowerCase()) ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * @param {{ store: ChatStore, publicDir?: string }} options
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
export function createRequestHandler({ store, publicDir = PUBLIC_DIR }) {
  if (!store) throw new TypeError('createRequestHandler 需要一个 store');
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi({ req, res, url, store });
        return;
      }
      await serveStatic({ req, res, url, publicDir });
    } catch (error) {
      const status = statusFor(error);
      if (status === 500) console.error('[hello-dsh] 请求处理失败:', error);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: error?.message ?? '服务器内部错误' });
    }
  };
}

/**
 * Load the persisted history, then listen.
 * @param {{ port?: number, host?: string, store?: ChatStore, publicDir?: string }} [options]
 * @returns {Promise<{ server: http.Server, store: ChatStore, url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, store, publicDir } = {}) {
  const chatStore = store ?? new ChatStore(await load());
  const server = http.createServer(createRequestHandler({ store: chatStore, publicDir }));

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.off('error', rejectPromise);
      resolvePromise(undefined);
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    server,
    store: chatStore,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise(undefined))),
  };
}
