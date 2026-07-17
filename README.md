# StudyHelper — Offline AI Study Companion

A PWA frontend that talks to a locally-running Ollama server. Everything —
chats, documents, notes, flashcards — is stored in IndexedDB on-device.
Nothing is ever sent anywhere except to Ollama on `localhost`.

## 1. Install and run Ollama + Gemma

```bash
# install Ollama: https://ollama.com/download
ollama pull gemma3        # or gemma3:1b / gemma3:4b for a smaller/faster model
ollama serve               # usually starts automatically after install
```

## 2. Allow the PWA to reach Ollama (CORS)

If you serve this app from anywhere other than `localhost` (e.g. a phone on
your LAN, or GitHub Pages), Ollama needs to allow that origin:

```bash
OLLAMA_ORIGINS="*" ollama serve
```

## 3. Serve the app

PWAs need to be served over HTTP(S), not opened as a `file://` URL (service
workers and IndexedDB won't behave correctly otherwise).

```bash
cd studyhelper-pwa
python3 -m http.server 8080
# then open http://localhost:8080
```

Any static file server works (`npx serve`, nginx, Caddy, etc).

## 4. Install as an app

Once loaded in Chrome/Edge, use the install icon in the address bar (or
"Add to Home Screen" on mobile) to install it as a standalone app.

## 5. Configure the model in-app

Open Settings (gear icon in the sidebar) and set:
- **Ollama host** — defaults to `http://localhost:11434`
- **Model name** — must match a model you've pulled (`gemma3`, `gemma3:4b`, etc.)

## What's implemented

- **Chat** — streaming responses from Ollama, per-message delete, chat
  history with rename-on-first-message and delete.
- **Documents** — upload `.txt` / `.md` / `.pdf`, text extracted locally via
  pdf.js (bundled, no CDN), attach one or more documents as context to a
  chat message, delete documents.
- **Notes** — create, edit, delete.
- **Flashcards** — generate from a typed topic and/or an existing document
  or note, flip-card UI, delete a whole set or an individual card.
- **Settings** — configurable Ollama host/model, connection status
  indicator, "clear all data" wipe.
- **PWA basics** — manifest, installable, service worker caches the app
  shell for offline load (the Ollama API itself is never cached/proxied —
  it always needs Ollama running).

## Known limits / good next steps

- No auth or sync — this is single-device, local-only by design.
- Large PDFs are truncated to ~12k characters of context per document when
  sent to the model (Gemma's context window is the limiting factor, not
  storage).
- `.docx` upload isn't supported yet — only `.txt`, `.md`, `.pdf`.
