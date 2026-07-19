// db.js — tiny IndexedDB wrapper. No external deps, works fully offline.
// Adds: subjects, quizzes stores, subjectId tagging, and optional AES-GCM
// at-rest encryption for sensitive text fields (documents/notes/messages/
// flashcards/quizzes) using a passphrase-derived key that only ever lives
// in memory for the current session.

const DB_NAME = 'studyhelper-db';
const DB_VERSION = 2;
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) {
        db.createObjectStore('chats', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('chatId', 'chatId', { unique: false });
      }
      if (!db.objectStoreNames.contains('documents')) {
        db.createObjectStore('documents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('flashcardSets')) {
        db.createObjectStore('flashcardSets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('quizSets')) {
        db.createObjectStore('quizSets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('subjects')) {
        db.createObjectStore('subjects', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function tx(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

// ===================== ENCRYPTION (Web Crypto: AES-GCM + PBKDF2) =====================
// Protects data at rest inside IndexedDB (e.g. if the device/profile is
// inspected or synced). Nothing is ever sent anywhere — this is purely local.
// The derived key lives in memory only and is never persisted.
const Crypto = {
  _key: null,
  enabled() { return localStorage.getItem('sh_enc_on') === '1'; },
  hasKey() { return !!this._key; },
  lock() { this._key = null; },

  b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); },
  unb64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer; },

  async _deriveKey(passphrase, saltB64) {
    const salt = new Uint8Array(this.unb64(saltB64));
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  async setup(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = this.b64(salt);
    localStorage.setItem('sh_enc_salt', saltB64);
    this._key = await this._deriveKey(passphrase, saltB64);
    const check = await this.encryptField('studyhelper-ok');
    localStorage.setItem('sh_enc_check', JSON.stringify(check));
    localStorage.setItem('sh_enc_on', '1');
  },

  async unlock(passphrase) {
    const saltB64 = localStorage.getItem('sh_enc_salt');
    const checkRaw = localStorage.getItem('sh_enc_check');
    if (!saltB64 || !checkRaw) return false;
    const key = await this._deriveKey(passphrase, saltB64);
    const prevKey = this._key;
    this._key = key;
    try {
      const check = JSON.parse(checkRaw);
      const plain = await this.decryptField(check);
      if (plain !== 'studyhelper-ok') { this._key = prevKey; return false; }
      return true;
    } catch (e) {
      this._key = prevKey;
      return false;
    }
  },

  async disable() {
    localStorage.removeItem('sh_enc_on');
    localStorage.removeItem('sh_enc_salt');
    localStorage.removeItem('sh_enc_check');
    this._key = null;
  },

  async encryptField(plaintext) {
    if (plaintext == null) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, enc.encode(String(plaintext)));
    return { __enc: true, iv: this.b64(iv), ct: this.b64(ct) };
  },
  async decryptField(value) {
    if (!value || typeof value !== 'object' || !value.__enc) return value;
    const dec = new TextDecoder();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(this.unb64(value.iv)) },
      this._key,
      this.unb64(value.ct)
    );
    return dec.decode(pt);
  },
};
window.SHCrypto = Crypto;

const ENCRYPTED_FIELDS = {
  documents: ['text'],
  notes: ['content'],
  messages: ['content'],
  flashcardSets: ['cardsJson'],
  quizSets: ['questionsJson'],
};

async function encryptRecord(storeName, obj) {
  const fields = ENCRYPTED_FIELDS[storeName];
  if (!fields || !Crypto.enabled() || !Crypto.hasKey()) return obj;
  const clone = { ...obj };
  for (const f of fields) {
    if (f in clone && clone[f] != null && !(clone[f] && clone[f].__enc)) {
      clone[f] = await Crypto.encryptField(clone[f]);
    }
  }
  return clone;
}
async function decryptRecord(storeName, obj) {
  const fields = ENCRYPTED_FIELDS[storeName];
  if (!obj || !fields) return obj;
  const clone = { ...obj };
  for (const f of fields) {
    if (clone[f] && clone[f].__enc) {
      if (!Crypto.hasKey()) { clone[f] = ''; clone._locked = true; continue; }
      try { clone[f] = await Crypto.decryptField(clone[f]); }
      catch (e) { clone[f] = ''; clone._lockError = true; }
    }
  }
  return clone;
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch (e) { return fallback; }
}

const DB = {
  uid,
  Crypto,

  // ---- generic helpers ----
  async put(storeName, obj) {
    const enc = await encryptRecord(storeName, obj);
    const store = await tx(storeName, 'readwrite');
    return new Promise((res, rej) => {
      const r = store.put(enc);
      r.onsuccess = () => res(obj);
      r.onerror = () => rej(r.error);
    });
  },
  async get(storeName, id) {
    const store = await tx(storeName, 'readonly');
    const raw = await new Promise((res, rej) => {
      const r = store.get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
    return decryptRecord(storeName, raw);
  },
  async delete(storeName, id) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((res, rej) => {
      const r = store.delete(id);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    });
  },
  async all(storeName) {
    const store = await tx(storeName, 'readonly');
    const raws = await new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
    return Promise.all(raws.map(o => decryptRecord(storeName, o)));
  },
  async clearAll() {
    const db = await openDB();
    const names = ['chats', 'messages', 'documents', 'notes', 'flashcardSets', 'quizSets', 'subjects'];
    await Promise.all(names.map(name => new Promise((res, rej) => {
      const r = db.transaction(name, 'readwrite').objectStore(name).clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    })));
  },

  // ---- subjects / courses ----
  async createSubject(name, color) {
    const subject = { id: uid(), name, color: color || '#2563eb', createdAt: Date.now() };
    await this.put('subjects', subject);
    return subject;
  },
  async listSubjects() {
    const subs = await this.all('subjects');
    return subs.sort((a, b) => a.name.localeCompare(b.name));
  },
  async renameSubject(id, name, color) {
    const s = await this.get('subjects', id);
    if (!s) return;
    s.name = name;
    if (color) s.color = color;
    await this.put('subjects', s);
  },
  async deleteSubject(id) {
    for (const store of ['chats', 'documents', 'notes', 'flashcardSets', 'quizSets']) {
      const items = await this.all(store);
      for (const it of items) {
        if (it.subjectId === id) { it.subjectId = null; await this.put(store, it); }
      }
    }
    return this.delete('subjects', id);
  },

  // ---- chats ----
  async createChat(title = 'New chat', subjectId = null) {
    const chat = { id: uid(), title, subjectId, createdAt: Date.now(), updatedAt: Date.now() };
    await this.put('chats', chat);
    return chat;
  },
  async listChats() {
    const chats = await this.all('chats');
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async deleteChat(chatId) {
    await this.delete('chats', chatId);
    const store = await tx('messages', 'readwrite');
    const idx = store.index('chatId');
    return new Promise((res, rej) => {
      const r = idx.openCursor(IDBKeyRange.only(chatId));
      r.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); } else { res(true); }
      };
      r.onerror = () => rej(r.error);
    });
  },
  async renameChat(chatId, title) {
    const chat = await this.get('chats', chatId);
    if (!chat) return;
    chat.title = title;
    chat.updatedAt = Date.now();
    await this.put('chats', chat);
  },
  async setChatSubject(chatId, subjectId) {
    const chat = await this.get('chats', chatId);
    if (!chat) return;
    chat.subjectId = subjectId || null;
    await this.put('chats', chat);
  },
  async touchChat(chatId) {
    const chat = await this.get('chats', chatId);
    if (!chat) return;
    chat.updatedAt = Date.now();
    await this.put('chats', chat);
  },

  // ---- messages ----
  async addMessage(chatId, role, content) {
    const msg = { id: uid(), chatId, role, content, createdAt: Date.now() };
    await this.put('messages', msg);
    await this.touchChat(chatId);
    return msg;
  },
  async listMessages(chatId) {
    const store = await tx('messages', 'readonly');
    const idx = store.index('chatId');
    const raws = await new Promise((res, rej) => {
      const r = idx.getAll(IDBKeyRange.only(chatId));
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.createdAt - b.createdAt));
      r.onerror = () => rej(r.error);
    });
    return Promise.all(raws.map(o => decryptRecord('messages', o)));
  },

  // ---- documents ----
  async addDocument(doc) {
    const record = { id: uid(), createdAt: Date.now(), subjectId: null, ...doc };
    await this.put('documents', record);
    return record;
  },
  async listDocuments() {
    const docs = await this.all('documents');
    return docs.sort((a, b) => b.createdAt - a.createdAt);
  },
  async deleteDocument(id) {
    return this.delete('documents', id);
  },
  async setDocumentSubject(id, subjectId) {
    const d = await this.get('documents', id);
    if (!d) return;
    d.subjectId = subjectId || null;
    await this.put('documents', d);
  },

  // ---- notes ----
  async addNote(title, content, subjectId = null) {
    const note = { id: uid(), title, content, subjectId, createdAt: Date.now(), updatedAt: Date.now() };
    await this.put('notes', note);
    return note;
  },
  async updateNote(id, title, content, subjectId) {
    const note = await this.get('notes', id);
    if (!note) return;
    note.title = title;
    note.content = content;
    if (subjectId !== undefined) note.subjectId = subjectId;
    note.updatedAt = Date.now();
    await this.put('notes', note);
    return note;
  },
  async listNotes() {
    const notes = await this.all('notes');
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async deleteNote(id) {
    return this.delete('notes', id);
  },

  // ---- flashcards ----
  async addFlashcardSet(title, cards, sourceLabel, subjectId = null) {
    const set = { id: uid(), title, cardsJson: JSON.stringify(cards), sourceLabel: sourceLabel || null, subjectId, createdAt: Date.now() };
    await this.put('flashcardSets', set);
    return { ...set, cards };
  },
  async listFlashcardSets() {
    const sets = await this.all('flashcardSets');
    return sets
      .map(s => ({ ...s, cards: safeParse(s.cardsJson, []) }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async deleteFlashcardSet(id) {
    return this.delete('flashcardSets', id);
  },
  async deleteFlashcard(setId, cardIndex) {
    const raw = await this.get('flashcardSets', setId);
    if (!raw) return;
    const cards = safeParse(raw.cardsJson, []);
    cards.splice(cardIndex, 1);
    raw.cardsJson = JSON.stringify(cards);
    await this.put('flashcardSets', raw);
    return raw;
  },

  // ---- quizzes ----
  async addQuizSet(title, questions, sourceLabel, subjectId = null) {
    const set = { id: uid(), title, questionsJson: JSON.stringify(questions), sourceLabel: sourceLabel || null, subjectId, createdAt: Date.now(), attempts: [] };
    await this.put('quizSets', set);
    return { ...set, questions };
  },
  async listQuizSets() {
    const sets = await this.all('quizSets');
    return sets
      .map(s => ({ ...s, questions: safeParse(s.questionsJson, []) }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async deleteQuizSet(id) {
    return this.delete('quizSets', id);
  },
  async recordQuizAttempt(id, score, total) {
    const raw = await this.get('quizSets', id);
    if (!raw) return;
    raw.attempts = raw.attempts || [];
    raw.attempts.push({ score, total, at: Date.now() });
    await this.put('quizSets', raw);
  },
};

window.DB = DB;
