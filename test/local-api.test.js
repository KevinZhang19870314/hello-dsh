/**
 * Tests for the static GitHub Pages build.
 *
 * These deliberately import the *generated* artifact (`docs/local-api.js`) rather
 * than its source (`site/local-api.js`), so what is asserted here is exactly what
 * GitHub Pages serves. The last test fails when `docs/` is stale, which is the
 * reminder to run `npm run build:pages`.
 */

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COPIES, OUTPUT_DIR } from '../scripts/build-pages.js';
import { createLocalApi, installLocalApi, STORAGE_KEY } from '../docs/local-api.js';
import { buildLocalReply } from '../src/local-replies.js';
import { ChatStore, deriveTitle } from '../src/chat-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * A handler with a deterministic clock and id-less assertions.
 * @param {{ storage?: object }} [options]
 */
function harness({ storage = memoryStorage() } = {}) {
  let tick = 0;
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const handle = createLocalApi({
    storage,
    now: () => new Date(base + (tick += 1000)),
    chunkDelayMs: 0,
  });
  return { handle, storage };
}

/** @param {any} handle @param {string} path @param {RequestInit} [init] */
async function json(handle, path, init) {
  const response = await handle(path, init);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/**
 * Read the SSE frames the same way `public/app.js` does (`response.body` reader).
 * @param {Response} response
 */
async function readEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.split('\n').find((item) => item.startsWith('data:'));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

/** @param {any} handle @param {string} path @param {object} body */
function post(handle, path, body, method = 'POST') {
  return json(handle, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('static GitHub Pages API shim', () => {
  it('only intercepts /api/** and lets everything else reach the network', async () => {
    const { handle } = harness();
    assert.equal(await handle('/styles.css'), null);
    assert.equal(await handle('/hello-dsh/index.html'), null);
    assert.notEqual(await handle('/api/health'), null);
    assert.notEqual(await handle('/hello-dsh/api/health'), null);
  });

  it('advertises the static demo mode from /api/health', async () => {
    const { handle } = harness();
    const { status, body } = await json(handle, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.assistant.mode, 'local');
    assert.match(body.assistant.label, /GitHub Pages/);
    assert.match(body.assistant.hint, /localStorage/);
    assert.equal(body.conversations, 0);
  });

  it('creates, lists, renames and deletes conversations', async () => {
    const { handle } = harness();

    const created = await post(handle, '/api/conversations', {});
    assert.equal(created.status, 201);
    const id = created.body.conversation.id;
    assert.ok(id);
    assert.equal(created.body.conversation.title, '新对话');
    assert.deepEqual(created.body.conversation.messages, []);
    assert.equal(created.body.conversations.length, 1);

    const listed = await json(handle, '/api/conversations');
    assert.equal(listed.body.conversations.length, 1);
    assert.equal(listed.body.conversations[0].messageCount, 0);

    const renamed = await post(handle, `/api/conversations/${id}`, { title: '  换个   名字 ' }, 'PATCH');
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.conversation.title, '换个 名字');

    const fetched = await json(handle, `/api/conversations/${id}`);
    assert.equal(fetched.body.conversation.id, id);

    const removed = await json(handle, `/api/conversations/${id}`, { method: 'DELETE' });
    assert.equal(removed.body.conversation.id, id);
    assert.deepEqual(removed.body.conversations, []);

    const cleared = await json(handle, '/api/conversations', { method: 'DELETE' });
    assert.equal(cleared.body.removed, 0);
    assert.deepEqual(cleared.body.conversations, []);
  });

  it('streams start → delta* → done and persists the reply', async () => {
    const { handle, storage } = harness();
    const created = await post(handle, '/api/conversations', {});
    const id = created.body.conversation.id;

    const response = await handle(`/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '你好', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const events = await readEventStream(response);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].userMessage.content, '你好');
    assert.equal(events.at(-1).type, 'done');
    assert.ok(events.slice(1, -1).every((event) => event.type === 'delta'));
    assert.ok(events.length > 2, 'expected at least one delta frame');

    const expected = buildLocalReply([{ role: 'user', content: '你好' }]);
    const streamed = events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    assert.equal(streamed, expected);

    const done = events.at(-1);
    assert.equal(done.assistantMessage.role, 'assistant');
    assert.equal(done.assistantMessage.content, expected);
    assert.equal(done.conversation.messages.length, 2);
    assert.equal(done.conversations[0].messageCount, 2);
    assert.equal(done.conversations[0].title, '你好');
    assert.ok(storage.getItem(STORAGE_KEY)?.includes('你好'));
  });

  it('answers the same text as the Node reply engine for every rule', async () => {
    const probes = ['你好', '你是谁', '帮助', '这段代码有 bug', '谢谢', '再见', '随便说点什么'];
    for (const probe of probes) {
      const { handle } = harness();
      const created = await post(handle, '/api/conversations', {});
      const id = created.body.conversation.id;
      const result = await post(handle, `/api/conversations/${id}/messages`, {
        content: probe,
        stream: false,
      });
      assert.equal(
        result.body.assistantMessage.content,
        buildLocalReply([{ role: 'user', content: probe }]),
        `probe=${probe}`,
      );
    }
  });

  it('supports the non-streaming JSON variant', async () => {
    const { handle } = harness();
    const created = await post(handle, '/api/conversations', {});
    const id = created.body.conversation.id;

    const result = await post(handle, `/api/conversations/${id}/messages`, {
      content: '帮助',
      stream: false,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.userMessage.role, 'user');
    assert.equal(result.body.assistantMessage.role, 'assistant');
    assert.equal(result.body.conversation.messages.length, 2);
    assert.equal(result.body.conversations[0].messageCount, 2);
  });

  it('derives titles exactly like the Node ChatStore', async () => {
    const cases = ['你好世界', '  多个   空格  ', 'a'.repeat(49), '🙂'.repeat(20), 'hello world'];
    for (const content of cases) {
      const { handle } = harness();
      const created = await post(handle, '/api/conversations', {});
      const id = created.body.conversation.id;
      await post(handle, `/api/conversations/${id}/messages`, { content, stream: false });

      const shimTitle = (await json(handle, `/api/conversations/${id}`)).body.conversation.title;

      const store = new ChatStore();
      const conversation = store.create();
      store.appendMessage(conversation.id, { role: 'user', content });
      assert.equal(shimTitle, store.get(conversation.id).title, `content=${content}`);
    }

    assert.equal(deriveTitle('a'.repeat(49)), `${'a'.repeat(48)}…`);
  });

  it('restores conversations from storage', async () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    const created = await post(first.handle, '/api/conversations', { title: '持久化' });

    const second = harness({ storage });
    const listed = await json(second.handle, '/api/conversations');
    assert.equal(listed.body.conversations.length, 1);
    assert.equal(listed.body.conversations[0].id, created.body.conversation.id);
    assert.equal(listed.body.conversations[0].title, '持久化');
  });

  it('survives a corrupted storage payload', async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    const { handle } = harness({ storage });
    const listed = await json(handle, '/api/conversations');
    assert.deepEqual(listed.body.conversations, []);

    const created = await post(handle, '/api/conversations', {});
    assert.equal(created.status, 201);
  });

  it('reports 404 / 400 the same way the server does', async () => {
    const { handle } = harness();
    const created = await post(handle, '/api/conversations', {});
    const id = created.body.conversation.id;

    const missing = await json(handle, '/api/conversations/does-not-exist');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /找不到/);

    const unknown = await json(handle, '/api/nope');
    assert.equal(unknown.status, 404);

    const empty = await post(handle, `/api/conversations/${id}/messages`, { content: '   ' });
    assert.equal(empty.status, 400);

    const blankTitle = await post(handle, `/api/conversations/${id}`, { title: '  ' }, 'PATCH');
    assert.equal(blankTitle.status, 400);

    const wrongMethod = await json(handle, '/api/health', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  });
});

describe('installLocalApi (what boot.js relies on)', () => {
  it('answers /api/** in-process and passes other URLs to the real fetch', async () => {
    const original = globalThis.fetch;
    const restore = installLocalApi({ storage: memoryStorage(), chunkDelayMs: 0 });
    try {
      const health = await (await fetch('/api/health')).json();
      assert.equal(health.ok, true);
      assert.equal(health.assistant.label, '静态演示模式（GitHub Pages）');

      // A non-API URL must reach the genuine implementation, untouched.
      const passthrough = await fetch('data:text/plain,hello');
      assert.equal(await passthrough.text(), 'hello');
    } finally {
      restore();
    }
    assert.equal(globalThis.fetch, original);
  });
});

describe('generated docs/ bundle', () => {
  it('resolves every relative import inside the shipped modules', async () => {
    for (const name of ['boot.js', 'local-api.js', 'local-replies.js', 'text-utils.js', 'app.js']) {
      const source = await readFile(join(ROOT, OUTPUT_DIR, name), 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) {
        const target = join(ROOT, OUTPUT_DIR, match[1]);
        const info = await stat(target).catch(() => null);
        assert.ok(info?.isFile(), `${OUTPUT_DIR}/${name} 引用了不存在的模块 ${match[1]}`);
      }
    }
  });

  it('uses relative asset URLs so the site works under /<repo>/', async () => {
    const html = await readFile(join(ROOT, OUTPUT_DIR, 'index.html'), 'utf8');
    assert.ok(html.includes('href="./styles.css"'), 'stylesheet must be relative');
    assert.ok(html.includes('src="./boot.js"'), 'entry module must be relative');
    assert.ok(!html.includes('href="/styles.css"'));
    assert.ok(!html.includes('src="/app.js"'));
    assert.ok(html.includes('在线演示'));
  });

  it('ships .nojekyll so Pages serves the files verbatim', async () => {
    const info = await stat(join(ROOT, OUTPUT_DIR, '.nojekyll'));
    assert.ok(info.isFile());
  });

  it('keeps every copied file byte-identical to its source', async () => {
    for (const [source, destination] of COPIES) {
      const [from, to] = await Promise.all([
        readFile(join(ROOT, source)),
        readFile(join(ROOT, OUTPUT_DIR, destination)),
      ]);
      assert.ok(
        from.equals(to),
        `${OUTPUT_DIR}/${destination} 与 ${source} 不一致，请运行 npm run build:pages`,
      );
    }
  });
});
