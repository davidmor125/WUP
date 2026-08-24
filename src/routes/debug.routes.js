import { Router } from 'express';
import { getClient } from '../whatsapp/client.js';
import config from '../config/env.js';

const router = Router();

/**
 * GET /api/debug/raw-chats
 * Reads the chat collection straight out of the WhatsApp Web store, skipping
 * whatsapp-web.js's getChatModel() enrichment. Used to confirm whether a
 * getChats() failure is in the listing or in the per-chat serialization.
 */
router.get('/raw-chats', async (req, res) => {
  const client = getClient(req.query.sessionId || config.whatsapp.defaultSessionId);
  if (!client?.pupPage) return res.status(503).json({ success: false, message: 'No active client' });

  try {
    const data = await client.pupPage.evaluate(() => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      return chats.slice(0, 5).map((c) => {
        const out = { id: c.id?._serialized, isGroup: c.id?._serialized?.endsWith('@g.us') };
        try { out.formattedTitle = c.formattedTitle; } catch (e) { out.titleError = String(e?.message || e); }
        try { out.serialized = !!c.serialize(); } catch (e) { out.serializeError = String(e?.message || e); }
        return out;
      });
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, stack: error.stack?.slice(0, 400) });
  }
});

export default router;
