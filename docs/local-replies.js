/**
 * The offline ("demo mode") reply engine.
 *
 * This module is deliberately free of Node APIs: the Node server uses it when
 * no `DEEPSEEK_API_KEY` is configured, and the static GitHub Pages build ships
 * the very same file so the browser demo answers identically.
 */

import { chunkText, truncate } from './text-utils.js';

/** How long the demo mode waits between chunks, in milliseconds. */
export const DEFAULT_CHUNK_DELAY_MS = 12;

/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ModelMessage */

export const LOCAL_RULES = [
  {
    pattern: /^(你好|您好|哈喽|嗨|hi\b|hello)/i,
    reply:
      '你好！👋 我是这个聊天页面的助手。\n\n- 点左上角 **＋ 新建对话** 开启一段新会话\n- 鼠标移到左侧对话上，点 🗑 即可删除它\n\n想聊点什么？',
  },
  {
    pattern: /(你是谁|你叫什么|who are you|自我介绍)/i,
    reply:
      '我是 hello-dsh 聊天应用里的助手。\n\n当前运行在**本地演示模式**（没有检测到 `DEEPSEEK_API_KEY`），所以回复来自内置规则；在服务端配置密钥并重启后，我会被真实的 DeepSeek 模型接管。',
  },
  {
    pattern: /(帮助|怎么用|使用说明|help|功能)/i,
    reply: [
      '使用方式：',
      '',
      '1. 点击左上角「＋ 新建对话」开启一段新会话；',
      '2. 在底部输入框输入消息，`Enter` 发送、`Shift + Enter` 换行；',
      '3. 鼠标悬停在左侧对话上，点击 🗑 删除该对话；',
      '4. 顶部 ✎ 可以重命名当前对话；',
      '5. 所有对话都会写入服务端的 JSON 文件，重启后依然在。',
    ].join('\n'),
  },
  {
    pattern: /(代码|code|函数|bug|报错|异常|测试)/i,
    reply: [
      '处理代码问题我一般按这三步走：',
      '',
      '- **复现**：先构造一个最小可复现用例；',
      '- **定位**：区分是数据、状态还是边界条件的问题；',
      '- **固化**：补一个能锁住行为的单元测试，避免回归。',
      '',
      '把具体的报错信息和相关代码贴给我，我可以逐行帮你分析。',
    ].join('\n'),
  },
  {
    pattern: /(谢谢|感谢|thanks|thank you|辛苦)/i,
    reply: '不客气！随时找我。🙂',
  },
  {
    pattern: /(再见|拜拜|bye|goodbye)/i,
    reply: '再见！对话记录会一直留在你打开的这个页面里。',
  },
];

/**
 * Deterministic offline reply used by the demo mode.
 * @param {ModelMessage[]} messages
 * @returns {string}
 */
export function buildLocalReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter((message) => message.role === 'user');
  const last = userMessages.at(-1)?.content?.trim() ?? '';

  for (const rule of LOCAL_RULES) {
    if (rule.pattern.test(last)) return rule.reply;
  }

  return [
    `我已经收到你的第 ${userMessages.length} 条消息：`,
    '',
    `> ${truncate(last, 160) || '（空消息）'}`,
    '',
    '当前是**本地演示模式**，只能给出这种规则化的回应。在服务端设置环境变量 `DEEPSEEK_API_KEY` 后重启服务，就能接入真实模型获得完整回答。',
  ].join('\n');
}

/**
 * Stream the offline reply chunk by chunk, so the browser can render a typing
 * effect exactly like it does for the real model.
 * @param {ModelMessage[]} messages
 * @param {number} [delayMs]
 * @returns {AsyncGenerator<string>}
 */
export async function* streamLocalReply(messages, delayMs = DEFAULT_CHUNK_DELAY_MS) {
  for (const chunk of chunkText(buildLocalReply(messages))) {
    if (delayMs > 0) await sleep(delayMs);
    yield chunk;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
