#!/usr/bin/env node
/**
 * Create (or inspect) the WUP database.
 *
 *   node scripts/init-db.mjs            create/upgrade the schema, then report
 *   node scripts/init-db.mjs --status   report only, change nothing
 *   node scripts/init-db.mjs --reset    DROP every table, then recreate
 *
 * The server applies the same schema at startup, so this is for setting a
 * database up ahead of time, checking what is stored, or starting clean.
 *
 * The target file comes from DB_FILE (default data/wup.db), so it always
 * matches whatever the server itself would open.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../src/db/schema.sql');
const DB_PATH = path.resolve(process.env.DB_FILE || 'data/wup.db');

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const reset = args.has('--reset');

// Dropped in reverse dependency order: webhook_deliveries references webhooks.
const TABLES = ['webhook_deliveries', 'webhooks', 'settings', 'messages', 'chats'];

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function report(db) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();

  if (rows.length === 0) {
    console.log('\nNo tables found.');
    return;
  }

  console.log('\nTables:');
  for (const { name } of rows) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    console.log(`  ${name.padEnd(20)} ${String(count).padStart(7)} rows`);
  }

  // A quick sense of what has actually been captured.
  const hasMessages = rows.some((r) => r.name === 'messages');
  if (hasMessages) {
    const s = db.prepare(`
      SELECT
        SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
        SUM(CASE WHEN chat_type = 'group'    THEN 1 ELSE 0 END) AS groups,
        SUM(has_media)                                          AS media
      FROM messages
    `).get();
    if (s.inbound || s.outbound) {
      console.log(`\n  messages: ${s.inbound || 0} in, ${s.outbound || 0} out, ` +
                  `${s.groups || 0} in groups, ${s.media || 0} with media`);
    }
  }
}

function main() {
  console.log(`Database: ${DB_PATH}`);
  const existed = fs.existsSync(DB_PATH);
  console.log(existed ? 'Status:   exists' : 'Status:   will be created');

  const db = open();

  if (statusOnly) {
    report(db);
    db.close();
    return;
  }

  if (reset) {
    // Refuse to silently destroy data: require the extra flag so a stray
    // --reset in a shell history can't wipe a live database.
    if (!args.has('--yes')) {
      console.error('\n--reset drops every table and deletes all stored messages.');
      console.error('Re-run with --reset --yes to confirm.');
      process.exitCode = 1;
      db.close();
      return;
    }
    console.log('\nDropping tables…');
    db.pragma('foreign_keys = OFF');
    for (const t of TABLES) {
      db.exec(`DROP TABLE IF EXISTS "${t}"`);
      console.log(`  dropped ${t}`);
    }
    db.pragma('foreign_keys = ON');
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  console.log(`\n✅ Schema applied from ${path.relative(process.cwd(), SCHEMA_PATH)}`);

  report(db);
  db.close();
}

main();
