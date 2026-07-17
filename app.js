// app.js — StudyHelper PWA logic. Talks to a local Ollama server only. No network calls otherwise.

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
  settings: {
    host: localStorage.getItem('sh_host') || 'http://localhost:11434',
    model: localStorage.getItem('sh_model') || 'gemma4:e2b',
  },
};

// ===================== VIEW SWITCHING =====================
function showApp() {
  el('landing-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  if (!state.currentChatId) startNewChat();
  checkConnection();
  refreshHistoryTab();
  refreshDocumentsTab();
  refreshNotesTab();
  refreshFlashcardsTab();
}
function showLanding() {
  el('app-view').classList.add('hidden');
  el('landing-view').classList.remove('hidden');
}
el('btn-getstarted').onclick = showApp;
el('btn-start-free').onclick = showApp;
el('btn-login').onclick = showApp;
el('btn-back-landing').onclick = showLanding;

// tab switching inside app
qsa('.demo-nav-item[data-tab]').forEach(item => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});
function switchTab(tab) {
  qsa('.demo-nav-item[data-tab]').forEach(i => i.classList.toggle('active', i.dataset.tab === tab));
  ['home', 'notes', 'documents', 'flashcards', 'history'].forEach(t => {
    const paneId = t === 'home' ? 'tab-home' : `tab-${t}`;
    const paneEl = el(paneId);
    if (paneEl) paneEl.classList.toggle('hidden', t !== tab);
  });
  const titles = { home: 'Today', notes: 'Notes', documents: 'Documents', flashcards: 'Flashcards', history: 'History' };
  el('tab-title').textContent = titles[tab] || 'Today';
  if (tab === 'history') refreshHistoryTab();
  if (tab === 'documents') refreshDocumentsTab();
  if (tab === 'notes') refreshNotesTab();
  if (tab === 'flashcards') refreshFlashcardsTab();
}

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
  if (!confirm('This deletes ALL chats, documents, notes, and flashcards stored on this device. This cannot be undone. Continue?')) return;
  await DB.clearAll();
  state.attachedDocIds.clear();
  el('settings-modal').classList.add('hidden');
  startNewChat();
  refreshHistoryTab();
  refreshDocumentsTab();
  refreshNotesTab();
  refreshFlashcardsTab();
};

// ===================== CHAT =====================
async function startNewChat() {
  const chat = await DB.createChat('New chat');
  state.currentChatId = chat.id;
  state.attachedDocIds.clear();
  renderAttachments();
  el('chat-scroll').innerHTML = '';
  el('empty-state') && el('chat-scroll').appendChild(makeEmptyState());
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

async function openChat(chatId) {
  state.currentChatId = chatId;
  state.attachedDocIds.clear();
  renderAttachments();
  const scroll = el('chat-scroll');
  scroll.innerHTML = '';
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
  textEl.className = 'msg-text';
  textEl.textContent = content;
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

  // build context from attached documents
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
    messages.push({ role: 'system', content: 'You are StudyHelper, a concise, friendly study assistant. Explain clearly, use step-by-step reasoning for problems, and keep answers focused.' });
  }
  history.forEach(m => messages.push({ role: m.role, content: m.content }));

  // rename chat from first message
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
            botTextEl.textContent = fullText;
            el('chat-scroll').scrollTop = el('chat-scroll').scrollHeight;
          }
        } catch (_) { /* ignore partial line */ }
      }
    }
  } catch (err) {
    fullText = `⚠ Couldn't reach Ollama at ${state.settings.host}. Make sure "ollama serve" is running and the model is pulled (ollama pull ${state.settings.model}). Check Settings to change the host.`;
    botTextEl.textContent = fullText;
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
    try {
      const text = await extractText(file);
      await DB.addDocument({ name: file.name, type: file.type || file.name.split('.').pop(), size: file.size, text });
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
  const docs = await DB.listDocuments();
  const select = el('fc-source');
  const prevVal = select.value;
  select.innerHTML = '<option value="">No source — use topic only</option>';
  docs.forEach(d => {
    const opt = document.createElement('option');
    opt.value = 'doc:' + d.id;
    opt.textContent = '📄 ' + d.name;
    select.appendChild(opt);
  });

  if (docs.length === 0) { list.innerHTML = '<p class="empty-hint">No documents yet. Upload a .txt, .md, or .pdf to get started.</p>'; return; }
  list.innerHTML = '';
  docs.forEach(d => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(d.name)}</strong>
        <span>${formatBytes(d.size)} · ${new Date(d.createdAt).toLocaleString()} · ${d.text.length.toLocaleString()} chars extracted</span>
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
  qsa('option', select).forEach(o => { if (o.value === prevVal) select.value = prevVal; });
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===================== NOTES =====================
el('btn-new-note').onclick = () => {
  state.editingNoteId = null;
  el('note-title').value = '';
  el('note-content').value = '';
  el('note-editor').classList.remove('hidden');
  el('note-title').focus();
};
el('btn-note-cancel').onclick = () => el('note-editor').classList.add('hidden');
el('btn-note-save').onclick = async () => {
  const title = el('note-title').value.trim() || 'Untitled note';
  const content = el('note-content').value.trim();
  if (state.editingNoteId) {
    await DB.updateNote(state.editingNoteId, title, content);
  } else {
    await DB.addNote(title, content);
  }
  el('note-editor').classList.add('hidden');
  state.editingNoteId = null;
  refreshNotesTab();
};

async function refreshNotesTab() {
  const list = el('note-list');
  const notes = await DB.listNotes();
  const select = el('fc-source');
  notes.forEach(n => {
    if (!qs(`option[value="note:${n.id}"]`, select)) {
      const opt = document.createElement('option');
      opt.value = 'note:' + n.id;
      opt.textContent = '📝 ' + n.title;
      select.appendChild(opt);
    }
  });

  if (notes.length === 0) { list.innerHTML = '<p class="empty-hint">No notes yet.</p>'; return; }
  list.innerHTML = '';
  notes.forEach(n => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(n.title)}</strong>
        <span>Updated ${new Date(n.updatedAt).toLocaleString()}</span>
        <p>${escapeHtml(n.content.slice(0, 200))}${n.content.length > 200 ? '…' : ''}</p>
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

// ===================== FLASHCARDS =====================
el('btn-fc-generate').onclick = async () => {
  const topic = el('fc-topic').value.trim();
  const sourceVal = el('fc-source').value;
  const count = Math.min(15, Math.max(3, parseInt(el('fc-count').value, 10) || 6));
  if (!topic && !sourceVal) { alert('Enter a topic or choose a source document/note.'); return; }

  let sourceText = '';
  let sourceLabel = topic || null;
  if (sourceVal) {
    const [kind, id] = sourceVal.split(':');
    if (kind === 'doc') {
      const doc = await DB.get('documents', id);
      if (doc) { sourceText = doc.text.slice(0, 12000); sourceLabel = doc.name; }
    } else if (kind === 'note') {
      const note = await DB.get('notes', id);
      if (note) { sourceText = note.content; sourceLabel = note.title; }
    }
  }

  const status = el('fc-status');
  status.classList.remove('hidden');
  status.textContent = 'Generating flashcards with ' + state.settings.model + '…';
  el('btn-fc-generate').disabled = true;

  const prompt = `Create exactly ${count} study flashcards ${topic ? `about "${topic}"` : ''} ${sourceText ? `based on this material:\n\n${sourceText}` : ''}.
Respond with ONLY a raw JSON array, no markdown fences, no commentary, in this exact format:
[{"q": "question text", "a": "answer text"}, ...]`;

  try {
    const res = await fetch(state.settings.host.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.settings.model,
        messages: [
          { role: 'system', content: 'You output only valid JSON when asked to. No prose, no markdown fences.' },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error('Request failed: ' + res.status);
    const data = await res.json();
    let raw = (data.message && data.message.content) || '';
    raw = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const firstBracket = raw.indexOf('[');
    const lastBracket = raw.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) raw = raw.slice(firstBracket, lastBracket + 1);
    const cards = JSON.parse(raw);
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('Model did not return a card list');
    await DB.addFlashcardSet(topic || sourceLabel || 'Flashcards', cards, sourceLabel);
    status.textContent = `Generated ${cards.length} cards.`;
    el('fc-topic').value = '';
    refreshFlashcardsTab();
  } catch (err) {
    status.textContent = '⚠ Could not generate flashcards: ' + err.message + '. Make sure Ollama is running and the model is pulled.';
  } finally {
    el('btn-fc-generate').disabled = false;
  }
};

async function refreshFlashcardsTab() {
  const container = el('fc-sets');
  const sets = await DB.listFlashcardSets();
  if (sets.length === 0) { container.innerHTML = '<p class="empty-hint">No flashcard sets yet. Generate one above.</p>'; return; }
  container.innerHTML = '';
  sets.forEach(set => {
    const box = document.createElement('div');
    box.className = 'fc-set';
    const head = document.createElement('div');
    head.className = 'fc-set-head';
    head.innerHTML = `<strong>${escapeHtml(set.title)}</strong><span style="font-size:12px;color:var(--ink-soft);">${set.cards.length} cards · ${new Date(set.createdAt).toLocaleDateString()}</span>`;
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
          <div class="flip-card-face front">${escapeHtml(card.q)}</div>
          <div class="flip-card-face back">${escapeHtml(card.a)}</div>
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

// ===================== HISTORY =====================
async function refreshHistoryTab() {
  const list = el('history-list');
  const chats = await DB.listChats();
  if (chats.length === 0) { list.innerHTML = '<p class="empty-hint">No previous chats yet.</p>'; return; }
  list.innerHTML = '';
  chats.forEach(c => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(c.title)}</strong>
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
