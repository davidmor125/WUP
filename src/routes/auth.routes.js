import { Router } from 'express';
import {
  getApiKey, getAuthStatus, rotateApiKey, clearApiKey,
} from '../services/auth.service.js';

const router = Router();

/**
 * GET /api/auth/status
 * Whether auth is on, and whether the key can be rotated from here.
 * Never returns the key itself — reading it is a separate, explicit action.
 * (Also mounted publicly in routes/index.js so a keyless UI can bootstrap.)
 */
router.get('/status', (req, res) => {
  res.json({ success: true, data: getAuthStatus() });
});

/**
 * GET /api/auth/key
 * Reveal the current key. Reaching this route already required the key (or
 * auth being off), so this only ever shows the caller something they hold.
 */
router.get('/key', (req, res) => {
  const key = getApiKey();
  if (!key) return res.json({ success: true, data: { key: null } });
  res.json({ success: true, data: { key } });
});

/**
 * POST /api/auth/rotate
 * Generate a new key and store it. The response carries the new key so the UI
 * can save it immediately — every existing client is locked out from this
 * moment, which is the point of a rotation.
 */
router.post('/rotate', (req, res) => {
  try {
    res.json({ success: true, data: { key: rotateApiKey() } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

/** POST /api/auth/disable — remove the key and stop requiring authentication. */
router.post('/disable', (req, res) => {
  try {
    clearApiKey();
    res.json({ success: true, message: 'Authentication disabled.' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

export default router;
