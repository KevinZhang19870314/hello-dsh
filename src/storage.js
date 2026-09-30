/**
 * JSON file persistence for conversations.
 *
 * The data file location can be overridden with the CHAT_DATA env var, which
 * keeps tests (and throwaway experiments) out of the real chat history.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = join(projectRoot, 'data', 'conversations.json');

/** Absolute path of the JSON file backing the chat history. */
export function dataFilePath() {
  const override = process.env.CHAT_DATA?.trim() || process.env.HELLO_DSH_DATA?.trim();
  return override ? resolve(override) : DEFAULT_FILE;
}

/**
 * Read the persisted conversations. A missing or empty file is treated as an
 * empty history so the first run works without any setup.
 * @returns {Promise<object[]>}
 */
export async function load() {
  const file = dataFilePath();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  if (text.trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${file} 不是合法的 JSON`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} 的内容应该是一个对话数组`);
  }
  return parsed;
}

/**
 * Write conversations back to disk, creating the parent directory when needed.
 * @param {{ toJSON: () => object[] } | object[]} conversations
 * @returns {Promise<string>} the file that was written
 */
export async function save(conversations) {
  const file = dataFilePath();
  await mkdir(dirname(file), { recursive: true });
  const payload = Array.isArray(conversations) ? conversations : conversations.toJSON();
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}
