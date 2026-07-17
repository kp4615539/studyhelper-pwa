// db.js — tiny IndexedDB wrapper. No external deps, works fully offline.
const DB_NAME = 'studyhelper-db';
const DB_VERSION = 1;
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

const DB = {
  uid,

  // ---- generic helpers ----
  async put(storeName, obj) {
    const store = await tx(storeName, 'readwrite');
    return new Promise((res, rej) => {
      const r = store.put(obj);
      r.onsuccess = () => res(obj);
      r.onerror = () => rej(r.error);
    });
  },
  async get(storeName, id) {
    const store = await tx(storeName, 'readonly');
    return new Promise((res, rej) => {
      const r = store.get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
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
    return new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async clearAll() {
    const db = await openDB();
    const names = ['chats', 'messages', 'documents', 'notes', 'flashcardSets'];
    await Promise.all(names.map(name => new Promise((res, rej) => {
      const r = db.transaction(name, 'readwrite').objectStore(name).clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    })));
  },

  // ---- chats ----
  async createChat(title = 'New chat') {
    const chat = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now() };
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
    return new Promise((res, rej) => {
      const r = idx.getAll(IDBKeyRange.only(chatId));
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.createdAt - b.createdAt));
      r.onerror = () => rej(r.error);
    });
  },

  // ---- documents ----
  async addDocument(doc) {
    const record = { id: uid(), createdAt: Date.now(), ...doc };
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

  // ---- notes ----
  async addNote(title, content) {
    const note = { id: uid(), title, content, createdAt: Date.now(), updatedAt: Date.now() };
    await this.put('notes', note);
    return note;
  },
  async updateNote(id, title, content) {
    const note = await this.get('notes', id);
    if (!note) return;
    note.title = title;
    note.content = content;
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
  async addFlashcardSet(title, cards, sourceLabel) {
    const set = { id: uid(), title, cards, sourceLabel: sourceLabel || null, createdAt: Date.now() };
    await this.put('flashcardSets', set);
    return set;
  },
  async listFlashcardSets() {
    const sets = await this.all('flashcardSets');
    return sets.sort((a, b) => b.createdAt - a.createdAt);
  },
  async deleteFlashcardSet(id) {
    return this.delete('flashcardSets', id);
  },
  async deleteFlashcard(setId, cardIndex) {
    const set = await this.get('flashcardSets', setId);
    if (!set) return;
    set.cards.splice(cardIndex, 1);
    await this.put('flashcardSets', set);
    return set;
  },
};

window.DB = DB;
