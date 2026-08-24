import crypto from 'node:crypto';
import config from '../config/env.js';
import { onEvent } from '../services/events.service.js';
import {
  getSubscribers, getWebhook, recordDelivery, completeDelivery, listDeliveries,
} from '../services/webhooks.service.js';
import logger from '../utils/logger.js';

/**
 * Sign the body so the receiver can verify it really came from us.
 * The signed string is `{timestamp}.{body}` — including the timestamp stops an
 * attacker from replaying an old capture with a still-valid signature.
 */
function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function postOnce(webhook, envelope, timeoutMs) {
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'WUP-Webhook/1.0',
    'X-Webhook-Event': envelope.event,
    'X-Webhook-Timestamp': String(timestamp),
  };
  if (webhook.secret) {
    headers['X-Webhook-Signature'] = `sha256=${sign(webhook.secret, timestamp, body)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST', headers, body, signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, statusCode: res.status, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    return { ok: true, statusCode: res.status };
  } catch (err) {
    const message = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    return { ok: false, statusCode: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver with retries. Unlike the source project's fire-once approach, a
 * transient failure gets retried on an exponential backoff, and every attempt
 * is recorded so failures are visible in the UI rather than lost to the log.
 */
async function deliver(webhook, envelope, { deliveryId } = {}) {
  const id = deliveryId ?? recordDelivery({ webhookId: webhook.id, event: envelope.event, payload: envelope });
  const delays = config.webhooks.retryDelaysMs;
  const maxAttempts = delays.length + 1;

  let attempt = 0;
  let last = null;

  while (attempt < maxAttempts) {
    attempt++;
    last = await postOnce(webhook, envelope, config.webhooks.timeoutMs);

    if (last.ok) {
      completeDelivery(id, { status: 'sent', attempts: attempt, statusCode: last.statusCode });
      logger.info(`Webhook[${webhook.id}] ${envelope.event} → ${webhook.url} ${last.statusCode} (attempt ${attempt})`);
      return { ok: true, attempts: attempt, statusCode: last.statusCode };
    }

    // 4xx means the receiver rejected the payload itself — retrying sends the
    // identical body and will fail identically. Only retry 5xx / network errors.
    const isClientError = last.statusCode >= 400 && last.statusCode < 500;
    if (isClientError || attempt >= maxAttempts) break;

    const delay = delays[attempt - 1];
    logger.warn(`Webhook[${webhook.id}] attempt ${attempt} failed (${last.error}) — retrying in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }

  completeDelivery(id, {
    status: 'failed', attempts: attempt, statusCode: last?.statusCode, error: last?.error,
  });
  logger.error(`Webhook[${webhook.id}] ${envelope.event} → ${webhook.url} failed after ${attempt} attempt(s): ${last?.error}`);
  return { ok: false, attempts: attempt, statusCode: last?.statusCode, error: last?.error };
}

/** Subscribe the dispatcher to the internal event bus. */
export function startDispatcher() {
  onEvent((envelope) => {
    const chatType = envelope.data?.chatType || null;
    const subscribers = getSubscribers(envelope.event, chatType);
    if (subscribers.length === 0) return;

    // Fire-and-forget: a slow receiver must never stall the WhatsApp listener.
    for (const webhook of subscribers) {
      deliver(webhook, envelope).catch((err) =>
        logger.error(`Webhook[${webhook.id}] dispatch threw: ${err.message}`));
    }
  });
  logger.info('Webhook dispatcher started.');
}

/** Send a synthetic event so the user can verify their endpoint from the UI. */
export async function testWebhook(webhookId) {
  const webhook = getWebhook(webhookId);
  if (!webhook) {
    const err = new Error('Webhook not found');
    err.statusCode = 404;
    throw err;
  }
  const envelope = {
    event: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: { message: 'This is a test delivery from WUP.', webhookId },
  };
  return deliver(webhook, envelope);
}

/** Re-send a delivery that previously failed. */
export async function retryDelivery(deliveryId) {
  const [delivery] = listDeliveries({ limit: 1, offset: 0 }).filter((d) => d.id === Number(deliveryId));
  const record = delivery || listDeliveries({ limit: 500 }).find((d) => d.id === Number(deliveryId));
  if (!record) {
    const err = new Error('Delivery not found');
    err.statusCode = 404;
    throw err;
  }
  const webhook = getWebhook(record.webhookId);
  if (!webhook) {
    const err = new Error('Webhook for this delivery no longer exists');
    err.statusCode = 404;
    throw err;
  }
  return deliver(webhook, record.payload);
}
