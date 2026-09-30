import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ENV_FILE, loadEnv, parseEnv } from '../src/env.js';

const directory = await mkdtemp(join(tmpdir(), 'hello-dsh-env-'));

describe('parseEnv', () => {
  it('parses plain, exported and padded assignments', () => {
    assert.deepEqual(parseEnv('A=1\nB = two\nexport C=three\n'), { A: '1', B: 'two', C: 'three' });
  });

  it('ignores comments, blank lines and junk', () => {
    assert.deepEqual(parseEnv('# comment\n\n   \nNOT A PAIR\nA=1 # trailing\n'), { A: '1' });
  });

  it('keeps hashes that belong to a value', () => {
    assert.deepEqual(parseEnv('HASH=a#b\nQUOTED="a # b"\n'), { HASH: 'a#b', QUOTED: 'a # b' });
  });

  it('handles quoting and escapes', () => {
    assert.deepEqual(parseEnv('A="line1\\nline2"\nB=\'keep \\n literal\'\nC="say \\"hi\\""\n'), {
      A: 'line1\nline2',
      B: 'keep \\n literal',
      C: 'say "hi"',
    });
  });

  it('strips a BOM and keeps empty values', () => {
    assert.deepEqual(parseEnv('\uFEFFA=\n'), { A: '' });
  });
});

describe('loadEnv', () => {
  it('reports found: false for a missing file', () => {
    const result = loadEnv({ file: join(directory, 'nope.env'), env: {} });
    assert.equal(result.found, false);
    assert.deepEqual(result.applied, []);
  });

  it('applies values but never overrides existing variables', async () => {
    const file = join(directory, 'sample.env');
    await writeFile(file, 'DEEPSEEK_API_KEY=from-file\nCHAT_DATA=from-file-path\n', 'utf8');

    const env = { DEEPSEEK_API_KEY: 'from-shell' };
    const result = loadEnv({ file, env });

    assert.equal(result.found, true);
    assert.deepEqual(result.applied, ['CHAT_DATA']);
    assert.deepEqual(result.skipped, ['DEEPSEEK_API_KEY']);
    assert.equal(env.DEEPSEEK_API_KEY, 'from-shell');
    assert.equal(env.CHAT_DATA, 'from-file-path');
  });

  it('treats an empty existing variable as unset', async () => {
    const file = join(directory, 'empty-existing.env');
    await writeFile(file, 'PORT=4000\n', 'utf8');

    const env = { PORT: '' };
    loadEnv({ file, env });
    assert.equal(env.PORT, '4000');
  });

  it('defaults to <project>/.env', () => {
    assert.match(DEFAULT_ENV_FILE, /[\\/]\.env$/);
  });
});
