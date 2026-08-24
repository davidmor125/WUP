# WUP — WhatsApp Bridge

A WhatsApp connection service with webhooks. Links a device by QR (or pairing
code), captures **incoming and outgoing** messages for **both groups and
individuals**, stores them in SQLite, forwards them to your webhooks, and lets
you send messages from a REST API or the built-in web UI.

Built on [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) —
the same approach as the `wupbot` project, extracted and rebuilt around
messaging rather than CRM.

## Quick start

```bash
npm install
cp .env.example .env        # set API_KEY before exposing the service
npm run dev                 # backend on :3000

cd frontend && npm install && npm run dev   # UI on :5173
```

Open http://localhost:5173, click **Connect**, and scan the QR with
WhatsApp → Settings → Linked devices.

For setup details, project layout, and the non-obvious constraints worth
knowing before changing things, see [DEVELOPMENT.md](DEVELOPMENT.md).

In production, `npm run build` compiles the UI and `RUNTIME=server npm start`
serves it from the same process on `:3000`.

## How it works

```
WhatsApp (Chromium/Puppeteer)
   │  message_create  ← fires for inbound AND outbound
   ▼
listener.js ── normalize ──▶ SQLite ──▶ event bus
                                          ├──▶ webhook dispatcher (HMAC + retry)
                                          └──▶ SSE ──▶ web UI (live)
```

`message_create` is the key choice: unlike the `message` event, it also fires
for messages you send — from this API, or typed on the linked phone. That is
what makes the outbound webhook possible.

Groups are first-class. In a group, WhatsApp puts the *group* in `from` and the
*person* in `author`, so every stored message carries `chatType`, `chatId`,
`chatName`, `authorId` and `authorName`.

## API

Every route except `/api/health` and `/api/auth/status` requires the API key,
sent as `Authorization: Bearer <key>`, `X-API-Key: <key>`, or `?apiKey=<key>`
(the query form exists because `EventSource` cannot set headers). With no key
configured the guard is off — fine locally, logged as a warning at startup.

**Managing the key.** Press *Generate key* on the Connect screen, or:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/status` | Is auth on? (public — a keyless UI needs this) |
| `GET` | `/api/auth/key` | Reveal the current key |
| `POST` | `/api/auth/rotate` | Generate a new key; the old one dies immediately |
| `POST` | `/api/auth/disable` | Remove the key and stop requiring auth |

The key is stored in SQLite so it can be rotated without editing `.env` and
restarting. While no key exists, `/rotate` is callable without one — that is how
the first key gets created; the moment a key is set, the route requires it, so
nobody can rotate a key they don't hold.

Setting `API_KEY` in the environment overrides the stored key and disables
rotation from the UI: deployments that inject secrets must stay authoritative,
rather than letting a UI action silently diverge from what the platform holds.

All routes accept an optional `sessionId` (query or body) to address a specific
linked device; it defaults to `WA_DEFAULT_SESSION_ID`.

### Connection

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/whatsapp/status` | Connection state for a session |
| `GET` | `/api/whatsapp/sessions` | All known sessions |
| `GET` | `/api/whatsapp/qr-data` | QR as a data URL |
| `GET` | `/api/whatsapp/qr` | Standalone scannable page |
| `POST` | `/api/whatsapp/connect` | Start/restart a session |
| `POST` | `/api/whatsapp/pair` | Link by phone number → pairing code |
| `POST` | `/api/whatsapp/disconnect` | Stop the client, keep credentials |
| `POST` | `/api/whatsapp/logout` | Unlink and clear credentials |
| `GET` | `/api/whatsapp/chats?type=group\|private` | Live chat list from the device |
| `GET` | `/api/whatsapp/groups` | Groups only (alias for the above) |
| `GET` | `/api/whatsapp/contacts?search=&type=` | Saved contacts and groups |

`/contacts` reads the device's own address book, so it is populated the moment
you link — you do not have to wait for a message to arrive. Results are
deduplicated: WhatsApp stores separate records for a contact's phone-number and
linked-device (LID) identities. Note that two different groups may legitimately
share a name; they are distinct chats with distinct ids.

The **Chats** screen merges three sources into one list — your address book,
every conversation on the device, and the messages this service has stored —
so contacts and conversations are a single screen. Typing a phone number that
isn't in your contacts offers to start a new chat with it.

> **`getChats()` note.** `client.getChats()` throws against the current
> WhatsApp Web build — its per-chat `getChatModel()` enrichment fails and
> surfaces only as a minified `"r"`. `fetchChats()` therefore reads the chat
> collection out of the page directly, picking each field defensively so one
> unreadable chat can't fail the whole listing. If a library upgrade fixes
> this upstream, that function can go back to `client.getChats()`.
>
> **`sendMessage()` note.** The same serialization breakage makes
> `client.sendMessage()` return `undefined` for some chats (LID contacts in
> particular) *even though the message is delivered*. Treating that as an error
> would report a failure for a message the recipient already has — and invite a
> duplicate resend. Instead, `sendMessage()` looks for the row the
> `message_create` listener has usually already written (it commonly fires
> before the send call returns) and returns that; only if none is found does it
> store a placeholder under a synthetic `local_…` id, which the echo later
> adopts.

Status values: `disconnected`, `initializing`, `qr_pending`, `authenticated`, `ready`.
Only `ready` can send. Dropped connections reconnect on a `5s → 10s → 30s → 60s`
backoff, with a watchdog sweep every 5 minutes.

### Messages

**Send** — `POST /api/messages`

```jsonc
{
  "to": "972500000000",           // or "972500000000@c.us", or "1234-5678@g.us" for a group
  "body": "Hello",
  "media": { "url": "https://example.com/photo.jpg" },  // or {base64, mimetype, filename} or {filePath}
  "quotedMessageId": "false_...", // optional: reply to a message
  "mentions": ["972500000000"],   // optional: group mentions
  "linkPreview": true
}
```

`to` accepts a bare number or any full chat id — a value that already carries a
WhatsApp suffix passes through untouched, which is how you address groups.

**Read** — `GET /api/messages?chatId=…&chatType=group&direction=inbound&limit=50`

Other routes: `GET /api/messages/chats` (stored conversations),
`GET /api/messages/stats`, `POST /api/messages/chats/:chatId/read`.

### Webhooks

`GET|POST /api/webhooks`, `GET|PATCH|DELETE /api/webhooks/:id`,
`POST /api/webhooks/:id/test`, `GET /api/webhooks/deliveries`,
`POST /api/webhooks/deliveries/:id/retry`.

Create one with a `url`, an optional `events` array (empty = all), and a
`chatFilter` of `all` | `private` | `group`.

Events: `message.inbound`, `message.outbound`, `message.ack`, `connection.status`.

Each delivery is a POST:

```jsonc
{
  "event": "message.inbound",
  "timestamp": "2026-08-24T06:54:00.423Z",
  "data": {
    "waMessageId": "false_972500000000@c.us_ABC123",
    "chatId": "1234-5678@g.us",
    "chatType": "group",
    "chatName": "Team",
    "direction": "inbound",
    "authorId": "972500000000@c.us",
    "authorName": "Dana",
    "body": "Hello",
    "type": "chat",
    "hasMedia": false,
    "timestamp": "2026-08-24T06:54:00.000Z"
  }
}
```

**Verifying the signature.** Each request carries `X-Webhook-Timestamp` and
`X-Webhook-Signature: sha256=<hex>`, an HMAC-SHA256 over `{timestamp}.{body}`
using the webhook's secret. Including the timestamp is what stops an old capture
from being replayed with a still-valid signature — so check that the timestamp is
recent as well as that the digest matches:

```js
const expected = crypto.createHmac('sha256', secret)
  .update(`${req.headers['x-webhook-timestamp']}.${rawBody}`)
  .digest('hex');
```

Failed deliveries retry on a `1s → 5s → 25s` backoff. A `4xx` response is *not*
retried — the receiver rejected the payload itself, so an identical retry fails
identically. Every attempt is recorded and visible in the UI.

### Worked example

[`examples/webhook-receiver.mjs`](examples/webhook-receiver.mjs) is a complete
receiver: it verifies signatures, logs every message, and auto-replies "pong" to
anyone who writes "ping".

```bash
# 1. Add a webhook on the Webhooks screen pointing at http://localhost:4000/hook
#    and copy its signing secret.
# 2. Run the receiver:
WEBHOOK_SECRET=<the secret> WUP_API_KEY=<your api key> node examples/webhook-receiver.mjs
# 3. Press "Test" on the Webhooks screen, then message the linked phone.
```

Four things it demonstrates that a naive receiver gets wrong:

- **Read the raw body.** The signature covers the exact bytes sent;
  re-serializing a parsed object produces a different digest.
- **Check the timestamp.** A signature alone stays valid forever, so a captured
  request could be replayed. The example rejects anything older than 5 minutes.
- **Respond before working.** WUP treats a slow response as a failure and
  retries, which would process the same event twice.
- **Guard on direction.** Replying to a `message.outbound` event means replying
  to your own reply — an infinite loop.

### Live stream

`GET /api/events` is a Server-Sent Events stream carrying the same events. The
UI uses it so conversations update without polling.

## Storage

One SQLite file (`DB_FILE`, default `data/wup.db`), in WAL mode so HTTP reads
proceed while the listener writes. Tables: `chats`, `messages`, `settings`,
`webhooks`, `webhook_deliveries`. Downloaded attachments go to `data/media/` and
are served at `/media/...`.

The schema is applied automatically at startup, so there is nothing to run
before `npm start`. [`src/db/schema.sql`](src/db/schema.sql) holds the same
definitions as readable, commented SQL, and a small CLI wraps it:

```bash
npm run db:status     # tables and row counts; changes nothing
npm run db:init       # create or upgrade the schema (safe on a populated db)
npm run db:reset      # drop everything and recreate — needs --yes to proceed
```

Every statement is `IF NOT EXISTS`, so `db:init` on a live database is a no-op
rather than destructive.

Deduplication is two-layered: an in-memory set of recent message ids, plus a
`UNIQUE (session_id, wa_message_id)` index as the backstop — `message_create`
can fire twice for the same message after a reconnect.

## Notes

- **Chromium per session.** Each linked device runs its own browser. Budget
  ~300–400 MB of RAM per session, and set `PUPPETEER_EXECUTABLE_PATH` on servers
  where you'd rather use a system Chrome.
- **Unofficial client.** `whatsapp-web.js` drives the WhatsApp Web interface and
  is not endorsed by WhatsApp. Aggressive automation risks a number ban; for
  high-volume or commercial messaging, the official Business API is the
  appropriate route.
- **Echo handling.** Messages sent through this service are recorded by their
  WhatsApp message id, so the `message_create` echo is recognized and not stored
  twice. (`wupbot` used a counter of messages to skip, which desynchronizes if
  events arrive out of order.)
