/**
 * Frontend for the hello-dsh chat app.
 *
 * Talks to the JSON/SSE API in src/server.js and keeps all conversation state
 * in memory after loading it once from /api/conversations.
 */

const els = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  scrim: document.getElementById('scrim'),
  toggleSidebar: document.getElementById('toggle-sidebar'),
  newChat: document.getElementById('new-chat'),
  clearAll: document.getElementById('clear-all'),
  list: document.getElementById('conversation-list'),
  modeBadge: document.getElementById('mode-badge'),
  chatTitle: document.getElementById('chat-title'),
  titleInput: document.getElementById('title-input'),
  renameChat: document.getElementById('rename-chat'),
  deleteChat: document.getElementById('delete-chat'),
  messages: document.getElementById('messages'),
  messagesInner: document.getElementById('messages-inner'),
  welcome: document.getElementById('welcome'),
  suggestions: document.getElementById('suggestions'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  hint: document.getElementById('hint'),
};

const state = {
  /** @type {{id: string, title: string, updatedAt: string, messageCount: number}[]} */
  conversations: [],
  /** @type {{id: string, title: string, messages: {role: string, content: string}[]} | null} */
  conversation: null,
  mode: 'local',
  busy: false,
};

/* ------------------------------------------------------------------ helpers */

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function api(path, { method = 'GET', body } = {}) {
  /** @type {RequestInit} */
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

/** @param {string} text */
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

/**
 * Minimal, escape-first Markdown renderer: code fences, headings, lists,
 * quotes, bold/italic, inline code and links.
 * @param {string} markdown
 * @returns {string}
 */
function renderMarkdown(markdown) {
  /** @type {{lang: string, code: string}[]} */
  const codeBlocks = [];
  const withoutCode = String(markdown ?? '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const inline = (text) =>
    text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  /** @type {string[]} */
  const output = [];
  /** @type {'ul' | 'ol' | null} */
  let list = null;
  const closeList = () => {
    if (list) {
      output.push(`</${list}>`);
      list = null;
    }
  };

  for (const rawLine of escapeHtml(withoutCode).split('\n')) {
    const codeMatch = rawLine.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      closeList();
      const block = codeBlocks[Number(codeMatch[1])];
      const language = block.lang ? ` data-lang="${block.lang}"` : '';
      output.push(`<pre${language}><code>${escapeHtml(block.code.replace(/\n$/, ''))}</code></pre>`);
      continue;
    }

    const heading = rawLine.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = rawLine.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') {
        closeList();
        output.push('<ul>');
        list = 'ul';
      }
      output.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const ordered = rawLine.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (list !== 'ol') {
        closeList();
        output.push('<ol>');
        list = 'ol';
      }
      output.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    const quote = rawLine.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      output.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    if (!rawLine.trim()) {
      closeList();
      continue;
    }

    closeList();
    output.push(`<p>${inline(rawLine)}</p>`);
  }
  closeList();

  return output.join('\n');
}

/** @param {string} iso */
function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** @param {string} iso */
function groupLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '更早';
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = startOfToday.getTime() - date.getTime();
  if (diff <= 0) return '今天';
  if (diff <= dayMs) return '昨天';
  if (diff <= 7 * dayMs) return '最近 7 天';
  return '更早';
}

function isNearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
}

/** @param {boolean} [force] */
function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

/** @param {boolean} open */
function setSidebar(open) {
  els.app.classList.toggle('sidebar-open', open);
  els.scrim.hidden = !open;
}

/* --------------------------------------------------------------- rendering */

function renderSidebar() {
  els.list.replaceChildren();

  if (state.conversations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'group-label';
    empty.textContent = '还没有对话，点击上方「新建对话」开始。';
    els.list.append(empty);
    return;
  }

  let currentGroup = '';
  for (const conversation of state.conversations) {
    const label = groupLabel(conversation.updatedAt);
    if (label !== currentGroup) {
      currentGroup = label;
      const heading = document.createElement('div');
      heading.className = 'group-label';
      heading.textContent = label;
      els.list.append(heading);
    }

    const row = document.createElement('div');
    row.className = `conv${conversation.id === state.conversation?.id ? ' active' : ''}`;
    row.dataset.id = conversation.id;
    row.title = `${conversation.title}\n${formatTime(conversation.updatedAt)}`;

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conversation.title;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'conv-del';
    remove.dataset.action = 'delete';
    remove.dataset.id = conversation.id;
    remove.title = '删除这个对话';
    remove.setAttribute('aria-label', `删除对话：${conversation.title}`);
    remove.textContent = '🗑';

    row.append(title, remove);
    els.list.append(row);
  }
}

function setView(view) {
  const showWelcome = view === 'welcome';
  els.welcome.hidden = !showWelcome;
  els.messages.hidden = showWelcome;
}

function updateHeader() {
  els.chatTitle.textContent = state.conversation?.title ?? '新对话';
  const hasConversation = Boolean(state.conversation);
  els.renameChat.disabled = !hasConversation;
  els.deleteChat.disabled = !hasConversation;
  els.renameChat.style.opacity = hasConversation ? '1' : '0.4';
  els.deleteChat.style.opacity = hasConversation ? '1' : '0.4';
}

/** @param {'user' | 'assistant'} role @param {string} content */
function appendMessageElement(role, content) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${role}`;

  if (role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    wrapper.append(bubble);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '✳';
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = renderMarkdown(content);
    wrapper.append(avatar, body);
  }

  els.messagesInner.append(wrapper);
  return wrapper;
}

function renderMessages() {
  els.messagesInner.replaceChildren();
  const messages = state.conversation?.messages ?? [];
  if (messages.length === 0) {
    setView('welcome');
    return;
  }
  for (const message of messages) appendMessageElement(message.role, message.content);
  setView('chat');
  scrollToBottom(true);
}

/* ----------------------------------------------------------------- actions */

async function refreshConversations() {
  const payload = await api('/api/conversations');
  state.conversations = payload.conversations ?? [];
  renderSidebar();
  // Keep the header in sync if the active conversation was renamed elsewhere.
  const active = state.conversations.find((item) => item.id === state.conversation?.id);
  if (active && state.conversation) {
    state.conversation.title = active.title;
    updateHeader();
  }
}

async function openConversation(id) {
  state.conversation = await api(`/api/conversations/${id}`).then((payload) => payload.conversation);
  renderMessages();
  updateHeader();
  renderSidebar();
  setSidebar(false);
  focusInput();
}

/**
 * Create a new conversation, reusing the current one when it is still empty.
 * @returns {Promise<object>}
 */
async function createConversation() {
  if (state.conversation && state.conversation.messages.length === 0) {
    focusInput();
    return state.conversation;
  }
  const payload = await api('/api/conversations', { method: 'POST', body: {} });
  state.conversation = payload.conversation;
  state.conversations = payload.conversations ?? state.conversations;
  renderMessages();
  updateHeader();
  renderSidebar();
  setSidebar(false);
  focusInput();
  return state.conversation;
}

/** @param {string} id */
async function deleteConversation(id) {
  const target = state.conversations.find((item) => item.id === id);
  const name = target?.title ?? '这个对话';
  if (!window.confirm(`确定删除「${name}」吗？该操作不可撤销。`)) return;

  const payload = await api(`/api/conversations/${id}`, { method: 'DELETE' });
  state.conversations = payload.conversations ?? [];
  if (state.conversation?.id === id) {
    state.conversation = null;
    els.messagesInner.replaceChildren();
  }
  const next = state.conversations[0];
  if (next) {
    await openConversation(next.id);
  } else {
    setView('welcome');
    updateHeader();
    renderSidebar();
  }
  focusInput();
}

async function clearAllConversations() {
  if (state.conversations.length === 0) return;
  if (!window.confirm(`确定删除全部 ${state.conversations.length} 个对话吗？该操作不可撤销。`)) return;
  await api('/api/conversations', { method: 'DELETE' });
  state.conversation = null;
  state.conversations = [];
  els.messagesInner.replaceChildren();
  setView('welcome');
  updateHeader();
  renderSidebar();
  focusInput();
}

function startRename() {
  if (!state.conversation) return;
  els.titleInput.value = state.conversation.title;
  els.chatTitle.hidden = true;
  els.titleInput.hidden = false;
  els.titleInput.focus();
  els.titleInput.select();
}

async function commitRename(save) {
  const input = els.titleInput;
  if (input.hidden) return;
  const value = input.value.trim();
  input.hidden = true;
  els.chatTitle.hidden = false;
  if (!save || !value || !state.conversation) return;
  const payload = await api(`/api/conversations/${state.conversation.id}`, {
    method: 'PATCH',
    body: { title: value },
  });
  state.conversation.title = payload.conversation.title;
  state.conversations = payload.conversations ?? state.conversations;
  updateHeader();
  renderSidebar();
}

function focusInput() {
  if (window.matchMedia('(min-width: 761px)').matches) els.input.focus();
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy || els.input.value.trim() === '';
  els.input.disabled = busy;
}

/**
 * Read a `text/event-stream` response and dispatch each event.
 * @param {Response} response
 * @param {(event: any) => void} onEvent
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

/** @param {string} text */
async function sendMessage(text) {
  const content = text.trim();
  if (!content || state.busy) return;

  if (!state.conversation) await createConversation();

  els.input.value = '';
  resizeInput();
  setBusy(true);
  setView('chat');
  appendMessageElement('user', content);
  scrollToBottom(true);

  const wrapper = appendMessageElement('assistant', '');
  const body = wrapper.querySelector('.body');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  scrollToBottom(true);

  let answer = '';
  let failed = false;

  try {
    const response = await fetch(`/api/conversations/${state.conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, stream: true }),
    });

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    }

    await readEventStream(response, (event) => {
      if (event.type === 'delta') {
        answer += event.text;
        body.innerHTML = renderMarkdown(answer);
        scrollToBottom();
      } else if (event.type === 'done') {
        state.conversation = event.conversation;
        state.conversations = event.conversations ?? state.conversations;
        answer = event.assistantMessage?.content ?? answer;
        body.innerHTML = renderMarkdown(answer);
        scrollToBottom();
      } else if (event.type === 'error') {
        failed = true;
        answer += `\n\n${event.message}`;
        body.innerHTML = renderMarkdown(answer);
      }
    });
  } catch (error) {
    failed = true;
    const notice = document.createElement('p');
    notice.className = 'msg-error';
    notice.textContent = `发送失败：${error.message}`;
    body.replaceChildren(notice);
  } finally {
    if (!failed && !answer.trim()) {
      body.innerHTML = renderMarkdown('（模型没有返回任何内容）');
    }
    setBusy(false);
    resizeInput();
    els.input.focus();
    await refreshConversations().catch(() => {});
  }
}

function resizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  els.send.disabled = state.busy || els.input.value.trim() === '';
}

/* ------------------------------------------------------------------- events */

els.newChat.addEventListener('click', () => {
  createConversation().catch((error) => window.alert(error.message));
});

els.list.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const deleteButton = target.closest('[data-action="delete"]');
  if (deleteButton) {
    event.stopPropagation();
    const id = /** @type {HTMLElement} */ (deleteButton).dataset.id;
    if (id) deleteConversation(id).catch((error) => window.alert(error.message));
    return;
  }
  const row = target.closest('.conv');
  const id = /** @type {HTMLElement | null} */ (row)?.dataset.id;
  if (id) openConversation(id).catch((error) => window.alert(error.message));
});

els.clearAll.addEventListener('click', () => {
  clearAllConversations().catch((error) => window.alert(error.message));
});

els.deleteChat.addEventListener('click', () => {
  if (state.conversation) {
    deleteConversation(state.conversation.id).catch((error) => window.alert(error.message));
  }
});

els.renameChat.addEventListener('click', () => startRename());

els.titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitRename(true).catch((error) => window.alert(error.message));
  } else if (event.key === 'Escape') {
    event.preventDefault();
    commitRename(false);
  }
});
els.titleInput.addEventListener('blur', () => {
  commitRename(true).catch(() => {});
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(els.input.value).catch((error) => window.alert(error.message));
});

els.input.addEventListener('input', resizeInput);
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.suggestions.addEventListener('click', (event) => {
  const button = /** @type {HTMLElement} */ (event.target).closest('button[data-prompt]');
  if (button) sendMessage(button.dataset.prompt ?? '').catch((error) => window.alert(error.message));
});

els.toggleSidebar.addEventListener('click', () => setSidebar(!els.app.classList.contains('sidebar-open')));
els.scrim.addEventListener('click', () => setSidebar(false));

/* --------------------------------------------------------------------- boot */

async function boot() {
  try {
    const health = await api('/api/health');
    state.mode = health.assistant?.mode ?? 'local';
    els.modeBadge.textContent =
      health.assistant?.label ?? (state.mode === 'deepseek' ? 'DeepSeek API 已接入' : '本地演示模式');
    els.hint.textContent =
      health.assistant?.hint ??
      (state.mode === 'deepseek' ? '回复由 DeepSeek API 实时生成' : '回复由本地规则模拟生成');
  } catch {
    els.modeBadge.textContent = '无法连接服务';
  }

  await refreshConversations();
  if (state.conversations.length > 0) {
    await openConversation(state.conversations[0].id);
  } else {
    setView('welcome');
    updateHeader();
  }
  resizeInput();
  focusInput();
}

boot().catch((error) => {
  els.hint.textContent = `初始化失败：${error.message}`;
});
