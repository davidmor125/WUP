# Development guide

How to get WUP running locally and keep working on it. For what the service
does and its HTTP API, see [README.md](README.md).

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer (developed on 25.2) |
| **npm** | 9 or newer |
| **Chromium** | installed automatically with `whatsapp-web.js` |
| **Build tools** | needed once, to compile `better-sqlite3` |
| **A phone with WhatsApp** | to link as a device |

`better-sqlite3` is a native module, so the first `npm install` compiles it:

- **Windows** — usually works out of the box; if it fails, install
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
  with the "Desktop development with C++" workload.
- **macOS** — `xcode-select --install`
- **Linux** — `sudo apt install build-essential python3`

Chromium is ~300 MB and downloads on first install. Behind a proxy or on a
server that already has Chrome, skip it and point at the system browser:

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm install
# then set PUPPETEER_EXECUTABLE_PATH in .env
```

## First run

```bash
git clone https://github.com/davidmor125/WUP.git
cd WUP

npm install                     # backend
cd frontend && npm install      # frontend
cd ..

cp .env.example .env            # defaults are fine for local work
```

Then start both halves, in two terminals:

```bash
npm run dev                     # backend  → http://localhost:3000
cd frontend && npm run dev      # frontend → http://localhost:5173
```

Open http://localhost:5173, go to **Connect**, press **Connect**, and scan the
QR with WhatsApp → Settings → Linked devices → Link a device.

The database is created automatically on first start; nothing to run first.

## Layout

```
src/
├── whatsapp/
│   ├── client.js      per-session clients, reconnect, watchdog, QR/pairing
│   ├── listener.js    normalizes incoming events → SQLite → event bus
│   ├── sender.js      sending, chat/contact lookups, outbound media
│   └── qrManager.js   QR storage per session
├── services/
│   ├── messages.service.js   all message/chat SQL
│   ├── events.service.js     in-process event bus + SSE fan-out
│   ├── webhooks.service.js   webhook CRUD + delivery log
│   └── auth.service.js       API key storage and rotation
├── webhooks/dispatcher.js    HMAC signing, retries, delivery recording
├── routes/                   HTTP layer, one file per resource
├── db/
│   ├── index.js       opens SQLite, applies the schema at startup
│   └── schema.sql     the same schema as readable SQL
└── index.js           boot: db → dispatcher → HTTP → restore sessions

frontend/src/
├── pages/       ConnectPage · ChatsPage · WebhooksPage
├── components/  dialogs, emoji picker, message rendering
└── hooks/       useApi (fetch + polling), useEventStream (SSE)
```

### How a message flows

```
WhatsApp (Chromium)
   │ message_create        ← fires for inbound AND outbound
   ▼
listener.js  normalize → SQLite → event bus
                                    ├→ webhook dispatcher (HMAC + retry)
                                    └→ SSE → the UI updates live
```

Sending runs the same loop in reverse: `POST /api/messages` → `sender.js` →
WhatsApp → the echo arrives on `message_create` like any other message.

## Everyday commands

```bash
npm run dev          # backend with auto-restart (nodemon)
npm start            # backend, no watcher
npm run build        # build the frontend for production

npm run db:status    # tables and row counts
npm run db:init      # create/upgrade the schema (safe on a populated db)
npm run db:reset     # drop everything — requires --yes
```

Production serves the built UI from the backend itself:

```bash
npm run build
RUNTIME=server npm start        # everything on :3000
```

## Working on it

**Backend changes** restart automatically under `npm run dev`. A restart
destroys the Chromium instance and re-initializes the WhatsApp client, which
takes ~10 seconds — so batch backend edits rather than saving constantly.

[`nodemon.json`](nodemon.json) limits the watch to `src/`. Without it nodemon
watches the whole project, including `data/` and `.wwebjs_auth/`, which the app
writes to on every message — so each incoming message would restart the server.

**Frontend changes** hot-reload; no restart, and the WhatsApp session is
untouched.

**Sessions survive restarts.** Credentials live in `.wwebjs_auth/session-<id>/`
and are restored on boot. You should not need to re-scan a QR between restarts —
but many restarts in quick succession can make WhatsApp drop the linked-device
registration, and then you do. Nothing is wrong when that happens; scan again.

**Inspecting data** — the database is a plain SQLite file:

```bash
npm run db:status
sqlite3 data/wup.db "SELECT direction, chat_type, body FROM messages ORDER BY id DESC LIMIT 10"
```

**Testing webhooks** — run the bundled receiver, which verifies signatures and
auto-replies to "ping":

```bash
WEBHOOK_SECRET=<from the Webhooks screen> WUP_API_KEY=<your key> \
  node examples/webhook-receiver.mjs
```

## Configuration

Every setting has a working default; `.env` only overrides. See
[.env.example](.env.example) for the annotated list. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `API_KEY` | *(empty)* | Empty = no auth. Set in production. Overrides the UI-managed key and disables rotation. |
| `WA_ENABLED` | `true` | `false` runs the API without Chromium — useful when working on routes or the UI. |
| `WA_SESSION_DATA_PATH` | `.wwebjs_auth` | Where linked-device credentials live. |
| `DB_FILE` | `data/wup.db` | |
| `PUPPETEER_EXECUTABLE_PATH` | *(unset)* | Point at a system Chrome instead of the bundled Chromium. |

`WA_ENABLED=false` is the fastest way to iterate on anything that isn't the
WhatsApp connection itself — no browser to boot, instant restarts.

## Things worth knowing before you change them

These are non-obvious and were each the result of a real failure.

**`message_create`, not `message`.** The listener binds to `message_create`
because it also fires for outgoing messages — including ones typed on the phone.
That is what makes the outbound webhook possible. Switching to `message` would
silently drop half the events.

**Echo suppression is by message id.** A message this service sends comes back
through `message_create`. `sender.js` records the id it sent so the listener can
recognize the echo. (wupbot used a counter of messages to skip, which
desynchronizes whenever events arrive out of order.)

**Deduplication is two-layered.** An in-memory set of recent ids, plus a
`UNIQUE (session_id, wa_message_id)` index. `message_create` can genuinely fire
twice for one message after a reconnect.

**Two workarounds for `whatsapp-web.js` breakage** against the current WhatsApp
Web build — both documented in the README:

- `client.getChats()` throws during per-chat enrichment (surfacing only as a
  minified `"r"`), so `fetchChats()` reads the chat collection from the page
  directly.
- `client.sendMessage()` returns `undefined` for some chats — LID contacts in
  particular — *even though the message is delivered*. Treating that as an error
  would report a failure for a message the recipient already has, and invite a
  duplicate resend.

If a library upgrade fixes these upstream, both functions can go back to the
plain library calls.

**Media paths vs URLs.** Attachments are stored relative to the project
(`data/media/x.jpg`) but served from `/media`. The API hands out `media.url`
already mapped; don't build the URL from `path` by prepending a slash.

**Reply to `message.inbound` only.** Anything that answers `message.outbound`
answers its own replies — an infinite loop that ends with the number banned.

## Deploying

Any host that runs Node and allows a headless browser works. Checklist:

1. `API_KEY` set to something long and random.
2. `RUNTIME=server` so the backend serves the built frontend.
3. `npm run build` during the build step.
4. `data/` and `.wwebjs_auth/` on a **persistent volume** — losing
   `.wwebjs_auth/` means re-scanning the QR; losing `data/` means losing the
   message history.
5. Roughly 512 MB RAM per linked session (Chromium is the bulk of it).
6. `PUPPETEER_EXECUTABLE_PATH` if the image already ships Chrome.

**A caution about scale.** `whatsapp-web.js` drives the WhatsApp Web interface
and is not endorsed by WhatsApp. Aggressive automation risks getting the number
banned. For commercial or high-volume messaging, the official WhatsApp Business
API is the appropriate route.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `better-sqlite3` fails to install | Missing C++ build tools — see Requirements. |
| Chromium won't launch on a server | Missing shared libs; install Chrome and set `PUPPETEER_EXECUTABLE_PATH`. |
| Status stuck on `initializing` | Chromium is still booting — allow ~10s. Check the backend log. |
| QR expires before you scan | Press **Restart** for a fresh one; they are short-lived. |
| `401 Authentication required` | A key is set. Enter it on the Connect screen, or send `X-API-Key`. |
| Lost the API key | Delete the `api_key` row: `sqlite3 data/wup.db "DELETE FROM settings WHERE key='api_key'"`, then generate a new one. |
| Sends return `503` | The session isn't `ready`. Check `GET /api/whatsapp/status`. |
| Empty message bubbles | Media that failed to download. The backend logs why. |

The backend log is the first place to look — every WhatsApp state change,
webhook delivery, and media failure is recorded there.
