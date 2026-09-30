import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatStore } from '../src/chat-store.js';
import { dataFilePath, load, save } from '../src/storage.js';

const directory = await mkdtemp(join(tmpdir(), 'hello-dsh-storage-'));

/** @param {string} name */
function useFile(name) {
  const file = join(directory, name);
  process.env.CHAT_DATA = file;
  return file;
}

after(() => {
  delete process.env.CHAT_DATA;
  delete process.env.HELLO_DSH_DATA;
});

describe('dataFilePath', () => {
  it('honours CHAT_DATA and otherwise falls back into the project data folder', () => {
    const file = useFile('custom.json');
    assert.equal(dataFilePath(), resolve(file));

    delete process.env.CHAT_DATA;
    assert.match(dataFilePath(), /data[\\/]conversations\.json$/);

    process.env.HELLO_DSH_DATA = join(directory, 'legacy.json');
    assert.equal(dataFilePath(), resolve(directory, 'legacy.json'));
    delete process.env.HELLO_DSH_DATA;
  });
});

describe('load', () => {
  it('treats a missing file as an empty history', async () => {
    useFile(join('missing', 'nothing-here.json'));
    assert.deepEqual(await load(), []);
  });

  it('treats an empty file as an empty history', async () => {
    const file = useFile('empty.json');
    await writeFile(file, '   \n', 'utf8');
    assert.deepEqual(await load(), []);
  });

  it('rejects invalid JSON and non-array payloads', async () => {
    const broken = useFile('broken.json');
    await writeFile(broken, '{ not json', 'utf8');
    await assert.rejects(() => load(), /不是合法的 JSON/);

    const wrongShape = useFile('wrong-shape.json');
    await writeFile(wrongShape, '{"conversations":[]}', 'utf8');
    await assert.rejects(() => load(), /对话数组/);
  });
});

describe('save', () => {
  it('creates missing directories and writes readable JSON', async () => {
    const file = useFile(join('nested', 'deeper', 'conversations.json'));
    const written = await save([{ id: 'c1', title: '标题', messages: [] }]);
    assert.equal(written, resolve(file));

    const text = await readFile(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(await load(), [{ id: 'c1', title: '标题', messages: [] }]);
  });

  it('accepts a ChatStore instance', async () => {
    useFile('store.json');
    const store = new ChatStore([], {
      idFactory: (() => {
        let n = 0;
        return () => `id-${(n += 1)}`;
      })(),
      now: () => new Date('2026-03-03T00:00:00.000Z'),
    });
    const { id } = store.create('持久化测试');
    store.appendMessage(id, { role: 'user', content: '存在磁盘上' });
    await save(store);

    const reloaded = new ChatStore(await load());
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.get(id).title, '持久化测试');
    assert.equal(reloaded.get(id).messages[0].content, '存在磁盘上');
  });
});
