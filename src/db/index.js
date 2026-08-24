import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config/env.js';
import logger from '../utils/logger.js';

let db = null;

/**
 * Open (and migrate) the SQLite file. Everything the service persists —
 * messages, chats, webhook endpoints and delivery attempts — lives here.
 * One file, no external service to run.
 */
export function initDb() {
  if (db) return db;

  const file = path.resolve(config.db.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new Database(file);
  // WAL lets the HTTP reads run while the WhatsApp listener writes.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  logger.info(`SQLite ready at ${file}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function migrate(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id            TEXT PRIMARY KEY,          -- full chat id, e.g. 972500000000@c.us / 1234@g.us
      session_id    TEXT NOT NULL,
      type          TEXT NOT NULL,             -- 'private' | 'group'
      name          TEXT,
      phone         TEXT,                      -- bare number for private chats
      last_message_at TEXT,
      last_message  TEXT,
      unread_count  INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chats_session ON chats(session_id, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_message_id TEXT NOT NULL,             -- WhatsApp's own id, used for dedup
      session_id    TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      chat_type     TEXT NOT NULL,             -- 'private' | 'group'
      chat_name     TEXT,
      direction     TEXT NOT NULL,             -- 'inbound' | 'outbound'
      from_id       TEXT,                      -- chat id the message came from
      to_id         TEXT,
      author_id     TEXT,                      -- in groups: the participant who wrote it
      author_name   TEXT,
      body          TEXT,
      type          TEXT,                      -- chat | image | audio | ptt | document | ...
      has_media     INTEGER NOT NULL DEFAULT 0,
      media_mimetype TEXT,
      media_filename TEXT,
      media_path    TEXT,
      quoted_id     TEXT,
      ack           INTEGER,                   -- delivery state: 1 sent, 2 delivered, 3 read
      timestamp     TEXT NOT NULL,
      raw           TEXT,                      -- JSON blob of the normalized event
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (session_id, wa_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(session_id, chat_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(session_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT,
      url         TEXT NOT NULL,
      secret      TEXT,                        -- HMAC-SHA256 signing secret
      events      TEXT NOT NULL DEFAULT '[]',  -- JSON array of event names
      chat_filter TEXT NOT NULL DEFAULT 'all', -- 'all' | 'private' | 'group'
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id   INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event        TEXT NOT NULL,
      payload      TEXT NOT NULL,
      status       TEXT NOT NULL,              -- 'pending' | 'sent' | 'failed'
      attempts     INTEGER NOT NULL DEFAULT 0,
      status_code  INTEGER,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
  `);
}
