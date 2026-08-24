import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { EVENTS } from './events.service.js';

export const AVAILABLE_EVENTS = Object.values(EVENTS);

function toApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    events: JSON.parse(row.events || '[]'),
    chatFilter: row.chat_filter,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

export function listWebhooks() {
  return getDb().prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map(toApp);
}

export function getWebhook(id) {
  return toApp(getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id));
}

/** Only enabled webhooks subscribed to this event, honouring the chat filter. */
export function getSubscribers(event, chatType) {
  return listWebhooks().filter((w) => {
    if (!w.enabled) return false;
    if (w.events.length && !w.events.includes(event)) return false;
    if (chatType && w.chatFilter !== 'all' && w.chatFilter !== chatType) return false;
    return true;
  });
}

export function createWebhook({ name, url, secret, events, chatFilter = 'all', enabled = true }) {
  if (!url) {
    const err = new Error('url is required');
    err.statusCode = 400;
    throw err;
  }
  const unknown = (events || []).filter((e) => !AVAILABLE_EVENTS.includes(e));
  if (unknown.length) {
    const err = new Error(`Unknown event(s): ${unknown.join(', ')}. Valid: ${AVAILABLE_EVENTS.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const info = getDb().prepare(`
    INSERT INTO webhooks (name, url, secret, events, chat_filter, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name || null,
    url,
    secret || crypto.randomBytes(24).toString('hex'),
    JSON.stringify(events?.length ? events : AVAILABLE_EVENTS),
    chatFilter,
    enabled ? 1 : 0,
  );

  return getWebhook(info.lastInsertRowid);
}

export function updateWebhook(id, patch) {
  const existing = getWebhook(id);
  if (!existing) {
    const err = new Error('Webhook not found');
    err.statusCode = 404;
    throw err;
  }

  const merged = {
    name: patch.name ?? existing.name,
    url: patch.url ?? existing.url,
    secret: patch.secret ?? existing.secret,
    events: patch.events ?? existing.events,
    chatFilter: patch.chatFilter ?? existing.chatFilter,
    enabled: patch.enabled ?? existing.enabled,
  };

  getDb().prepare(`
    UPDATE webhooks
    SET name = ?, url = ?, secret = ?, events = ?, chat_filter = ?, enabled = ?
    WHERE id = ?
  `).run(
    merged.name, merged.url, merged.secret,
    JSON.stringify(merged.events), merged.chatFilter, merged.enabled ? 1 : 0, id,
  );

  return getWebhook(id);
}

export function deleteWebhook(id) {
  return getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
}

// ── Delivery log ─────────────────────────────────────────────────────────────

export function recordDelivery({ webhookId, event, payload }) {
  const info = getDb().prepare(`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, status)
    VALUES (?, ?, ?, 'pending')
  `).run(webhookId, event, JSON.stringify(payload));
  return info.lastInsertRowid;
}

export function completeDelivery(deliveryId, { status, attempts, statusCode, error }) {
  getDb().prepare(`
    UPDATE webhook_deliveries
    SET status = ?, attempts = ?, status_code = ?, error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(status, attempts, statusCode ?? null, error ? String(error).slice(0, 500) : null, deliveryId);
}

export function listDeliveries({ webhookId, status, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (webhookId) { where.push('webhook_id = @webhookId'); params.webhookId = webhookId; }
  if (status) { where.push('status = @status'); params.status = status; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return getDb().prepare(
    `SELECT * FROM webhook_deliveries ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map((row) => ({
    id: row.id,
    webhookId: row.webhook_id,
    event: row.event,
    payload: JSON.parse(row.payload),
    status: row.status,
    attempts: row.attempts,
    statusCode: row.status_code,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}
