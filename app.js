// app.js — StudyHelper PWA logic. Talks to a local Ollama server only. No other network calls.

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

const el = (id) => document.getElementById(id);
const qs = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const state = {
  currentChatId: null,
  attachedDocIds: new Set(),
  editingNoteId: null,
  subjectFilter: '',
  encryptModalMode: 'setup',
  pendingAppEntry: false,
  pendingDisable: false,
  settings: {
    host: localStorage.getItem('sh_host') || 'http://localhost:11434',
    model: localStorage.getItem('sh_model') || 'gemma4:e2b',
  },
};

// ===================== SANITISATION / MARKDOWN =====================
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Inline formatting only (bold/italic/code) — input must already be escaped.
function renderInline(escaped) {
  let t = escaped;
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return t;
}
// Safe helper for short strings (flashcard/quiz text): escape then inline-format.
function mdInline(text) { return renderInline(escapeHtml(text || '')); }

// Full block-level markdown renderer for chat bubbles. Escapes everything
// first, so model output can never inject HTML — only our own generated tags.
function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let inCode = false, codeBuf = [], codeLang = '';
  let listType = null;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      html += `<p>${renderInline(escapeHtml(paraBuf.join(' ')))}</p>`;
      paraBuf = [];
    }
  };
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (!inCode) { flushPara(); closeList(); inCode = true; codeLang = fence[1] || ''; codeBuf = []; }
      else { html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`; inCode = false; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lvl = Math.min(6, h[1].length + 3); html += `<h${lvl}>${renderInline(escapeHtml(h[2]))}</h${lvl}>`; i++; continue; }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushPara(); closeList(); html += `<blockquote>${renderInline(escapeHtml(bq[1]))}</blockquote>`; i++; continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${renderInline(escapeHtml(ol[1]))}</li>`;
      i++; continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${renderInline(escapeHtml(ul[1]))}</li>`;
      i++; continue;
    }

    closeList();
    paraBuf.push(line.trim());
    i++;
  }
  flushPara(); closeList();
  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  return html || `<p>${renderInline(escapeHtml(raw))}</p>`;
}

// ===================== THEME =====================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sh_theme', theme);
  const label = el('theme-toggle-label');
  if (label) label.textContent = theme === 'dark' ? 'Day mode' : 'Night mode';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(cur);
}
(function initTheme() {
  const saved = localStorage.getItem('sh_theme');
  const preferred = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(preferred);
})();
document.addEventListener('DOMContentLoaded', () => {
  const a = el('theme-toggle-landing'); if (a) a.onclick = toggleTheme;
  const b = el('theme-toggle-app'); if (b) b.onclick = toggleTheme;
});

// ===================== VIEW SWITCHING =====================
function showLanding() {
  el('app-view').classList.add('hidden');
  el('landing-view').classList.remove('hidden');
}
async function requestOpenApp() {
  if (DB.Crypto.enabled() && !DB.Crypto.hasKey()) {
    state.pendingAppEntry = true;
    openEncryptModal('unlock');
    return;
  }
  await enterApp();
}
async function enterApp() {
  el('landing-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  await populateSubjectSelects();
  if (!state.currentChatId) await startNewChat();
  checkConnection();
  updateEncStatusUI();
  refreshHistoryTab();
  refreshDocumentsTab();
  refreshNotesTab();
  refreshFlashcardsTab();
  refreshQuizzesTab();
  refreshSubjectsTab();
}
el('btn-getstarted').onclick = requestOpenApp;
el('btn-start-free').onclick = requestOpenApp;
el('btn-back-landing').onclick = showLanding;

// tab switching inside app
qsa('.demo-nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});
function switchTab(tab) {
  qsa('.demo-nav-item[data-tab]').forEach(i => i.classList.toggle('active', i.dataset.tab === tab));
  ['home', 'subjects', 'notes', 'documents', 'flashcards', 'quizzes', 'history'].forEach(t => {
    const paneId = t === 'home' ? 'tab-home' : `tab-${t}`;
    const paneEl = el(paneId);
    if (paneEl) paneEl.classList.toggle('hidden', t !== tab);
  });
  const titles = { home: 'Today', subjects: 'Subjects', notes: 'Notes', documents: 'Documents', flashcards: 'Flashcards', quizzes: 'Quizzes', history: 'History' };
  el('tab-title').textContent = titles[tab] || 'Today';
  if (tab === 'history') refreshHistoryTab();
  if (tab === 'documents') refreshDocumentsTab();
  if (tab === 'notes') refreshNotesTab();
  if (tab === 'flashcards') refreshFlashcardsTab();
  if (tab === 'quizzes') refreshQuizzesTab();
  if (tab === 'subjects') refreshSubjectsTab();
}

el('global-subject-filter').addEventListener('change', (e) => {
  state.subjectFilter = e.target.value;
  refreshDocumentsTab(); refreshNotesTab(); refreshFlashcardsTab(); refreshQuizzesTab(); refreshHistoryTab();
});

// ===================== CONNECTION CHECK =====================
async function checkConnection() {
  const dot = qs('#conn-status .conn-dot');
  const text = el('conn-text');
  try {
    const res = await fetch(state.settings.host.replace(/\/$/, '') + '/api/tags');
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    const names = (data.models || []).map(m => m.name);
    dot.className = 'conn-dot ok';
    const hasModel = names.some(n => n.startsWith(state.settings.model));
    text.textContent = hasModel ? `Connected · ${state.settings.model}` : `Connected · "${state.settings.model}" not pulled`;
  } catch (e) {
    dot.className = 'conn-dot err';
    text.textContent = 'Ollama not reachable';
  }
}

// ===================== SETTINGS MODAL =====================
el('btn-settings').onclick = () => {
  el('setting-host').value = state.settings.host;
  el('setting-model').value = state.settings.model;
  el('setting-encryption-toggle').checked = DB.Crypto.enabled();
  el('settings-modal').classList.remove('hidden');
};
el('btn-settings-cancel').onclick = () => el('settings-modal').classList.add('hidden');
el('btn-settings-save').onclick = () => {
  state.settings.host = el('setting-host').value.trim() || 'http://localhost:11434';
  state.settings.model = el('setting-model').value.trim() || 'gemma4:e2b';
  localStorage.setItem('sh_host', state.settings.host);
  localStorage.setItem('sh_model', state.settings.model);
  el('settings-modal').classList.add('hidden');
  checkConnection();
};

el('btn-clear-data').onclick = async () => {
  if (!confirm('This deletes ALL chats, documents, notes, subjects, flashcards, and quizzes stored on this device. This cannot be undone. Continue?')) return;
  await DB.clearAll();
  state.attachedDocIds.clear();
  el('settings-modal').classList.add('hidden');
  await populateSubjectSelects();
  startNewChat();
  refreshHistoryTab();
  refreshDocumentsTab();
  refreshNotesTab();
  refreshFlashcardsTab();
  refreshQuizzesTab();
  refreshSubjectsTab();
};

// ===================== ENCRYPTION UI =====================
function updateEncStatusUI() {
  const wrap = el('enc-status');
  if (!wrap) return;
  if (!DB.Crypto.enabled()) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  el('enc-status-text').textContent = DB.Crypto.hasKey() ? 'Encrypted · unlocked' : 'Encrypted · locked';
}
function openEncryptModal(mode) {
  state.encryptModalMode = mode;
  el('encrypt-modal-title').textContent = mode === 'setup' ? 'Set an encryption passphrase' : 'Unlock your data';
  el('encrypt-modal-hint').textContent = mode === 'setup'
    ? "Choose a passphrase used to encrypt your local data on this device. It's never stored anywhere — write it down somewhere safe. Minimum 6 characters."
    : 'Enter your passphrase to decrypt your local data for this session.';
  el('encrypt-pass-2-wrap').classList.toggle('hidden', mode !== 'setup');
  el('encrypt-pass-1').value = '';
  el('encrypt-pass-2').value = '';
  el('encrypt-error').classList.add('hidden');
  el('encrypt-modal').classList.remove('hidden');
  el('encrypt-pass-1').focus();
}
function encryptError(msg) {
  const e = el('encrypt-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}
el('btn-encrypt-cancel').onclick = () => {
  el('encrypt-modal').classList.add('hidden');
  if (state.encryptModalMode === 'setup') el('setting-encryption-toggle').checked = false;
  state.pendingAppEntry = false;
  state.pendingDisable = false;
};
el('btn-encrypt-confirm').onclick = async () => {
  const p1 = el('encrypt-pass-1').value;
  const p2 = el('encrypt-pass-2').value;
  if (state.encryptModalMode === 'setup') {
    if (p1.length < 6) return encryptError('Passphrase must be at least 6 characters.');
    if (p1 !== p2) return encryptError('Passphrases do not match.');
    await DB.Crypto.setup(p1);
    await migrateEncryptExisting();
    el('encrypt-modal').classList.add('hidden');
    updateEncStatusUI();
  } else {
    const ok = await DB.Crypto.unlock(p1);
    if (!ok) return encryptError('Incorrect passphrase.');
    el('encrypt-modal').classList.add('hidden');
    updateEncStatusUI();
    if (state.pendingDisable) {
      state.pendingDisable = false;
      await performDisableEncryption();
    }
    if (state.pendingAppEntry) {
      state.pendingAppEntry = false;
      await enterApp();
    } else {
      // refresh open tabs so decrypted content shows
      refreshHistoryTab(); refreshDocumentsTab(); refreshNotesTab(); refreshFlashcardsTab(); refreshQuizzesTab();
      if (state.currentChatId) openChat(state.currentChatId);
    }
  }
};
async function migrateEncryptExisting() {
  const stores = ['documents', 'notes', 'messages', 'flashcardSets', 'quizSets'];
  for (const s of stores) {
    const items = await DB.all(s);
    for (const item of items) await DB.put(s, item);
  }
}
async function performDisableEncryption() {
  const stores = ['documents', 'notes', 'messages', 'flashcardSets', 'quizSets'];
  const cache = {};
  for (const s of stores) cache[s] = await DB.all(s);
  await DB.Crypto.disable();
  for (const s of stores) for (const item of cache[s]) await DB.put(s, item);
  updateEncStatusUI();
  refreshHistoryTab(); refreshDocumentsTab(); refreshNotesTab(); refreshFlashcardsTab(); refreshQuizzesTab();
}
el('setting-encryption-toggle').addEventListener('change', async (e) => {
  const turnOn = e.target.checked;
  if (turnOn) {
    openEncryptModal('setup');
  } else {
    e.target.checked = true; // stays checked until we confirm the passphrase
    if (!DB.Crypto.hasKey()) {
      state.pendingDisable = true;
      openEncryptModal('unlock');
    } else {
      await performDisableEncryption();
      e.target.checked = false;
    }
  }
});
el('btn-lock-now').onclick = () => {
  DB.Crypto.lock();
  updateEncStatusUI();
  showLanding();
};

// ===================== SUBJECTS =====================
async function populateSubjectSelects() {
  const subjects = await DB.listSubjects();
  const selects = qsa('#chat-subject, #note-subject, #fc-subject, #qz-subject, #global-subject-filter');
  selects.forEach(sel => {
    const isFilter = sel.id === 'global-subject-filter';
    const prev = sel.value;
    sel.innerHTML = `<option value="">${isFilter ? 'All subjects' : 'No subject'}</option>`;
    subjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
    if (qs(`option[value="${prev}"]`, sel)) sel.value = prev;
  });
}
function subjectBadge(subjectId, subjectsById) {
  const s = subjectsById[subjectId];
  if (!s) return '';
  return `<span class="subject-tag" style="--tag-color:${escapeHtml(s.color)}">${escapeHtml(s.name)}</span>`;
}
async function subjectsIndex() {
  const subjects = await DB.listSubjects();
  const map = {};
  subjects.forEach(s => map[s.id] = s);
  return map;
}

el('btn-subj-add').onclick = async () => {
  const name = el('subj-name').value.trim();
  if (!name) return;
  const color = el('subj-color').value || '#2563eb';
  await DB.createSubject(name, color);
  el('subj-name').value = '';
  await populateSubjectSelects();
  refreshSubjectsTab();
};

async function refreshSubjectsTab() {
  const list = el('subject-list');
  if (!list) return;
  const subjects = await DB.listSubjects();
  if (subjects.length === 0) { list.innerHTML = '<p class="empty-hint">No subjects yet. Add one above.</p>'; return; }
  list.innerHTML = '';
  const [chats, docs, notes, fcSets, qzSets] = await Promise.all([
    DB.listChats(), DB.listDocuments(), DB.listNotes(), DB.listFlashcardSets(), DB.listQuizSets(),
  ]);
  subjects.forEach(s => {
    const count = [chats, docs, notes, fcSets, qzSets].reduce((n, arr) => n + arr.filter(x => x.subjectId === s.id).length, 0);
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="meta">
        <strong><span class="subject-dot" style="background:${escapeHtml(s.color)}"></span>${escapeHtml(s.name)}</strong>
        <span>${count} item${count === 1 ? '' : 's'} tagged</span>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-ghost btn-sm';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = async () => {
      const newName = prompt('Rename subject', s.name);
      if (newName && newName.trim()) {
        await DB.renameSubject(s.id, newName.trim(), s.color);
        await populateSubjectSelects();
        refreshSubjectsTab();
      }
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      if (!confirm(`Delete subject "${s.name}"? Items tagged with it will become untagged (not deleted).`)) return;
      await DB.deleteSubject(s.id);
      await populateSubjectSelects();
      refreshSubjectsTab();
      refreshDocumentsTab(); refreshNotesTab(); refreshFlashcardsTab(); refreshQuizzesTab(); refreshHistoryTab();
    };
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

// ===================== CHAT =====================
async function startNewChat() {
  const chat = await DB.createChat('New chat', state.subjectFilter || null);
  state.currentChatId = chat.id;
  state.attachedDocIds.clear();
  renderAttachments();
  el('chat-subject').value = chat.subjectId || '';
  el('chat-scroll').innerHTML = '';
  el('chat-scroll').appendChild(makeEmptyState());
  switchTab('home');
}
function makeEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.id = 'empty-state';
  div.innerHTML = `<span class="spark big">✦</span><h2>Ask me anything</h2><p>I run entirely offline on this device via Ollama + Gemma. No internet required once a model is pulled.</p>`;
  return div;
}
el('btn-newchat').onclick = startNewChat;
el('chat-subject').addEventListener('change', async (e) => {
  if (!state.currentChatId) return;
  await DB.setChatSubject(state.currentChatId, e.target.value || null);
});

async function openChat(chatId) {
  state.currentChatId = chatId;
  state.attachedDocIds.clear();
  renderAttachments();
  const scroll = el('chat-scroll');
  scroll.innerHTML = '';
  const chat = await DB.get('chats', chatId);
  el('chat-subject').value = (chat && chat.subjectId) || '';
  const msgs = await DB.listMessages(chatId);
  if (msgs.length === 0) {
    scroll.appendChild(makeEmptyState());
  } else {
    msgs.forEach(m => appendMessageBubble(m.role, m.content, m.id));
  }
  switchTab('home');
}

function appendMessageBubble(role, content, dbId) {
  const scroll = el('chat-scroll');
  const empty = el('empty-state');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  wrap.dataset.dbId = dbId || '';
  const textEl = document.createElement('div');
  textEl.className = 'msg-text md-content';
  if (role === 'user') {
    textEl.textContent = content;
  } else {
    textEl.innerHTML = renderMarkdown(content);
  }
  wrap.appendChild(textEl);
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-icon';
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete message';
  delBtn.onclick = async () => {
    if (wrap.dataset.dbId) await DB.delete('messages', wrap.dataset.dbId);
    wrap.remove();
  };
  actions.appendChild(delBtn);
  wrap.appendChild(actions);
  scroll.appendChild(wrap);
  scroll.scrollTop = scroll.scrollHeight;
  return wrap;
}

async function sendMessage() {
  const input = el('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  el('btn-send').disabled = true;

  const userMsg = await DB.addMessage(state.currentChatId, 'user', text);
  appendMessageBubble('user', text, userMsg.id);

  let contextBlock = '';
  if (state.attachedDocIds.size > 0) {
    const docs = await DB.listDocuments();
    const attached = docs.filter(d => state.attachedDocIds.has(d.id));
    contextBlock = attached.map(d => `--- Document: ${d.name} ---\n${d.text.slice(0, 12000)}`).join('\n\n');
  }

  const history = await DB.listMessages(state.currentChatId);
  const messages = [];
  if (contextBlock) {
    messages.push({ role: 'system', content: `Use the following document content as context when relevant to the user's question:\n\n${contextBlock}` });
  } else {
    messages.push({ role: 'system', content: 'You are StudyHelper, a concise, friendly study assistant. Explain clearly, use step-by-step reasoning for problems, use markdown (headings, **bold**, lists, code blocks) where it improves clarity, and keep answers focused.' });
  }
  history.forEach(m => messages.push({ role: m.role, content: m.content }));

  const chat = await DB.get('chats', state.currentChatId);
  if (chat && chat.title === 'New chat') {
    await DB.renameChat(state.currentChatId, text.slice(0, 48));
  }

  const botWrap = appendMessageBubble('bot', '', null);
  botWrap.classList.add('streaming');
  const botTextEl = qs('.msg-text', botWrap);

  let fullText = '';
  try {
    const res = await fetch(state.settings.host.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: state.settings.model, messages, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error('Request failed: ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message && chunk.message.content) {
            fullText += chunk.message.content;
            botTextEl.innerHTML = renderMarkdown(fullText);
            el('chat-scroll').scrollTop = el('chat-scroll').scrollHeight;
          }
        } catch (_) { /* ignore partial line */ }
      }
    }
  } catch (err) {
    fullText = `⚠ Couldn't reach Ollama at ${state.settings.host}. Make sure "ollama serve" is running and the model is pulled (ollama pull ${state.settings.model}). Check Settings to change the host.`;
    botTextEl.innerHTML = renderMarkdown(fullText);
  }

  botWrap.classList.remove('streaming');
  const savedMsg = await DB.addMessage(state.currentChatId, 'assistant', fullText);
  botWrap.dataset.dbId = savedMsg.id;
  el('btn-send').disabled = false;
  input.focus();
}
el('btn-send').onclick = sendMessage;
el('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ---- attach documents to chat ----
el('btn-attach').onclick = async () => {
  const picker = el('attach-picker');
  if (!picker.classList.contains('hidden')) { picker.classList.add('hidden'); return; }
  const docs = await DB.listDocuments();
  picker.innerHTML = '';
  if (docs.length === 0) {
    picker.innerHTML = '<p class="empty-hint" style="padding:10px 12px;">No documents uploaded yet. Go to the Documents tab to add some.</p>';
  } else {
    docs.forEach(d => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.attachedDocIds.has(d.id);
      cb.onchange = () => {
        if (cb.checked) state.attachedDocIds.add(d.id); else state.attachedDocIds.delete(d.id);
        renderAttachments();
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(d.name));
      picker.appendChild(label);
    });
  }
  picker.classList.remove('hidden');
};
async function renderAttachments() {
  const wrap = el('chat-attachments');
  if (state.attachedDocIds.size === 0) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  const docs = await DB.listDocuments();
  wrap.innerHTML = '';
  docs.filter(d => state.attachedDocIds.has(d.id)).forEach(d => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `<span>📄 ${escapeHtml(d.name)}</span>`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.onclick = () => { state.attachedDocIds.delete(d.id); renderAttachments(); };
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
  wrap.classList.remove('hidden');
}

// ===================== DOCUMENTS =====================
el('doc-upload').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) { alert(`${file.name} is larger than 25MB — skipped.`); continue; }
    try {
      const text = await extractText(file);
      await DB.addDocument({ name: file.name, type: file.type || file.name.split('.').pop(), size: file.size, text, subjectId: state.subjectFilter || null });
    } catch (err) {
      alert(`Couldn't read ${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
  refreshDocumentsTab();
});

async function extractText(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf')) {
    const buf = await file.arrayBuffer();
    if (!window.pdfjsLib) throw new Error('PDF engine not loaded');
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n\n';
    }
    return text.trim();
  }
  return await file.text();
}

async function refreshDocumentsTab() {
  const list = el('doc-list');
  let docs = await DB.listDocuments();
  const subjectsById = await subjectsIndex();
  const select = el('fc-source');
  const qzSelect = el('qz-source');
  const prevVal = select.value;
  const prevQzVal = qzSelect.value;
  select.innerHTML = '<option value="">No source — use topic only</option>';
  qzSelect.innerHTML = '<option value="">No source — use topic only</option>';
  docs.forEach(d => {
    const opt = document.createElement('option');
    opt.value = 'doc:' + d.id;
    opt.textContent = '📄 ' + d.name;
    select.appendChild(opt.cloneNode(true));
    qzSelect.appendChild(opt);
  });
  if (qs(`option[value="${prevVal}"]`, select)) select.value = prevVal;
  if (qs(`option[value="${prevQzVal}"]`, qzSelect)) qzSelect.value = prevQzVal;

  if (state.subjectFilter) docs = docs.filter(d => d.subjectId === state.subjectFilter);
  if (docs.length === 0) { list.innerHTML = '<p class="empty-hint">No documents yet. Upload a .txt, .md, or .pdf to get started.</p>'; return; }
  list.innerHTML = '';
  docs.forEach(d => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(d.name)} ${subjectBadge(d.subjectId, subjectsById)}</strong>
        <span>${formatBytes(d.size)} · ${new Date(d.createdAt).toLocaleString()} · ${(d.text || '').length.toLocaleString()} chars extracted</span>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      if (!confirm(`Delete "${d.name}"?`)) return;
      await DB.deleteDocument(d.id);
      state.attachedDocIds.delete(d.id);
      refreshDocumentsTab();
      renderAttachments();
    };
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ===================== NOTES =====================
el('btn-new-note').onclick = () => {
  state.editingNoteId = null;
  el('note-title').value = '';
  el('note-content').value = '';
  el('note-subject').value = state.subjectFilter || '';
  el('note-editor').classList.remove('hidden');
  el('note-title').focus();
};
el('btn-note-cancel').onclick = () => el('note-editor').classList.add('hidden');
el('btn-note-save').onclick = async () => {
  const title = el('note-title').value.trim() || 'Untitled note';
  const content = el('note-content').value.trim();
  const subjectId = el('note-subject').value || null;
  if (state.editingNoteId) {
    await DB.updateNote(state.editingNoteId, title, content, subjectId);
  } else {
    await DB.addNote(title, content, subjectId);
  }
  el('note-editor').classList.add('hidden');
  state.editingNoteId = null;
  refreshNotesTab();
};

async function refreshNotesTab() {
  const list = el('note-list');
  let notes = await DB.listNotes();
  const subjectsById = await subjectsIndex();
  const select = el('fc-source');
  notes.forEach(n => {
    if (!qs(`option[value="note:${n.id}"]`, select)) {
      const opt = document.createElement('option');
      opt.value = 'note:' + n.id;
      opt.textContent = '📝 ' + n.title;
      select.appendChild(opt);
      const opt2 = opt.cloneNode(true);
      const qzSelect = el('qz-source');
      if (qzSelect && !qs(`option[value="note:${n.id}"]`, qzSelect)) qzSelect.appendChild(opt2);
    }
  });

  if (state.subjectFilter) notes = notes.filter(n => n.subjectId === state.subjectFilter);
  if (notes.length === 0) { list.innerHTML = '<p class="empty-hint">No notes yet.</p>'; return; }
  list.innerHTML = '';
  notes.forEach(n => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(n.title)} ${subjectBadge(n.subjectId, subjectsById)}</strong>
        <span>Updated ${new Date(n.updatedAt).toLocaleString()}</span>
        <p>${escapeHtml((n.content || '').slice(0, 200))}${(n.content || '').length > 200 ? '…' : ''}</p>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      state.editingNoteId = n.id;
      el('note-title').value = n.title;
      el('note-content').value = n.content;
      el('note-subject').value = n.subjectId || '';
      el('note-editor').classList.remove('hidden');
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      if (!confirm(`Delete note "${n.title}"?`)) return;
      await DB.deleteNote(n.id);
      refreshNotesTab();
    };
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

// ===================== OLLAMA JSON GENERATION (shared, with retry) =====================
async function requestJsonFromOllama(initialMessages, { retries = 1 } = {}) {
  let messages = initialMessages;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(state.settings.host.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: state.settings.model, messages, stream: false }),
    });
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    const data = await res.json();
    let raw = (data.message && data.message.content) || '';
    raw = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const firstBracket = raw.indexOf('[');
    const lastBracket = raw.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) raw = raw.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (e) {
      lastErr = e;
      messages = [
        ...messages,
        { role: 'assistant', content: raw.slice(0, 2000) },
        { role: 'user', content: 'That was not valid JSON. Respond again with ONLY the raw JSON array — no markdown fences, no commentary, no trailing text.' },
      ];
    }
  }
  throw new Error('Model did not return valid JSON after retrying: ' + (lastErr ? lastErr.message : ''));
}

async function resolveSourceText(sourceVal) {
  if (!sourceVal) return { sourceText: '', sourceLabel: null };
  const [kind, id] = sourceVal.split(':');
  if (kind === 'doc') {
    const doc = await DB.get('documents', id);
    if (doc) return { sourceText: (doc.text || '').slice(0, 12000), sourceLabel: doc.name };
  } else if (kind === 'note') {
    const note = await DB.get('notes', id);
    if (note) return { sourceText: note.content || '', sourceLabel: note.title };
  }
  return { sourceText: '', sourceLabel: null };
}

// ===================== FLASHCARDS =====================
el('btn-fc-generate').onclick = async () => {
  const topic = el('fc-topic').value.trim();
  const sourceVal = el('fc-source').value;
  const subjectId = el('fc-subject').value || null;
  const difficulty = el('fc-difficulty').value;
  const count = Math.min(20, Math.max(3, parseInt(el('fc-count').value, 10) || 6));
  if (!topic && !sourceVal) { alert('Enter a topic or choose a source document/note.'); return; }

  const { sourceText, sourceLabel } = await resolveSourceText(sourceVal);
  const finalLabel = topic || sourceLabel || 'Flashcards';

  const status = el('fc-status');
  status.classList.remove('hidden');
  status.textContent = 'Generating flashcards with ' + state.settings.model + '…';
  el('btn-fc-generate').disabled = true;

  const prompt = `Create exactly ${count} ${difficulty}-difficulty study flashcards ${topic ? `about "${topic}"` : ''} ${sourceText ? `based on this material:\n\n${sourceText}` : ''}.
Each flashcard question should be clear and specific; each answer should be concise (1-3 sentences) and factually correct.
Do not repeat similar questions. Respond with ONLY a raw JSON array, no markdown fences, no commentary, in this exact format:
[{"q": "question text", "a": "answer text"}, ...]`;

  try {
    const cards = await requestJsonFromOllama([
      { role: 'system', content: 'You output only valid JSON when asked to. No prose, no markdown fences.' },
      { role: 'user', content: prompt },
    ], { retries: 1 });

    if (!Array.isArray(cards) || cards.length === 0) throw new Error('Model did not return a card list');
    const cleaned = dedupeCards(cards.filter(c => c && typeof c.q === 'string' && typeof c.a === 'string' && c.q.trim() && c.a.trim())
      .map(c => ({ q: c.q.trim(), a: c.a.trim() })));
    if (cleaned.length === 0) throw new Error('Model returned no usable cards');

    await DB.addFlashcardSet(finalLabel, cleaned, sourceLabel, subjectId);
    status.textContent = `Generated ${cleaned.length} cards.`;
    el('fc-topic').value = '';
    refreshFlashcardsTab();
  } catch (err) {
    status.textContent = '⚠ Could not generate flashcards: ' + err.message + '. Make sure Ollama is running and the model is pulled.';
  } finally {
    el('btn-fc-generate').disabled = false;
  }
};
function dedupeCards(cards) {
  const seen = new Set();
  return cards.filter(c => {
    const key = c.q.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function refreshFlashcardsTab() {
  const container = el('fc-sets');
  let sets = await DB.listFlashcardSets();
  const subjectsById = await subjectsIndex();
  if (state.subjectFilter) sets = sets.filter(s => s.subjectId === state.subjectFilter);
  if (sets.length === 0) { container.innerHTML = '<p class="empty-hint">No flashcard sets yet. Generate one above.</p>'; return; }
  container.innerHTML = '';
  sets.forEach(set => {
    const box = document.createElement('div');
    box.className = 'fc-set';
    const head = document.createElement('div');
    head.className = 'fc-set-head';
    head.innerHTML = `<strong>${escapeHtml(set.title)} ${subjectBadge(set.subjectId, subjectsById)}</strong><span style="font-size:12px;color:var(--ink-soft);">${set.cards.length} cards · ${new Date(set.createdAt).toLocaleDateString()}</span>`;
    const delSetBtn = document.createElement('button');
    delSetBtn.className = 'btn btn-ghost btn-sm danger';
    delSetBtn.textContent = 'Delete set';
    delSetBtn.onclick = async () => {
      if (!confirm(`Delete flashcard set "${set.title}"?`)) return;
      await DB.deleteFlashcardSet(set.id);
      refreshFlashcardsTab();
    };
    head.appendChild(delSetBtn);
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'fc-grid';
    set.cards.forEach((card, idx) => {
      const flip = document.createElement('div');
      flip.className = 'flip-card';
      flip.innerHTML = `
        <div class="flip-card-inner">
          <div class="flip-card-face front md-content">${mdInline(card.q)}</div>
          <div class="flip-card-face back md-content">${mdInline(card.a)}</div>
        </div>
        <button class="btn-icon card-delete" title="Delete card">🗑</button>`;
      flip.addEventListener('click', (e) => {
        if (e.target.closest('.card-delete')) return;
        flip.classList.toggle('flipped');
      });
      qs('.card-delete', flip).onclick = async (e) => {
        e.stopPropagation();
        await DB.deleteFlashcard(set.id, idx);
        refreshFlashcardsTab();
      };
      grid.appendChild(flip);
    });
    box.appendChild(grid);
    container.appendChild(box);
  });
}

// ===================== QUIZZES =====================
el('btn-qz-generate').onclick = async () => {
  const topic = el('qz-topic').value.trim();
  const sourceVal = el('qz-source').value;
  const subjectId = el('qz-subject').value || null;
  const difficulty = el('qz-difficulty').value;
  const count = Math.min(20, Math.max(3, parseInt(el('qz-count').value, 10) || 8));
  if (!topic && !sourceVal) { alert('Enter a topic or choose a source document/note.'); return; }

  const { sourceText, sourceLabel } = await resolveSourceText(sourceVal);
  const finalLabel = topic || sourceLabel || 'Quiz';

  const status = el('qz-status');
  status.classList.remove('hidden');
  status.textContent = 'Generating quiz with ' + state.settings.model + '…';
  el('btn-qz-generate').disabled = true;

  const prompt = `Create exactly ${count} ${difficulty}-difficulty multiple-choice quiz questions ${topic ? `about "${topic}"` : ''} ${sourceText ? `based on this material:\n\n${sourceText}` : ''}.
Each question must have exactly 4 options, only one of which is correct. Include a short one-sentence explanation of the correct answer.
Do not repeat similar questions. Respond with ONLY a raw JSON array, no markdown fences, no commentary, in this exact format:
[{"q": "question text", "options": ["opt A", "opt B", "opt C", "opt D"], "correct": 0, "explanation": "why this is correct"}, ...]
"correct" is the zero-based index into "options".`;

  try {
    const questions = await requestJsonFromOllama([
      { role: 'system', content: 'You output only valid JSON when asked to. No prose, no markdown fences.' },
      { role: 'user', content: prompt },
    ], { retries: 1 });

    if (!Array.isArray(questions) || questions.length === 0) throw new Error('Model did not return a question list');
    const cleaned = dedupeCards(questions.filter(q =>
      q && typeof q.q === 'string' && q.q.trim() &&
      Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length
    ).map((q, i) => ({
      q: q.q.trim(),
      options: q.options.map(o => String(o).trim()),
      correct: q.correct,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
    })).map(q => ({ ...q, q: q.q }))); // keep dedupe by .q via shared helper (uses c.q)
    if (cleaned.length === 0) throw new Error('Model returned no usable questions');

    await DB.addQuizSet(finalLabel, cleaned, sourceLabel, subjectId);
    status.textContent = `Generated ${cleaned.length} questions.`;
    el('qz-topic').value = '';
    refreshQuizzesTab();
  } catch (err) {
    status.textContent = '⚠ Could not generate quiz: ' + err.message + '. Make sure Ollama is running and the model is pulled.';
  } finally {
    el('btn-qz-generate').disabled = false;
  }
};

async function refreshQuizzesTab() {
  const container = el('qz-sets');
  let sets = await DB.listQuizSets();
  const subjectsById = await subjectsIndex();
  if (state.subjectFilter) sets = sets.filter(s => s.subjectId === state.subjectFilter);
  if (sets.length === 0) { container.innerHTML = '<p class="empty-hint">No quizzes yet. Generate one above.</p>'; return; }
  container.innerHTML = '';
  sets.forEach(set => renderQuizSet(container, set, subjectsById));
}

function renderQuizSet(container, set, subjectsById) {
  const box = document.createElement('div');
  box.className = 'fc-set quiz-set';
  const bestAttempt = (set.attempts && set.attempts.length) ? set.attempts[set.attempts.length - 1] : null;
  const head = document.createElement('div');
  head.className = 'fc-set-head';
  head.innerHTML = `<strong>${escapeHtml(set.title)} ${subjectBadge(set.subjectId, subjectsById)}</strong>
    <span style="font-size:12px;color:var(--ink-soft);">${set.questions.length} questions${bestAttempt ? ` · last score ${bestAttempt.score}/${bestAttempt.total}` : ''}</span>`;
  const delSetBtn = document.createElement('button');
  delSetBtn.className = 'btn btn-ghost btn-sm danger';
  delSetBtn.textContent = 'Delete quiz';
  delSetBtn.onclick = async () => {
    if (!confirm(`Delete quiz "${set.title}"?`)) return;
    await DB.deleteQuizSet(set.id);
    refreshQuizzesTab();
  };
  head.appendChild(delSetBtn);
  box.appendChild(head);

  const form = document.createElement('div');
  form.className = 'quiz-form';
  set.questions.forEach((q, qIdx) => {
    const qWrap = document.createElement('div');
    qWrap.className = 'quiz-q';
    qWrap.dataset.correct = q.correct;
    const qTitle = document.createElement('div');
    qTitle.className = 'quiz-q-title md-content';
    qTitle.innerHTML = `${qIdx + 1}. ${mdInline(q.q)}`;
    qWrap.appendChild(qTitle);
    const opts = document.createElement('div');
    opts.className = 'quiz-options';
    q.options.forEach((opt, oIdx) => {
      const label = document.createElement('label');
      label.className = 'quiz-option';
      label.innerHTML = `<input type="radio" name="qz_${set.id}_${qIdx}" value="${oIdx}"> <span class="md-content">${mdInline(opt)}</span>`;
      opts.appendChild(label);
    });
    qWrap.appendChild(opts);
    if (q.explanation) {
      const exp = document.createElement('div');
      exp.className = 'quiz-explanation hidden md-content';
      exp.innerHTML = mdInline(q.explanation);
      qWrap.appendChild(exp);
    }
    form.appendChild(qWrap);
  });
  box.appendChild(form);

  const footer = document.createElement('div');
  footer.className = 'quiz-footer';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-dark btn-sm';
  submitBtn.textContent = 'Submit Quiz';
  const resultEl = document.createElement('span');
  resultEl.className = 'quiz-result';
  footer.appendChild(submitBtn);
  footer.appendChild(resultEl);
  box.appendChild(footer);

  submitBtn.onclick = async () => {
    let score = 0;
    const qEls = qsa('.quiz-q', form);
    qEls.forEach((qEl, qIdx) => {
      const correct = parseInt(qEl.dataset.correct, 10);
      const checked = qs(`input[name="qz_${set.id}_${qIdx}"]:checked`, qEl);
      const labels = qsa('.quiz-option', qEl);
      labels.forEach((label, oIdx) => {
        label.classList.remove('correct', 'incorrect');
        if (oIdx === correct) label.classList.add('correct');
        else if (checked && parseInt(checked.value, 10) === oIdx) label.classList.add('incorrect');
      });
      const exp = qs('.quiz-explanation', qEl);
      if (exp) exp.classList.remove('hidden');
      if (checked && parseInt(checked.value, 10) === correct) score++;
      qsa('input', qEl).forEach(i => i.disabled = true);
    });
    resultEl.textContent = `Score: ${score}/${qEls.length}`;
    submitBtn.textContent = 'Retake Quiz';
    submitBtn.onclick = () => refreshQuizzesTab();
    await DB.recordQuizAttempt(set.id, score, qEls.length);
  };

  container.appendChild(box);
}

// ===================== HISTORY =====================
async function refreshHistoryTab() {
  const list = el('history-list');
  let chats = await DB.listChats();
  const subjectsById = await subjectsIndex();
  if (state.subjectFilter) chats = chats.filter(c => c.subjectId === state.subjectFilter);
  if (chats.length === 0) { list.innerHTML = '<p class="empty-hint">No previous chats yet.</p>'; return; }
  list.innerHTML = '';
  chats.forEach(c => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(c.title)} ${subjectBadge(c.subjectId, subjectsById)}</strong>
        <span>${new Date(c.updatedAt).toLocaleString()}</span>
      </div>`;
    card.querySelector('.meta').onclick = () => openChat(c.id);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete chat "${c.title}"?`)) return;
      await DB.deleteChat(c.id);
      if (state.currentChatId === c.id) startNewChat();
      refreshHistoryTab();
    };
    actions.appendChild(delBtn);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

// ===================== SERVICE WORKER =====================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
