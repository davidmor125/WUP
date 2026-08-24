-- WUP — WhatsApp bridge schema
--
-- The server applies this automatically at startup (see src/db/index.js), so
-- you normally never run it by hand. It is kept here as the readable, canonical
-- definition — for reviewing the shape of the data, for restoring a database,
-- or for porting the design to another engine.
--
--   Apply manually:  node scripts/init-db.mjs
--   Or with sqlite3: sqlite3 data/wup.db < src/db/schema.sql
--
-- Every statement is IF NOT EXISTS, so running it against a populated database
-- is a no-op rather than destructive.

PRAGMA journal_mode = WAL;   -- HTTP reads proceed while the listener writes
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────────
-- chats — one row per conversation, person or group
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,   -- full WhatsApp chat id: 972500000000@c.us, 1234-5678@g.us
  session_id      TEXT NOT NULL,      -- which linked device this belongs to
  type            TEXT NOT NULL,      -- 'private' | 'group'
  name            TEXT,               -- contact name or group subject
  phone           TEXT,               -- bare number; NULL for groups
  last_message_at TEXT,
  last_message    TEXT,               -- preview text for the chat list
  unread_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id, last_message_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- messages — every message in and out, groups included
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id  TEXT NOT NULL,       -- WhatsApp's own id; the dedup key
  session_id     TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  chat_type      TEXT NOT NULL,       -- 'private' | 'group'
  chat_name      TEXT,
  direction      TEXT NOT NULL,       -- 'inbound' | 'outbound'
  from_id        TEXT,
  to_id          TEXT,
  -- In a group WhatsApp puts the GROUP in from_id and the person in author_id,
  -- which is why the author is stored separately rather than inferred.
  author_id      TEXT,
  author_name    TEXT,
  body           TEXT,
  type           TEXT,                -- chat | image | audio | ptt | sticker | document | ...
  has_media      INTEGER NOT NULL DEFAULT 0,
  media_mimetype TEXT,
  media_filename TEXT,
  media_path     TEXT,                -- relative path under data/media/
  quoted_id      TEXT,                -- message this one replies to
  ack            INTEGER,             -- 1 sent, 2 delivered, 3 read, 4 played
  timestamp      TEXT NOT NULL,
  raw            TEXT,                -- JSON of the normalized event
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- The backstop against double-storing a message: `message_create` can fire
  -- twice for the same message after a reconnect or multi-device sync.
  UNIQUE (session_id, wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(session_id, chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(session_id, timestamp DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- settings — server-side key/value (currently the rotatable API key)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- webhooks — outbound event subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  url         TEXT NOT NULL,
  secret      TEXT,                             -- HMAC-SHA256 signing secret
  events      TEXT NOT NULL DEFAULT '[]',       -- JSON array of event names
  chat_filter TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'private' | 'group'
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_deliveries — one row per delivery attempt sequence, for the UI log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,        -- JSON envelope that was POSTed
  status       TEXT NOT NULL,        -- 'pending' | 'sent' | 'failed'
  attempts     INTEGER NOT NULL DEFAULT 0,
  status_code  INTEGER,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
