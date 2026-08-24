import fs from 'node:fs';
import path from 'node:path';
import { getClient } from './client.js';
import { wasSentByUs } from './sender.js';
import { isGroupChatId } from '../utils/phone.js';
import { insertMessage, updateAck, adoptLocalMessage } from '../services/messages.service.js';
import { emitMessage, emitAck } from '../services/events.service.js';
import logger from '../utils/logger.js';

// ── Dedup ───────────────────────────────────────────────────────────────────
// whatsapp-web.js can fire message_create more than once for the same message
// (reconnects, multi-device sync). Keep the recent ids in memory; the UNIQUE
// index on (session_id, wa_message_id) is the second line of defence.
const processedMessageIds = new Set();
const MAX_DEDUP_SIZE = 2000;

function markProcessed(msgId) {
  if (!msgId) return false;
  if (processedMessageIds.has(msgId)) return true; // already seen
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > MAX_DEDUP_SIZE) {
    const all = [...processedMessageIds];
    processedMessageIds.clear();
    for (const id of all.slice(all.length - 1000)) processedMessageIds.add(id);
  }
  return false;
}

const MEDIA_DIR = path.resolve('data/media');

/** Save downloaded media to disk and return its relative path. */
function saveMedia(waMessageId, media) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = (media.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
  const safeId = String(waMessageId).replace(/[^\w.-]/g, '_');
  const filename = `${safeId}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), Buffer.from(media.data, 'base64'));
  return `data/media/${filename}`;
}

/**
 * Resolve the human-readable chat name. For groups this is the group subject;
 * for private chats the contact's saved name or pushname.
 */
async function resolveChatName(message) {
  try {
    const chat = await message.getChat();
    return chat?.name || null;
  } catch {
    return null;
  }
}

async function resolveAuthorName(message) {
  try {
    const contact = await message.getContact();
    return contact?.name || contact?.pushname || contact?.number || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a whatsapp-web.js Message into our own shape.
 *
 * The important subtlety for groups: `message.from` is the GROUP id, and
 * `message.author` is the participant who actually wrote it. For outgoing
 * messages the roles flip — `message.to` carries the chat.
 */
async function normalize(sessionId, message, { downloadMedia = true } = {}) {
  const waMessageId = message.id?._serialized || message.id?.id;
  const direction = message.fromMe ? 'outbound' : 'inbound';

  // The chat id is whichever end is not us.
  const chatId = message.fromMe ? (message.to || message.from) : message.from;
  const chatType = isGroupChatId(chatId) ? 'group' : 'private';

  const normalized = {
    waMessageId,
    sessionId,
    chatId,
    chatType,
    chatName: await resolveChatName(message),
    direction,
    from: message.from || null,
    to: message.to || null,
    // In a group, `author` names the participant. In a private chat the author
    // is simply the other end (or us, for outgoing).
    authorId: message.author || (message.fromMe ? message.to : message.from) || null,
    authorName: chatType === 'group' && !message.fromMe ? await resolveAuthorName(message) : null,
    body: message.body || '',
    type: message.type || 'chat',
    hasMedia: !!message.hasMedia,
    media: null,
    quotedId: message.hasQuotedMsg ? (message._data?.quotedStanzaID || null) : null,
    ack: typeof message.ack === 'number' ? message.ack : null,
    timestamp: new Date((message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };

  if (message.hasMedia && downloadMedia) {
    // downloadMedia() can return undefined rather than throwing when the
    // library fails to serialize the payload, and it can legitimately return
    // nothing while WhatsApp is still fetching the file. One retry covers the
    // transient case; either way the outcome is logged, because a silent miss
    // leaves an empty bubble in the UI with no clue why.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const media = await message.downloadMedia();
        if (media?.data) {
          normalized.media = {
            mimetype: media.mimetype || null,
            filename: media.filename || null,
            path: saveMedia(waMessageId, media),
          };
          break;
        }
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        logger.warn(`Media unavailable for ${waMessageId} (type=${normalized.type}) — client returned no data.`);
      } catch (error) {
        logger.warn(`Media download failed for ${waMessageId} (attempt ${attempt}): ${error.message}`);
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  return normalized;
}

/**
 * Bound to `message_create`, so this fires for BOTH directions — incoming
 * messages and anything sent from the linked phone or from this service.
 * Groups and private chats are both handled; nothing is filtered out.
 */
export async function handleIncomingMessage(sessionId, message) {
  if (!sessionId) {
    logger.warn('handleIncomingMessage called without sessionId — skipping.');
    return;
  }

  const waMessageId = message.id?._serialized || message.id?.id;
  if (markProcessed(waMessageId)) {
    logger.debug(`Dedup: skipping already-processed message ${waMessageId}`);
    return;
  }

  try {
    const normalized = await normalize(sessionId, message);

    // Messages this service sent are already persisted by sender.js (so the
    // API response can return the stored row). Skip the duplicate write, but
    // still let the event through — subscribers see one event per message.
    if (normalized.direction === 'outbound' && wasSentByUs(waMessageId)) {
      logger.debug(`Echo of our own send ${waMessageId} — already stored.`);
      return;
    }

    // A send whose result the library failed to serialize was stored under a
    // synthetic `local_…` id. This echo carries the real id, so adopt the
    // placeholder rather than inserting a second copy of the same message.
    if (normalized.direction === 'outbound') {
      const adopted = adoptLocalMessage({
        sessionId,
        chatId: normalized.chatId,
        body: normalized.body,
        waMessageId,
        timestamp: normalized.timestamp,
        ack: normalized.ack,
      });
      if (adopted) {
        logger.debug(`Adopted local placeholder → ${waMessageId}`);
        return;
      }
    }

    const stored = insertMessage(normalized);
    if (!stored) return; // duplicate caught at the DB level

    const label = normalized.chatType === 'group'
      ? `${normalized.chatName || normalized.chatId} / ${normalized.authorName || normalized.authorId}`
      : normalized.chatId;
    logger.info(`Message[${sessionId}] ${normalized.direction} ${label}: ${(normalized.body || `[${normalized.type}]`).slice(0, 100)}`);

    emitMessage(stored);
  } catch (error) {
    logger.error(`handleIncomingMessage failed: ${error.message}`);
  }
}

/** Delivery receipts: 1 = sent, 2 = delivered, 3 = read, 4 = played. */
export function handleMessageAck(sessionId, message, ack) {
  const waMessageId = message?.id?._serialized || message?.id?.id;
  if (!waMessageId) return;
  updateAck(sessionId, waMessageId, ack);
  emitAck(sessionId, waMessageId, ack);
}

/** Expose the client lookup so routes don't need to import two modules. */
export { getClient };
