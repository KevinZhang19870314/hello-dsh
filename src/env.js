/**
 * Minimal, dependency-free `.env` loader.
 *
 * Loaded by the CLI entry point (`src/index.js`) *before* anything else reads
 * the environment, so `PORT`, `CHAT_DATA`, `DEEPSEEK_API_KEY`, … can live in a
 * file instead of the shell.
 *
 * Precedence follows the usual dotenv convention: variables that already exist
 * in the environment win, so `DEEPSEEK_API_KEY=... npm start` still overrides
 * the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default location: `<project>/.env` */
export const DEFAULT_ENV_FILE = join(projectRoot, '.env');

const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\' };

/**
 * Parse `.env` text into a plain object.
 *
 * Supported syntax:
 *   - `KEY=value`, `KEY = value`, `export KEY=value`
 *   - blank lines and `#` comments
 *   - single quotes (literal) and double quotes (with `\n`, `\t`, `\"`, `\\`)
 *   - trailing ` # comment` on unquoted values
 * Unparsable lines are skipped silently.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const result = {};
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key] = match;
    let value = match[2].trim();

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\([nrt'"\\])/g, (_whole, character) => ESCAPES[character]);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    result[key] = value;
  }
  return result;
}

/**
 * Read a `.env` file and copy its entries into `env`.
 *
 * A missing file is not an error. Existing non-empty variables are never
 * overwritten.
 *
 * @param {{ file?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ file: string, found: boolean, applied: string[], skipped: string[] }}
 */
export function loadEnv({ file, env = process.env } = {}) {
  const target = resolve(file ?? DEFAULT_ENV_FILE);

  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file: target, found: false, applied: [], skipped: [] };
    throw new Error(`无法读取 ${target}：${error.message}`, { cause: error });
  }

  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const skipped = [];

  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied.push(key);
    } else {
      skipped.push(key);
    }
  }

  return { file: target, found: true, applied, skipped };
}
