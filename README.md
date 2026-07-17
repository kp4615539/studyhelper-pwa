# StudyHelper — Offline AI Study Companion

A PWA frontend that talks to a locally-running Ollama server. Everything —
chats, documents, notes, flashcards — is stored in IndexedDB on-device.
Nothing is ever sent anywhere except to Ollama on `localhost`.

## 1. Get the code

```bash
git clone https://github.com/kp4615539/studyhelper-pwa.git
cd studyhelper-pwa
```

## 2. Install and run Ollama + Gemma

```bash
# install Ollama: https://ollama.com/download
ollama pull gemma4:e2b     # Gemma 4's edge-optimized "effective 2B" variant
ollama serve               # usually starts automatically after install —
                            # if you see "address already in use", it's
                            # already running in the background, skip this
```

## 3. Serve the app

PWAs need to be served over HTTP(S), not opened as a `file://` URL (service
workers and IndexedDB won't behave correctly otherwise).

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Any static file server works (`npx serve`, nginx, Caddy, etc).

**If you're running the steps above exactly as written, you're done — skip
straight to step 5.** Ollama trusts `localhost`/`127.0.0.1` origins by
default, so no extra configuration is needed for a standard local run.

## 4. Only if serving from somewhere other than localhost (optional)

If you access this app from a different origin — a phone on your LAN, or a
hosted copy like GitHub Pages — Ollama needs to explicitly allow that origin,
since it isn't `localhost`:

```bash
# scoped to one origin (recommended):
OLLAMA_ORIGINS="https://your-deployed-url.example" ollama serve

# or, less safely, allow any origin:
OLLAMA_ORIGINS="*" ollama serve
```

If accessing from another device on your network, Ollama also needs to
listen on more than just `127.0.0.1`:

```bash
OLLAMA_HOST="0.0.0.0:11434" OLLAMA_ORIGINS="*" ollama serve
```
then find your machine's local IP (`ipconfig` on Windows / `ifconfig` on
Mac/Linux) and set that as the Ollama host in the app's Settings, e.g.
`http://192.168.1.42:11434`. You may also need to allow inbound traffic on
port 11434 through your firewall.

## 5. Install as an app

Once loaded in Chrome/Edge, use the install icon in the address bar (or
"Add to Home Screen" on mobile) to install it as a standalone app.

## 6. Configure the model in-app

Open Settings (gear icon in the sidebar) and set:
- **Ollama host** — defaults to `http://localhost:11434`
- **Model name** — must match a model you've pulled (`gemma4:e2b`, `gemma4:e4b`, etc.)

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
