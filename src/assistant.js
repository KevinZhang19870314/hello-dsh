/**
 * Assistant reply generation.
 *
 * Two modes, chosen at runtime:
 *   - `deepseek` — DEEPSEEK_API_KEY is set, so replies stream from the DeepSeek
 *     chat-completions API.
 *   - `local`    — no key configured: deterministic, offline demo replies so the
 *     UI is fully usable (and testable) without network access. The rule table
 *     lives in `local-replies.js`, which the browser build reuses as-is.
 *
 * Both modes are async generators that yield text deltas, so the HTTP layer can
 * treat them identically.
 */

import process from 'node:process';
import { truncate } from './text-utils.js';
import { buildLocalReply, streamLocalReply } from './local-replies.js';

export { buildLocalReply };

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_SYSTEM_PROMPT = '你是一个乐于助人的中文 AI 助手。回答准确、简洁，必要时使用 Markdown 排版。';
const DEFAULT_CHUNK_DELAY_MS = 12;
const MAX_ERROR_DETAIL = 240;

/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ModelMessage */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'deepseek' | 'local'}
 */
export function assistantMode(env = process.env) {
  return env.DEEPSEEK_API_KEY?.trim() ? 'deepseek' : 'local';
}

/**
 * UI copy describing the active reply mode. Lives here so the server and the
 * frontend never disagree about what the badge should say.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: 'deepseek' | 'local', label: string, hint: string }}
 */
export function assistantBadge(env = process.env) {
  return assistantMode(env) === 'deepseek'
    ? { mode: 'deepseek', label: 'DeepSeek API 已接入', hint: '回复由 DeepSeek API 实时生成' }
    : {
        mode: 'local',
        label: '本地演示模式（未配置 API Key）',
        hint: '未检测到 DEEPSEEK_API_KEY，回复由本地规则模拟生成',
      };
}

/**
 * Turn a stored conversation into the message array the model expects.
 * @param {{ messages?: { role: string, content: string }[] }} conversation
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ModelMessage[]}
 */
export function buildModelMessages(conversation, env = process.env) {
  const history = (conversation?.messages ?? [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
  const system = (env.CHAT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT).trim();
  return system ? [{ role: 'system', content: system }, ...history] : history;
}

/**
 * Stream a reply for the given conversation history.
 * @param {ModelMessage[]} messages
 * @param {{ env?: NodeJS.ProcessEnv, signal?: AbortSignal, delayMs?: number }} [options]
 * @returns {AsyncGenerator<string>}
 */
export async function* streamReply(messages, { env = process.env, signal, delayMs } = {}) {
  const chunkDelay = delayMs ?? chunkDelayFromEnv(env);

  if (assistantMode(env) === 'local') {
    yield* streamLocalReply(messages, chunkDelay);
    return;
  }

  let produced = false;
  try {
    for await (const delta of deepseekStream(messages, { env, signal })) {
      produced = true;
      yield delta;
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (produced) {
      yield `\n\n> ⚠️ 与 DeepSeek 的连接中断：${error.message}`;
      return;
    }
    yield `> ⚠️ 调用 DeepSeek API 失败：${error.message}\n\n已自动切换为本地演示回复。\n\n`;
    yield* streamLocalReply(messages, chunkDelay);
  }
}

/**
 * @param {ModelMessage[]} messages
 * @param {{ env: NodeJS.ProcessEnv, signal?: AbortSignal }} options
 * @returns {AsyncGenerator<string>}
 */
async function* deepseekStream(messages, { env, signal }) {
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.DEEPSEEK_API_KEY.trim()}`,
    },
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `${response.status} ${response.statusText}${detail ? ` — ${truncate(detail, MAX_ERROR_DETAIL)}` : ''}`,
    );
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    }
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function chunkDelayFromEnv(env) {
  const raw = env.CHAT_STREAM_DELAY_MS;
  if (raw === undefined || raw === '') return DEFAULT_CHUNK_DELAY_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHUNK_DELAY_MS;
}
