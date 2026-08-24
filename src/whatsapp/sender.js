import fs from 'node:fs';
import path from 'node:path';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import { getClient, getClientState } from './client.js';
import { toChatId, isGroupChatId } from '../utils/phone.js';
import { insertMessage, findRecentOutbound, attachMediaToMessage } from '../services/messages.service.js';
import { emitMessage } from '../services/events.service.js';
import logger from '../utils/logger.js';

/**
 * Ids of messages this service sent.
 *
 * `message_create` echoes every outgoing message back to the listener, which
 * would store it a second time. wupbot handled this with a counter of messages
 * to ignore — fragile, because any ordering hiccup desynchronizes it. Tracking
 * the actual message id is exact: the echo is recognized no matter when it lands.
 */
const sentMessageIds = new Set();
const MAX_SENT_IDS = 2000;

function rememberSent(waMessageId) {
  if (!waMessageId) return;
  sentMessageIds.add(waMessageId);
  if (sentMessageIds.size > MAX_SENT_IDS) {
    const all = [...sentMessageIds];
    sentMessageIds.clear();
    for (const id of all.slice(all.length - 1000)) sentMessageIds.add(id);
  }
}

export function wasSentByUs(waMessageId) {
  return sentMessageIds.has(waMessageId);
}

function requireReadyClient(sessionId) {
  const state = getClientState(sessionId);
  if (state.status !== 'ready') {
    const err = new Error(`WhatsApp session "${sessionId}" is not connected (status: ${state.status})`);
    err.statusCode = 503;
    throw err;
  }
  const client = getClient(sessionId);
  if (!client) {
    const err = new Error(`WhatsApp session "${sessionId}" has no active client`);
    err.statusCode = 503;
    throw err;
  }
  return client;
}

/** Build a MessageMedia from a base64 blob, a local path, or a remote URL. */
async function buildMedia({ base64, mimetype, filename, url, filePath }) {
  if (base64) return new MessageMedia(mimetype || 'application/octet-stream', base64, filename || null);
  if (url) return MessageMedia.fromUrl(url, { unsafeMime: true, filename: filename || undefined });
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`Media file not found: ${filePath}`);
    return MessageMedia.fromFilePath(resolved);
  }
  return null;
}

const MEDIA_DIR = path.resolve('data/media');

/**
 * Persist media we are sending, so the conversation can display it afterwards.
 * Inbound media is saved by the listener; without this, an image you sent shows
 * as an empty bubble because the bytes only ever existed in the request body.
 */
function saveOutgoingMedia(waMessageId, built, { filename, mimetype }) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const mime = built.mimetype || mimetype || '';
    const extFromName = filename?.includes('.') ? filename.split('.').pop() : null;
    const ext = extFromName || mime.split('/')[1]?.split(';')[0] || 'bin';
    const safeId = String(waMessageId).replace(/[^\w.-]/g, '_');
    const name = `${safeId}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(built.data, 'base64'));
    return `data/media/${name}`;
  } catch (error) {
    logger.warn(`Could not save outgoing media for ${waMessageId}: ${error.message}`);
    return null;
  }
}

/**
 * Send a WhatsApp message to a private chat or a group.
 *
 * `to` accepts a bare phone number (972500000000), a full chat id
 * (972500000000@c.us) or a group id (1234567890-1234@g.us) — toChatId()
 * passes through anything that already carries a suffix.
 */
export async function sendMessage(sessionId, { to, body, media, quotedMessageId, mentions, linkPreview = true }) {
  const client = requireReadyClient(sessionId);

  if (!to) {
    const err = new Error('`to` is required');
    err.statusCode = 400;
    throw err;
  }
  if (!body?.trim() && !media) {
    const err = new Error('Either `body` or `media` is required');
    err.statusCode = 400;
    throw err;
  }

  const chatId = toChatId(to);
  const options = { linkPreview };
  if (quotedMessageId) options.quotedMessageId = quotedMessageId;
  if (Array.isArray(mentions) && mentions.length) options.mentions = mentions.map(toChatId);

  let content = body?.trim() || '';
  let builtMedia = null;
  if (media) {
    builtMedia = await buildMedia(media);
    if (!builtMedia) {
      const err = new Error('media requires one of: base64, url, filePath');
      err.statusCode = 400;
      throw err;
    }
    if (content) options.caption = content;
    content = builtMedia;
  }

  // The library returns `undefined` when WhatsApp accepted the message but its
  // own serialization of the result failed (the same getMessageModel/
  // getChatModel breakage that takes down getChats on current WhatsApp Web).
  // The message IS delivered in that case, so treating it as an error would be
  // wrong — and would tempt the caller into sending a duplicate. Fall back to a
  // synthetic local id; the real one arrives moments later on `message_create`,
  // where the listener stores the authoritative row.
  const sent = await client.sendMessage(chatId, content, options);
  const chatType = isGroupChatId(chatId) ? 'group' : 'private';

  // `message_create` frequently fires before sendMessage() returns, so when the
  // client gives us nothing to identify the message with, the listener has
  // usually already stored it under its real id. Return that row instead of
  // writing a second one under a synthetic id.
  if (!sent?.id) {
    const existing = findRecentOutbound({ sessionId, chatId, body: body?.trim() || '' });
    if (existing) {
      // We already hold the bytes, so attach them to the listener's row rather
      // than relying on its download — which is the very call that fails for
      // these chats, and would leave the sent image blank in the UI.
      if (builtMedia && !existing.media?.path) {
        const savedPath = saveOutgoingMedia(existing.waMessageId, builtMedia, media);
        if (savedPath) {
          attachMediaToMessage(sessionId, existing.waMessageId, {
            mimetype: builtMedia.mimetype || media.mimetype || null,
            filename: builtMedia.filename || media.filename || null,
            path: savedPath,
          });
          existing.hasMedia = true;
          existing.media = { mimetype: builtMedia.mimetype, filename: builtMedia.filename, path: savedPath };
        }
      }
      logger.info(`Sent[${sessionId}] → ${chatId}: ${(body || '[media]').slice(0, 100)} (matched listener row)`);
      return existing;
    }
  }

  const waMessageId = sent?.id?._serialized || sent?.id?.id || `local_${chatId}_${Date.now()}`;
  rememberSent(waMessageId);

  let chatName = null;
  try {
    chatName = (await sent?.getChat())?.name || null;
  } catch { /* name is optional */ }

  const stored = insertMessage({
    waMessageId,
    sessionId,
    chatId,
    chatType,
    chatName,
    direction: 'outbound',
    from: sent?.from || null,
    to: chatId,
    authorId: sent?.from || null,
    authorName: null,
    body: body?.trim() || '',
    type: sent?.type || (media ? (builtMedia?.mimetype?.split('/')[0] || 'media') : 'chat'),
    hasMedia: !!media,
    media: builtMedia
      ? {
        mimetype: builtMedia.mimetype || media.mimetype || null,
        filename: builtMedia.filename || media.filename || null,
        path: saveOutgoingMedia(waMessageId, builtMedia, media),
      }
      : null,
    quotedId: quotedMessageId || null,
    ack: typeof sent?.ack === 'number' ? sent.ack : 0,
    timestamp: new Date((sent?.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  });

  if (!sent) {
    logger.warn(`Sent[${sessionId}] → ${chatId}: delivered, but the client returned no message object (using local id).`);
  }
  logger.info(`Sent[${sessionId}] → ${chatId}: ${(body || '[media]').slice(0, 100)}`);
  if (stored) emitMessage(stored);

  return stored || { waMessageId, chatId, chatType, direction: 'outbound', body: body?.trim() || '' };
}

/**
 * All chats the linked device can see, split into groups and private chats.
 *
 * This reads the WhatsApp Web chat collection directly rather than calling
 * `client.getChats()`. The library's version enriches every chat through
 * `getChatModel()`, which throws against the current WhatsApp Web build (the
 * error surfaces only as a minified `"r"`), taking the whole listing down with
 * it. The fields we need — id, title, unread count, timestamp — are on the
 * chat model already, and each one is read defensively so a single unreadable
 * chat cannot fail the request.
 */
export async function fetchChats(sessionId, { type } = {}) {
  const client = requireReadyClient(sessionId);

  const read = () => client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    return chats.map((c) => {
      const pick = (fn) => { try { return fn(); } catch { return null; } };
      const id = pick(() => c.id?._serialized);
      if (!id) return null;
      return {
        id,
        name: pick(() => c.formattedTitle) || pick(() => c.name) || null,
        unreadCount: pick(() => c.unreadCount) || 0,
        timestamp: pick(() => c.t) || null,
        archived: !!pick(() => c.archive),
        participantsCount: pick(() => c.groupMetadata?.participants?.length) || 0,
      };
    }).filter(Boolean);
  });

  let chats;
  try {
    chats = await read();
  } catch (err) {
    // A detached frame means Chromium navigated under us; reload and retry once.
    if (err.message?.includes('detached Frame')) {
      logger.warn('Detached frame on getChats — retrying after page refresh...');
      await client.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      await new Promise((r) => setTimeout(r, 3000));
      chats = await read();
    } else {
      throw err;
    }
  }

  return chats
    .map((c) => {
      const isGroup = c.id.endsWith('@g.us');
      return {
        id: c.id,
        name: c.name || (isGroup ? '(unnamed group)' : c.id.replace(/@.*$/, '')),
        type: isGroup ? 'group' : 'private',
        phone: isGroup ? null : c.id.replace(/@.*$/, ''),
        unreadCount: c.unreadCount,
        participantsCount: c.participantsCount,
        archived: c.archived,
        lastMessageAt: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
      };
    })
    .filter((c) => (type === 'group' ? c.type === 'group' : type === 'private' ? c.type === 'private' : true))
    .sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
}

/**
 * Saved contacts on the linked device, plus the groups it belongs to.
 *
 * WhatsApp Web's contact store returns the same contact more than once (it
 * holds separate records for the phone-number identity and the linked-device
 * LID identity), so results are deduplicated by id and sorted by name.
 */
export async function fetchContacts(sessionId, { search, includeGroups = true } = {}) {
  const client = requireReadyClient(sessionId);

  let contacts;
  try {
    contacts = await client.getContacts();
  } catch (err) {
    if (err.message?.includes('detached Frame')) {
      logger.warn('Detached frame on getContacts — retrying after page refresh...');
      if (client.pupPage) {
        await client.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
        await new Promise((r) => setTimeout(r, 3000));
      }
      contacts = await client.getContacts();
    } else {
      throw err;
    }
  }

  const byId = new Map();
  for (const c of contacts) {
    const id = c.id?._serialized;
    if (!id) continue;

    const isGroup = id.endsWith('@g.us');
    if (isGroup && !includeGroups) continue;
    // Keep saved contacts and groups; skip status broadcasts and strangers.
    if (!isGroup && !(id.endsWith('@c.us') && c.isMyContact)) continue;

    const name = c.name || c.pushname || c.verifiedName || null;
    const existing = byId.get(id);
    // Prefer the duplicate that actually carries a name.
    if (existing && (existing.name || !name)) continue;

    byId.set(id, {
      id,
      type: isGroup ? 'group' : 'private',
      phone: isGroup ? null : c.id.user,
      name,
      isMe: !!c.isMe,
      isBusiness: !!c.isBusiness,
    });
  }

  let result = [...byId.values()];

  if (search?.trim()) {
    const q = search.trim().toLowerCase();
    // Only match on digits when the query actually contains some — otherwise
    // the empty digit-string makes `phone.includes('')` true for everyone.
    const digits = q.replace(/\D/g, '');
    result = result.filter((c) =>
      c.name?.toLowerCase().includes(q) || (digits && c.phone?.includes(digits)));
  }

  return result.sort((a, b) => {
    // Groups first, then named contacts, then bare numbers.
    if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
    if (!!a.name !== !!b.name) return a.name ? -1 : 1;
    return (a.name || a.phone || '').localeCompare(b.name || b.phone || '');
  });
}
