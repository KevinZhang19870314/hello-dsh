/**
 * Pure text helpers shared by the Node server and the browser frontend.
 *
 * Nothing in here touches Node-specific APIs, so `scripts/build-pages.js` can
 * copy this file into the static GitHub Pages bundle unchanged and the exact
 * same code runs in both places. Keep it dependency-free.
 */

export const DEFAULT_TITLE = '新对话';
export const MAX_TITLE_LENGTH = 48;
export const MAX_PREVIEW_LENGTH = 80;

/**
 * Collapse whitespace, then hard-cut to `max` characters (code points, so
 * emoji and CJK are never split in half).
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = MAX_PREVIEW_LENGTH) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = [...clean];
  return characters.length <= max ? clean : `${characters.slice(0, max).join('')}…`;
}

/**
 * Build a conversation title out of the first user message.
 * @param {unknown} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function deriveTitle(text, fallback = DEFAULT_TITLE) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  const characters = [...clean];
  if (characters.length <= MAX_TITLE_LENGTH) return clean;
  return `${characters.slice(0, MAX_TITLE_LENGTH).join('')}…`;
}

/**
 * Split text into small, word-ish chunks so the UI can render a typing effect.
 * @param {string} text
 * @param {number} [size]
 * @returns {string[]}
 */
export function chunkText(text, size = 4) {
  const characters = [...String(text ?? '')];
  const chunks = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''));
  }
  return chunks;
}
