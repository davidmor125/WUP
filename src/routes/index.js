import { Router } from 'express';
import { authMiddleware } from '../server/authMiddleware.js';
import whatsappRoutes from './whatsapp.routes.js';
import messagesRoutes from './messages.routes.js';
import webhooksRoutes from './webhooks.routes.js';
import eventsRoutes from './events.routes.js';
import debugRoutes from './debug.routes.js';
import authRoutes from './auth.routes.js';
import { isAuthEnabled, getAuthStatus } from '../services/auth.service.js';
import { getClientState, listSessions } from '../whatsapp/client.js';
import config from '../config/env.js';

const router = Router();

// Public — no key required, so uptime checks work without credentials.
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    whatsapp: getClientState(config.whatsapp.defaultSessionId).status,
    sessions: listSessions().length,
  });
});

// Public: the UI must be able to ask whether a key is required *before* it has
// one, otherwise a fresh browser can't tell "wrong key" from "no key needed".
// It reveals only whether auth is on plus a masked hint, never the key.
router.get('/auth/status', (req, res) => {
  res.json({ success: true, data: getAuthStatus() });
});

// Bootstrap: while no key exists, allow generating the first one without a key.
// Once a key is set this falls through to the guard below, so an attacker can
// never rotate a key they don't already hold.
router.post('/auth/rotate', (req, res, next) => {
  if (isAuthEnabled()) return authMiddleware(req, res, next);
  return next();
});

// Everything below is guarded by the shared API key.
router.use(authMiddleware);
router.use('/auth', authRoutes);

router.use('/whatsapp', whatsappRoutes);
router.use('/messages', messagesRoutes);
router.use('/webhooks', webhooksRoutes);
router.use('/events', eventsRoutes);
router.use('/debug', debugRoutes);

export default router;
