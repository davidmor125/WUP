import { isAuthEnabled, keyMatches } from '../services/auth.service.js';

/**
 * Shared-secret guard for the API.
 *
 * The key may arrive as `Authorization: Bearer <key>`, an `X-API-Key` header,
 * or a `?apiKey=` query parameter — the query form exists because EventSource
 * cannot set headers, so the SSE stream has no other way to authenticate.
 *
 * With no key configured the guard is disabled, which keeps local development
 * frictionless; startup logs a warning so this is never a silent surprise.
 */
export function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();

  const header = req.headers.authorization;
  const provided =
    (header?.startsWith('Bearer ') ? header.slice(7) : null) ||
    req.headers['x-api-key'] ||
    req.query.apiKey;

  if (!provided) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (!keyMatches(provided)) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  next();
}
