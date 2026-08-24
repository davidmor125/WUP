import { Router } from 'express';
import {
  getClientState, listSessions, initializeClient, initializeClientWithPhone,
  destroyClient, logoutClient,
} from '../whatsapp/client.js';
import { getQRDataURL, getRawQR } from '../whatsapp/qrManager.js';
import { fetchChats, fetchContacts } from '../whatsapp/sender.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

const router = Router();

/** Session id comes from the query/body, falling back to the configured default. */
function sessionOf(req) {
  return req.query.sessionId || req.body?.sessionId || config.whatsapp.defaultSessionId;
}

/** GET /api/whatsapp/sessions — every known session and its status. */
router.get('/sessions', (req, res) => {
  res.json({ success: true, data: listSessions() });
});

/** GET /api/whatsapp/status — connection state for one session. */
router.get('/status', (req, res) => {
  res.json({ success: true, data: getClientState(sessionOf(req)) });
});

/** GET /api/whatsapp/qr-data — QR as a data URL, for the frontend to render. */
router.get('/qr-data', async (req, res) => {
  const sessionId = sessionOf(req);
  if (!getRawQR(sessionId)) {
    return res.json({ success: false, data: null, message: 'No QR available — the session may already be authenticated.' });
  }
  res.json({ success: true, data: { qr: await getQRDataURL(sessionId), sessionId } });
});

/** GET /api/whatsapp/qr — standalone scannable page (handy without the SPA). */
router.get('/qr', async (req, res) => {
  const sessionId = sessionOf(req);
  const dataURL = await getQRDataURL(sessionId);
  if (!dataURL) {
    return res.status(404).type('html').send('<p>No QR available. The session may already be authenticated.</p>');
  }
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WUP — Link WhatsApp</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
  .card { background: #fff; padding: 2rem; border-radius: 12px; text-align: center;
          box-shadow: 0 2px 10px rgba(0,0,0,.1); }
  img { width: 300px; height: 300px; }
  p { color: #52525b; font-size: .875rem; }
</style></head>
<body><div class="card">
  <h2>Scan with WhatsApp</h2>
  <img src="${dataURL}" alt="WhatsApp QR code" />
  <p>Session: <code>${sessionId}</code> — page refreshes every 10s</p>
</div></body></html>`);
});

/** POST /api/whatsapp/connect — start (or restart) a session and surface a QR. */
router.post('/connect', async (req, res) => {
  const sessionId = sessionOf(req);
  try {
    const state = getClientState(sessionId);
    if (state.status === 'ready' || state.status === 'authenticated') {
      return res.json({ success: true, message: 'Already connected', alreadyConnected: true, data: state });
    }
    await destroyClient(sessionId, { keepReconnecting: true });
    // Don't await: initialize() only resolves once the phone has scanned.
    initializeClient(sessionId).catch((err) =>
      logger.error(`connect[${sessionId}] failed: ${err.message}`));
    res.json({ success: true, message: 'Connecting — poll /status and /qr-data', data: { sessionId } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/whatsapp/pair — link by phone number instead of QR. */
router.post('/pair', async (req, res) => {
  const sessionId = sessionOf(req);
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'phoneNumber is required' });
  }
  try {
    const state = getClientState(sessionId);
    if (state.status === 'ready' || state.status === 'authenticated') {
      return res.status(409).json({ success: false, message: 'Already connected — disconnect first to re-pair' });
    }
    const code = await initializeClientWithPhone(sessionId, phoneNumber.replace(/\D/g, ''));
    res.json({ success: true, data: { code, sessionId } });
  } catch (error) {
    logger.error(`pair[${sessionId}] error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/whatsapp/disconnect — stop the client, keep saved credentials. */
router.post('/disconnect', async (req, res) => {
  try {
    await destroyClient(sessionOf(req));
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/whatsapp/logout — unlink the device and clear credentials. */
router.post('/logout', async (req, res) => {
  try {
    await logoutClient(sessionOf(req));
    res.json({ success: true, message: 'Logged out — a new QR scan is required to reconnect' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** GET /api/whatsapp/chats?type=group|private — live chat list from the device. */
router.get('/chats', async (req, res) => {
  try {
    const data = await fetchChats(sessionOf(req), { type: req.query.type });
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/** GET /api/whatsapp/groups — convenience alias for chats?type=group. */
router.get('/groups', async (req, res) => {
  try {
    const data = await fetchChats(sessionOf(req), { type: 'group' });
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/whatsapp/contacts?search=&type=group|private
 * Saved contacts on the linked device, plus the groups it belongs to.
 * This is the reliable way to list send targets — see the note on /chats.
 */
router.get('/contacts', async (req, res) => {
  try {
    let data = await fetchContacts(sessionOf(req), { search: req.query.search });
    if (req.query.type) data = data.filter((c) => c.type === req.query.type);
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

export default router;
