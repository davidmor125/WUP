import { Router } from 'express';
import { sendMessage } from '../whatsapp/sender.js';
import {
  getMessages, countMessages, getChats, markChatRead, getStats,
} from '../services/messages.service.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

const router = Router();

function sessionOf(req) {
  return req.query.sessionId || req.body?.sessionId || config.whatsapp.defaultSessionId;
}

/**
 * POST /api/messages
 * Send a message to a person or a group.
 *
 * Body: {
 *   to,                 // "972500000000" | "972500000000@c.us" | "123-456@g.us"
 *   body,               // text (or caption when media is attached)
 *   media?,             // { base64, mimetype, filename } | { url } | { filePath }
 *   quotedMessageId?,   // reply to a specific message
 *   mentions?,          // ["972500000000"] — group mentions
 *   linkPreview?        // default true
 * }
 */
router.post('/', async (req, res) => {
  try {
    const message = await sendMessage(sessionOf(req), req.body || {});
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    logger.error(`POST /api/messages: ${error.message}`);
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/messages
 * Stored history. Filter by chatId, chatType (private|group) and direction.
 */
router.get('/', (req, res) => {
  try {
    const { chatId, chatType, direction } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const sessionId = sessionOf(req);

    const data = getMessages({ sessionId, chatId, chatType, direction, limit, offset });
    res.json({ success: true, count: data.length, total: countMessages({ sessionId, chatId }), data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/messages/stats — counts by direction and chat type. */
router.get('/stats', (req, res) => {
  try {
    res.json({ success: true, data: getStats(sessionOf(req)) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/messages/chats — stored chat list (people + groups). */
router.get('/chats', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const data = getChats({ sessionId: sessionOf(req), type: req.query.type, limit, offset });
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/messages/chats/:chatId/read — clear the unread badge. */
router.post('/chats/:chatId/read', (req, res) => {
  try {
    markChatRead(req.params.chatId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
