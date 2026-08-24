import { Router } from 'express';
import { addSseClient } from '../services/events.service.js';

const router = Router();

/**
 * GET /api/events — Server-Sent Events stream.
 * The frontend subscribes here so incoming/outgoing messages and connection
 * changes appear instantly instead of being polled for.
 */
router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops nginx from buffering the stream
  });
  res.write(': connected\n\n');
  res.flushHeaders?.();

  addSseClient(res);
});

export default router;
