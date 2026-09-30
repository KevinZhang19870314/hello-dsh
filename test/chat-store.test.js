import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatStore, DEFAULT_TITLE, deriveTitle } from '../src/chat-store.js';

/**
 * Deterministic store: predictable ids and strictly increasing timestamps.
 * @param {object[]} [seed]
 */
function createStore(seed = []) {
  let ids = 0;
  let ticks = 0;
  return new ChatStore(seed, {
    idFactory: () => `id-${(ids += 1)}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (ticks += 1))),
  });
}

describe('deriveTitle', () => {
  it('collapses whitespace and falls back for blank input', () => {
    assert.equal(deriveTitle('  多   行\n标题  '), '多 行 标题');
    assert.equal(deriveTitle(''), DEFAULT_TITLE);
    assert.equal(deriveTitle(null, '备用'), '备用');
  });

  it('truncates very long titles', () => {
    const title = deriveTitle('长'.repeat(80));
    assert.equal([...title].length, 49);
    assert.ok(title.endsWith('…'));
  });
});

describe('ChatStore', () => {
  it('starts empty', () => {
    const store = createStore();
    assert.equal(store.size, 0);
    assert.deepEqual(store.list(), []);
  });

  it('creates conversations with the default title', () => {
    const store = createStore();
    const conversation = store.create();
    assert.equal(conversation.title, DEFAULT_TITLE);
    assert.deepEqual(conversation.messages, []);
    assert.equal(store.size, 1);
    assert.equal(store.get(conversation.id).id, conversation.id);
  });

  it('auto-titles a conversation from the first user message', () => {
    const store = createStore();
    const { id } = store.create();
    store.appendMessage(id, { role: 'user', content: '帮我写一个快速排序' });
    assert.equal(store.get(id).title, '帮我写一个快速排序');
  });

  it('keeps an explicit title', () => {
    const store = createStore();
    const { id } = store.create('项目讨论');
    store.appendMessage(id, { role: 'user', content: '你好' });
    assert.equal(store.get(id).title, '项目讨论');
  });

  it('appends messages and bumps updatedAt', () => {
    const store = createStore();
    const { id } = store.create();
    const before = store.get(id).updatedAt;
    const message = store.appendMessage(id, { role: 'user', content: '你好' });
    assert.equal(message.role, 'user');
    assert.equal(store.get(id).messages.length, 1);
    assert.notEqual(store.get(id).updatedAt, before);
    assert.ok(store.get(id).updatedAt > before);
  });

  it('lists the most recently updated conversation first', () => {
    const store = createStore();
    const first = store.create('第一个');
    const second = store.create('第二个');
    assert.deepEqual(store.list().map((item) => item.id), [second.id, first.id]);

    store.appendMessage(first.id, { role: 'user', content: '更新第一个对话' });
    assert.deepEqual(store.list().map((item) => item.id), [first.id, second.id]);

    const [summary] = store.list();
    assert.equal(summary.messageCount, 1);
    assert.match(summary.preview, /更新第一个对话/);
  });

  it('renames conversations and rejects blank titles', () => {
    const store = createStore();
    const { id } = store.create();
    assert.equal(store.rename(id, '  面试准备  ').title, '面试准备');
    assert.equal(store.get(id).title, '面试准备');
    assert.throws(() => store.rename(id, '   '), TypeError);
  });

  it('removes one conversation and clears the rest', () => {
    const store = createStore();
    const a = store.create('a');
    const b = store.create('b');

    assert.equal(store.remove(a.id).id, a.id);
    assert.equal(store.size, 1);
    assert.deepEqual(store.list().map((item) => item.id), [b.id]);

    assert.equal(store.clear(), 1);
    assert.equal(store.size, 0);
  });

  it('reports NOT_FOUND for unknown ids', () => {
    const store = createStore();
    store.create('only');

    const isNotFound = (error) => error.code === 'NOT_FOUND';
    assert.throws(() => store.get('missing'), isNotFound);
    assert.throws(() => store.remove('missing'), isNotFound);
    assert.throws(() => store.rename('missing', 'x'), isNotFound);
    assert.throws(() => store.appendMessage('missing', { role: 'user', content: 'x' }), isNotFound);
  });

  it('rejects invalid messages and malformed input', () => {
    const store = createStore();
    const { id } = store.create();

    assert.throws(() => store.appendMessage(id, { role: 'robot', content: 'x' }), TypeError);
    assert.throws(() => store.appendMessage(id, { role: 'user', content: '   ' }), TypeError);
    assert.throws(() => store.appendMessage(id, {}), TypeError);
    assert.equal(store.get(id).messages.length, 0);
    assert.throws(() => createStore('nope'), TypeError);
  });

  it('round-trips through JSON', () => {
    const store = createStore();
    const { id } = store.create();
    store.appendMessage(id, { role: 'user', content: '你好' });
    store.appendMessage(id, { role: 'assistant', content: '你好呀' });

    const restored = new ChatStore(JSON.parse(JSON.stringify(store)));
    assert.deepEqual(restored.get(id), store.get(id));
    assert.deepEqual(restored.list(), store.list());
  });

  it('repairs incomplete stored records', () => {
    let ids = 0;
    const store = new ChatStore(
      [
        {
          title: '',
          messages: [{ role: 'user', content: '第一次提问', createdAt: '2026-01-01T00:00:00.000Z' }],
        },
      ],
      { idFactory: () => `generated-${(ids += 1)}`, now: () => new Date('2026-02-02T00:00:00.000Z') },
    );

    const [conversation] = store.toJSON();
    assert.equal(conversation.title, '第一次提问');
    assert.equal(conversation.updatedAt, '2026-01-01T00:00:00.000Z');
    assert.match(conversation.id, /^generated-/);
    assert.match(conversation.messages[0].id, /^generated-/);
    assert.equal(conversation.messages[0].role, 'user');
  });

  it('rejects stored messages without a valid role', () => {
    assert.throws(() => new ChatStore([{ messages: [{ role: 'robot', content: 'x' }] }]), /role/);
  });

  it('hands out copies so callers cannot mutate internal state', () => {
    const store = createStore();
    const conversation = store.create('标题');
    conversation.title = '被改掉了';
    conversation.messages.push({ id: 'x', role: 'user', content: 'x', createdAt: 'x' });
    assert.equal(store.get(conversation.id).title, '标题');
    assert.equal(store.get(conversation.id).messages.length, 0);
  });
});
