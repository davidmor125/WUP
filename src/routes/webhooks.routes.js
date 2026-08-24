import { Router } from 'express';
import {
  listWebhooks, getWebhook, createWebhook, updateWebhook, deleteWebhook,
  listDeliveries, AVAILABLE_EVENTS,
} from '../services/webhooks.service.js';
import { testWebhook, retryDelivery } from '../webhooks/dispatcher.js';
import logger from '../utils/logger.js';

const router = Router();

/** GET /api/webhooks/events — the event names a webhook can subscribe to. */
router.get('/events', (req, res) => {
  res.json({ success: true, data: AVAILABLE_EVENTS });
});

/** GET /api/webhooks/deliveries — the delivery log across all webhooks. */
router.get('/deliveries', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const webhookId = req.query.webhookId ? Number(req.query.webhookId) : undefined;
    const data = listDeliveries({ webhookId, status: req.query.status, limit, offset });
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** POST /api/webhooks/deliveries/:id/retry — re-send a failed delivery. */
router.post('/deliveries/:id/retry', async (req, res) => {
  try {
    const result = await retryDelivery(req.params.id);
    res.json({ success: result.ok, data: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get('/', (req, res) => {
  res.json({ success: true, data: listWebhooks() });
});

router.post('/', (req, res) => {
  try {
    const webhook = createWebhook(req.body || {});
    logger.info(`Webhook created: ${webhook.url}`);
    res.status(201).json({ success: true, data: webhook });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get('/:id', (req, res) => {
  const webhook = getWebhook(Number(req.params.id));
  if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });
  res.json({ success: true, data: webhook });
});

router.patch('/:id', (req, res) => {
  try {
    res.json({ success: true, data: updateWebhook(Number(req.params.id), req.body || {}) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', (req, res) => {
  const removed = deleteWebhook(Number(req.params.id));
  if (!removed) return res.status(404).json({ success: false, message: 'Webhook not found' });
  res.json({ success: true });
});

/** POST /api/webhooks/:id/test — send a synthetic event to verify the endpoint. */
router.post('/:id/test', async (req, res) => {
  try {
    const result = await testWebhook(Number(req.params.id));
    res.json({ success: result.ok, data: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

export default router;
