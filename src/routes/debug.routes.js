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

/**
 * GET /api/debug/lid-map
 * Does the WhatsApp store expose the link between a contact's @lid identity and
 * their phone-number identity? Used to decide how chats and contacts can be
 * merged without showing the same person twice.
 */
router.get('/lid-map', async (req, res) => {
  const client = getClient(req.query.sessionId || config.whatsapp.defaultSessionId);
  if (!client?.pupPage) return res.status(503).json({ success: false, message: 'No active client' });

  try {
    const data = await client.pupPage.evaluate(() => {
      const out = { modules: [], samples: [] };
      // Which LID-related modules does this build expose?
      for (const name of ['WAWebApiContact', 'WAWebLidMigrationUtils', 'WAWebWidToLidCache',
        'WAWebLidPnCache', 'WAWebContactGetters', 'WAWebCollections']) {
        try { out.modules.push({ name, keys: Object.keys(window.require(name)).slice(0, 25) }); }
        catch (e) { out.modules.push({ name, error: String(e?.message || e).slice(0, 80) }); }
      }
      // Sample a few LID contacts and see what identity fields they carry.
      try {
        const contacts = window.require('WAWebCollections').Contact.getModelsArray();
        for (const c of contacts.filter((x) => x.id?._serialized?.endsWith('@lid')).slice(0, 5)) {
          const pick = (fn) => { try { return fn(); } catch { return null; } };
          out.samples.push({
            id: pick(() => c.id?._serialized),
            name: pick(() => c.name) || pick(() => c.pushname),
            phoneNumber: pick(() => c.phoneNumber?._serialized) || pick(() => c.phoneNumber),
            pnForLid: pick(() => c.pnForLid?._serialized) || pick(() => c.pnForLid),
            lidForPn: pick(() => c.lidForPn?._serialized) || pick(() => c.lidForPn),
            fields: pick(() => Object.keys(c.serialize?.() || {}).slice(0, 30)),
          });
        }
      } catch (e) { out.samplesError = String(e?.message || e); }
      return out;
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
