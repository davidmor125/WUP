import { getDb } from '../db/index.js';
import logger from '../utils/logger.js';

function toApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    waMessageId: row.wa_message_id,
    sessionId: row.session_id,
    chatId: row.chat_id,
    chatType: row.chat_type,
    chatName: row.chat_name,
    direction: row.direction,
    from: row.from_id,
    to: row.to_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    type: row.type,
    hasMedia: !!row.has_media,
    media: row.has_media
      ? { mimetype: row.media_mimetype, filename: row.media_filename, path: row.media_path }
      : null,
    quotedId: row.quoted_id,
    ack: row.ack,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}

/**
 * Persist a normalized message. Returns null when the message was already
 * stored — the UNIQUE(session_id, wa_message_id) index is our dedup backstop,
 * on top of the in-memory Set in the listener.
 */
export function insertMessage(msg) {
  const db = getDb();
  try {
    const info = db.prepare(`
      INSERT INTO messages (
        wa_message_id, session_id, chat_id, chat_type, chat_name, direction,
        from_id, to_id, author_id, author_name, body, type, has_media,
        media_mimetype, media_filename, media_path, quoted_id, ack, timestamp, raw
      ) VALUES (
        @waMessageId, @sessionId, @chatId, @chatType, @chatName, @direction,
        @from, @to, @authorId, @authorName, @body, @type, @hasMedia,
        @mediaMimetype, @mediaFilename, @mediaPath, @quotedId, @ack, @timestamp, @raw
      )
      ON CONFLICT (session_id, wa_message_id) DO NOTHING
    `).run({
      waMessageId: msg.waMessageId,
      sessionId: msg.sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      chatName: msg.chatName || null,
      direction: msg.direction,
      from: msg.from || null,
      to: msg.to || null,
      authorId: msg.authorId || null,
      authorName: msg.authorName || null,
      body: msg.body || '',
      type: msg.type || 'chat',
      hasMedia: msg.hasMedia ? 1 : 0,
      mediaMimetype: msg.media?.mimetype || null,
      mediaFilename: msg.media?.filename || null,
      mediaPath: msg.media?.path || null,
      quotedId: msg.quotedId || null,
      ack: msg.ack ?? null,
      timestamp: msg.timestamp,
      raw: JSON.stringify(msg),
    });

    if (info.changes === 0) return null; // duplicate

    upsertChat(msg);
    return toApp(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) {
    logger.error(`insertMessage: ${error.message}`);
    throw error;
  }
}

/** Keep the chat list fresh: name, last message, unread counter. */
function upsertChat(msg) {
  const db = getDb();
  const preview = (msg.body || `[${msg.type}]`).slice(0, 200);
  db.prepare(`
    INSERT INTO chats (id, session_id, type, name, phone, last_message_at, last_message, unread_count)
    VALUES (@chatId, @sessionId, @chatType, @chatName, @phone, @timestamp, @preview, @unread)
    ON CONFLICT (id) DO UPDATE SET
      name            = COALESCE(excluded.name, chats.name),
      last_message_at = excluded.last_message_at,
      last_message    = excluded.last_message,
      unread_count    = CASE WHEN @unread = 1 THEN chats.unread_count + 1 ELSE chats.unread_count END
  `).run({
    chatId: msg.chatId,
    sessionId: msg.sessionId,
    chatType: msg.chatType,
    chatName: msg.chatName || null,
    phone: msg.chatType === 'private' ? String(msg.chatId).replace(/@.*$/, '') : null,
    timestamp: msg.timestamp,
    preview,
    unread: msg.direction === 'inbound' ? 1 : 0,
  });
}

/**
 * Find an outbound row the listener just stored for this exact send.
 *
 * `message_create` often fires before `client.sendMessage()` has even
 * returned, so by the time we would write a placeholder the real row — with
 * the genuine WhatsApp id — is already in the table. Reusing it avoids storing
 * the same message twice.
 */
export function findRecentOutbound({ sessionId, chatId, body, withinSeconds = 20 }) {
  const row = getDb().prepare(`
    SELECT * FROM messages
    WHERE session_id = @sessionId
      AND chat_id    = @chatId
      AND direction  = 'outbound'
      AND wa_message_id NOT LIKE 'local_%'
      AND IFNULL(body, '') = IFNULL(@body, '')
      AND created_at >= datetime('now', @window)
    ORDER BY id DESC LIMIT 1
  `).get({ sessionId, chatId, body: body || '', window: `-${withinSeconds} seconds` });

  return toApp(row);
}

/**
 * Adopt a placeholder row into the real message.
 *
 * When `client.sendMessage()` returns nothing (WhatsApp accepted the message
 * but the library failed to serialize the result), we store the row under a
 * synthetic `local_…` id. The genuine id arrives moments later on
 * `message_create`; this swaps it in so the conversation shows one message
 * rather than two near-identical ones.
 *
 * Matches only a recent, same-chat, same-body placeholder so an unrelated
 * message can never be rewritten.
 */
export function adoptLocalMessage({ sessionId, chatId, body, waMessageId, timestamp, ack }) {
  const db = getDb();
  // Match on chat + body when a body exists, but fall back to the most recent
  // placeholder in the same chat otherwise: media sends have no text, and the
  // echoed body can differ from what we stored (whitespace, transport
  // encoding). A stale placeholder is worse than a slightly loose match, and
  // the 120-second window plus the outbound/same-chat filter keeps it safe.
  const placeholder = db.prepare(`
    SELECT id, wa_message_id FROM messages
    WHERE session_id = @sessionId
      AND chat_id    = @chatId
      AND direction  = 'outbound'
      AND wa_message_id LIKE 'local_%'
      AND created_at >= datetime('now', '-120 seconds')
    ORDER BY
      CASE WHEN IFNULL(body, '') = IFNULL(@body, '') THEN 0 ELSE 1 END,
      id DESC
    LIMIT 1
  `).get({ sessionId, chatId, body: body || '' });

  if (!placeholder) return null;

  try {
    db.prepare(`
      UPDATE messages SET wa_message_id = @waMessageId, timestamp = @timestamp, ack = @ack
      WHERE id = @id
    `).run({
      id: placeholder.id,
      waMessageId,
      timestamp: timestamp || new Date().toISOString(),
      ack: ack ?? null,
    });
    return placeholder.id;
  } catch (error) {
    // A UNIQUE clash means the real row already landed by another path; the
    // placeholder is then redundant, so drop it.
    db.prepare('DELETE FROM messages WHERE id = ?').run(placeholder.id);
    logger.debug(`adoptLocalMessage: dropped redundant placeholder (${error.message})`);
    return null;
  }
}

/**
 * Attach media details to an already-stored message.
 *
 * Used when the sender holds the bytes but the listener wrote the row first —
 * the row is authoritative for ids and timing, while the sender is the only
 * reliable source for the file itself.
 */
export function attachMediaToMessage(sessionId, waMessageId, { mimetype, filename, path }) {
  try {
    getDb().prepare(`
      UPDATE messages
      SET has_media = 1, media_mimetype = @mimetype, media_filename = @filename, media_path = @path
      WHERE session_id = @sessionId AND wa_message_id = @waMessageId
    `).run({ sessionId, waMessageId, mimetype: mimetype || null, filename: filename || null, path });
  } catch (error) {
    logger.error(`attachMediaToMessage: ${error.message}`);
  }
}

export function updateAck(sessionId, waMessageId, ack) {
  try {
    getDb().prepare(
      'UPDATE messages SET ack = ? WHERE session_id = ? AND wa_message_id = ?'
    ).run(ack, sessionId, waMessageId);
  } catch (error) {
    logger.error(`updateAck: ${error.message}`);
  }
}

export function getMessages({ sessionId, chatId, chatType, direction, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (sessionId) { where.push('session_id = @sessionId'); params.sessionId = sessionId; }
  if (chatId) { where.push('chat_id = @chatId'); params.chatId = chatId; }
  if (chatType) { where.push('chat_type = @chatType'); params.chatType = chatType; }
  if (direction) { where.push('direction = @direction'); params.direction = direction; }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM messages ${clause} ORDER BY timestamp DESC, id DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });

  return rows.map(toApp);
}

export function countMessages({ sessionId, chatId } = {}) {
  const where = [];
  const params = {};
  if (sessionId) { where.push('session_id = @sessionId'); params.sessionId = sessionId; }
  if (chatId) { where.push('chat_id = @chatId'); params.chatId = chatId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb().prepare(`SELECT COUNT(*) AS n FROM messages ${clause}`).get(params).n;
}

export function getChats({ sessionId, type, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (sessionId) { where.push('session_id = @sessionId'); params.sessionId = sessionId; }
  if (type) { where.push('type = @type'); params.type = type; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return getDb().prepare(
    `SELECT * FROM chats ${clause} ORDER BY last_message_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    name: row.name,
    phone: row.phone,
    lastMessageAt: row.last_message_at,
    lastMessage: row.last_message,
    unreadCount: row.unread_count,
  }));
}

export function markChatRead(chatId) {
  getDb().prepare('UPDATE chats SET unread_count = 0 WHERE id = ?').run(chatId);
}

export function getStats(sessionId) {
  const db = getDb();
  const params = sessionId ? { sessionId } : {};
  const clause = sessionId ? 'WHERE session_id = @sessionId' : '';
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                AS total,
      SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
      SUM(CASE WHEN chat_type = 'group'    THEN 1 ELSE 0 END) AS groupMessages
    FROM messages ${clause}
  `).get(params);
  const chats = db.prepare(`SELECT COUNT(*) AS n FROM chats ${clause}`).get(params).n;

  return {
    total: row.total || 0,
    inbound: row.inbound || 0,
    outbound: row.outbound || 0,
    groupMessages: row.groupMessages || 0,
    chats,
  };
}
