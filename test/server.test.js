import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'hello-dsh-server-'));
const dataFile = join(directory, 'conversations.json');

process.env.CHAT_DATA = dataFile;
process.env.CHAT_STREAM_DELAY_MS = '0';
delete process.env.DEEPSEEK_API_KEY;
delete process.env.HELLO_DSH_DATA;

const { startServer } = await import('../src/server.js');

const JSON_HEADERS = { 'content-type': 'application/json' };

/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let base;

before(async () => {
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  server = started.server;
  base = started.url;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.CHAT_DATA;
  delete process.env.CHAT_STREAM_DELAY_MS;
});

/** @param {string} [title] */
async function createConversation(title) {
  const response = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(title ? { title } : {}),
  });
  assert.equal(response.status, 201);
  return (await response.json()).conversation;
}

/** @param {string} id @param {string} content @param {boolean} stream */
function postMessage(id, content, stream) {
  return fetch(`${base}/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ content, stream }),
  });
}

describe('static assets', () => {
  it('serves the chat UI', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);

    const html = await response.text();
    assert.match(html, /新建对话/);
    assert.match(html, /对话列表/);
    assert.match(html, /app\.js/);
  });

  it('serves the stylesheet, the script and 404s for unknown files', async () => {
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /sendMessage/);

    const missing = await fetch(`${base}/nope.png`);
    assert.equal(missing.status, 404);
  });

  it('refuses to escape the public directory', async () => {
    const traversal = await fetch(`${base}/..%2Fpackage.json`);
    assert.equal(traversal.status, 403);

    const normalized = await fetch(`${base}/../package.json`);
    assert.equal(normalized.status, 404);
    assert.ok(!(await normalized.text()).includes('"scripts"'));
  });
});

describe('GET /api/health', () => {
  it('reports the assistant mode', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.assistant.mode, 'local');
    assert.equal(payload.dataFile, dataFile);
  });
});

describe('conversation lifecycle', () => {
  it('creates, lists, renames and reads conversations', async () => {
    const conversation = await createConversation();
    assert.equal(conversation.title, '新对话');
    assert.deepEqual(conversation.messages, []);

    const list = await fetch(`${base}/api/conversations`).then((response) => response.json());
    assert.ok(list.conversations.some((item) => item.id === conversation.id));

    const renamed = await fetch(`${base}/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: '面试准备' }),
    });
    assert.equal(renamed.status, 200);
    const renamedPayload = await renamed.json();
    assert.equal(renamedPayload.conversation.title, '面试准备');

    const fetched = await fetch(`${base}/api/conversations/${conversation.id}`).then((response) => response.json());
    assert.equal(fetched.conversation.title, '面试准备');
  });

  it('deletes a single conversation and 404s afterwards', async () => {
    const conversation = await createConversation('待删除');
    const deletion = await fetch(`${base}/api/conversations/${conversation.id}`, { method: 'DELETE' });
    assert.equal(deletion.status, 200);
    const payload = await deletion.json();
    assert.ok(!payload.conversations.some((item) => item.id === conversation.id));

    const missing = await fetch(`${base}/api/conversations/${conversation.id}`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /找不到/);
  });
});

describe('messages', () => {
  it('answers a message without streaming and persists it', async () => {
    const conversation = await createConversation();
    const response = await postMessage(conversation.id, '你好', false);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.userMessage.role, 'user');
    assert.equal(payload.userMessage.content, '你好');
    assert.equal(payload.assistantMessage.role, 'assistant');
    assert.ok(payload.assistantMessage.content.length > 0);
    assert.equal(payload.conversation.messages.length, 2);
    assert.equal(payload.conversation.title, '你好');

    const onDisk = JSON.parse(await readFile(dataFile, 'utf8'));
    const stored = onDisk.find((item) => item.id === conversation.id);
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.title, '你好');
  });

  it('streams a reply as server-sent events', async () => {
    const conversation = await createConversation();
    const response = await postMessage(conversation.id, '帮助', true);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /"type":"start"/);
    assert.match(text, /"type":"delta"/);
    assert.match(text, /"type":"done"/);

    const frames = text
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data:\s*/, '')));
    const done = frames.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.conversation.messages.length, 2);
    assert.ok(done.assistantMessage.content.length > 0);
    assert.match(done.assistantMessage.content, /新建对话/);
  });

  it('rejects blank messages', async () => {
    const conversation = await createConversation();
    const response = await postMessage(conversation.id, '   ', false);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /不能为空/);

    const fetched = await fetch(`${base}/api/conversations/${conversation.id}`).then((item) => item.json());
    assert.equal(fetched.conversation.messages.length, 0);
  });

  it('404s for unknown conversations and 405s for unsupported methods', async () => {
    const unknown = await postMessage('does-not-exist', 'hi', false);
    assert.equal(unknown.status, 404);

    const conversation = await createConversation();
    const methodNotAllowed = await fetch(`${base}/api/conversations/${conversation.id}`, { method: 'PUT' });
    assert.equal(methodNotAllowed.status, 405);

    const unknownApi = await fetch(`${base}/api/nope`);
    assert.equal(unknownApi.status, 404);
  });
});

describe('DELETE /api/conversations', () => {
  it('clears every conversation', async () => {
    await createConversation('a');
    await createConversation('b');

    const cleared = await fetch(`${base}/api/conversations`, { method: 'DELETE' }).then((response) => response.json());
    assert.ok(cleared.removed >= 2);
    assert.deepEqual(cleared.conversations, []);

    const list = await fetch(`${base}/api/conversations`).then((response) => response.json());
    assert.deepEqual(list.conversations, []);
    assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')), []);
  });
});
