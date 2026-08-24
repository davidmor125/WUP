import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * API key storage.
 *
 * The key lives in SQLite rather than only in `.env` so it can be generated and
 * rotated from the UI without editing a file and restarting the server.
 *
 * `API_KEY` in the environment still wins when set: deployments that inject
 * secrets (Railway, Docker, CI) must stay authoritative, and a UI rotation
 * cannot silently diverge from what the platform believes the key is.
 */

const SETTING_KEY = 'api_key';

function readStored() {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
    return row?.value || null;
  } catch (error) {
    logger.error(`readStored(api_key): ${error.message}`);
    return null;
  }
}

/** True when the key comes from the environment and therefore can't be rotated here. */
export function isEnvManaged() {
  return !!config.apiKey;
}

/** The key currently in force, or null when auth is disabled. */
export function getApiKey() {
  return config.apiKey || readStored();
}

/** Auth is on whenever a key exists in either source. */
export function isAuthEnabled() {
  return !!getApiKey();
}

export function generateApiKey() {
  // 32 bytes of hex — long enough that guessing is hopeless, and safe to paste
  // into a header, a URL, or a shell command without escaping.
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create or replace the stored key. Returns the new key so the caller can show
 * it once — it is not secret from the operator, but it should be copied now
 * rather than hunted for later.
 */
export function rotateApiKey() {
  if (isEnvManaged()) {
    const err = new Error('API_KEY is set in the environment; rotate it there instead.');
    err.statusCode = 409;
    throw err;
  }
  const key = generateApiKey();
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (@k, @v, datetime('now'))
    ON CONFLICT (key) DO UPDATE SET value = @v, updated_at = datetime('now')
  `).run({ k: SETTING_KEY, v: key });
  logger.info('API key rotated.');
  return key;
}

/** Turn authentication off by removing the stored key. */
export function clearApiKey() {
  if (isEnvManaged()) {
    const err = new Error('API_KEY is set in the environment; remove it there instead.');
    err.statusCode = 409;
    throw err;
  }
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
  logger.warn('API key cleared — the API is now unauthenticated.');
}

/** A short, non-usable fingerprint so the operator can tell which key is live. */
export function maskKey(key) {
  if (!key) return null;
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Public summary of the auth state — safe to expose without a key. */
export function getAuthStatus() {
  return {
    enabled: isAuthEnabled(),
    envManaged: isEnvManaged(),
    hint: maskKey(getApiKey()),
  };
}

/** Constant-time comparison, so a wrong key can't be discovered byte by byte. */
export function keyMatches(provided) {
  const expected = getApiKey();
  if (!expected) return true; // auth disabled
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
