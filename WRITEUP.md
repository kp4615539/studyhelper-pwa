# StudyHelper — Offline AI Study Companion
### Edge / On-Device Track submission — Build with Gemma: GDG Embu

## The problem

University life runs on scattered tools and unreliable connectivity. Students
need to explain concepts, work through problems, summarise long readings, and
drill for exams — but every existing AI study tool assumes an always-on
internet connection and sends your notes to a third-party server. For
students on campus wifi that drops constantly, or who simply don't want
their coursework uploaded anywhere, that's a real barrier.

StudyHelper removes the connectivity requirement entirely. It's an
installable Progressive Web App that runs Gemma locally via Ollama — no
account, no cloud call, no data leaving the device. Once the model is
pulled, it works on a plane, in a lecture hall with no signal, or in a
dorm with patchy wifi.

## Why this fits the Edge/On-Device track

Every feature is designed around the constraint of local-only inference:

- All chat, document, note, and flashcard data lives in **IndexedDB** on the
  device — nothing is ever transmitted except the prompt/response exchange
  with the local Ollama server on `localhost`.
- PDF text extraction runs **client-side** via a locally-bundled pdf.js (no
  CDN dependency), so document upload works fully offline too.
- A service worker caches the entire app shell, so the UI itself loads
  without a network connection — only the Ollama call needs the local
  server running.
- The app explicitly targets **gemma4:e2b**, Gemma 4's "effective 2B"
  edge-optimized variant, chosen specifically for its small footprint and
  fast local inference on modest hardware — exactly the kind of device a
  student actually owns.

## Architecture

**Frontend:** vanilla HTML/CSS/JS PWA, no build step, no framework
dependency — kept deliberately lightweight so it installs and loads fast
on low-end devices.

**Storage:** a small IndexedDB wrapper (`db.js`) manages five stores —
chats, messages, documents, notes, flashcard sets — with full CRUD
(create, read, update, delete) for every entity.

**Inference:** the app calls Ollama's local REST API
(`POST /api/chat`) directly from the browser. Chat responses are streamed
token-by-token via `ReadableStream` for a responsive feel; flashcard
generation uses a non-streaming call with a strict JSON-only system prompt,
parsed and validated before being saved.

**Document pipeline:** uploaded `.txt`/`.md` files are read directly;
`.pdf` files are parsed page-by-page with pdf.js to extract raw text. That
text can be attached as context to any chat message, or used as the source
material for flashcard generation — turning a lecture-slide PDF into a
quiz deck in one step, entirely offline.

## Core features

1. **Chat** — streaming responses, per-message delete, persistent chat
   history with auto-titling from the first message.
2. **Documents** — upload, locally extract text, attach as chat context,
   delete.
3. **Notes** — manual create/edit/delete for personal study notes.
4. **Flashcards** — generate a set from a typed topic and/or an uploaded
   document/note; flip-card review UI; delete a whole set or a single card.
5. **Settings** — configurable Ollama host and model name, a live
   connection-status indicator, and a one-click "clear all data" reset.

## Challenges in the one-day sprint

- **Streaming parser correctness.** Ollama streams newline-delimited JSON
  chunks that don't always align cleanly with `ReadableStream` read
  boundaries. The fix was buffering partial lines across reads rather than
  assuming each chunk is a complete JSON object.
- **Reliable JSON-only output for flashcards.** Small edge models
  occasionally wrap JSON in markdown fences or add a sentence of preamble
  despite instructions. The generation pipeline strips fences and extracts
  the outermost `[...]` span before parsing, so the app degrades gracefully
  instead of crashing on a malformed response.
- **Offline-first without breaking the PWA contract.** The service worker
  had to explicitly bypass caching for any request to the Ollama API port,
  so the app shell is cached for offline load while live model calls always
  hit the network — those are two different "offline" requirements that
  are easy to conflate.
- **PDF parsing without a CDN.** To keep the app genuinely offline-capable,
  pdf.js is vendored directly into the project rather than loaded from a
  CDN at runtime, so document upload doesn't silently break the moment
  there's no internet.

## Why gemma4:e2b specifically

The e2b variant was chosen over larger Gemma checkpoints because it's
realistic for the hardware a student actually has — a laptop without a
discrete GPU. It loads fast, responds fast, and is small enough that
`ollama pull` doesn't itself become a barrier on the kind of connection
this project is designed to route around.

## Reproducing this submission

Full setup instructions are in `README.md` in the repository. In short:

```bash
ollama pull gemma4:e2b
ollama serve
cd studyhelper-pwa && python3 -m http.server 8080
# open http://localhost:8080
```

Code repository: **[add your public GitHub URL here]**
Live demo: **[add your hosted URL or screen recording here]**
