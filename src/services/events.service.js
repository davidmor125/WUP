/**
 * In-process event bus + SSE fan-out.
 *
 * Two consumers subscribe to the same stream:
 *   - the webhook dispatcher, which forwards events to configured URLs
 *   - the frontend, over GET /api/events (Server-Sent Events), so the chat
 *     window updates live without polling
 */
import { EventEmitter } from 'node:events';
import logger from '../utils/logger.js';

const bus = new EventEmitter();
bus.setMaxListeners(50);

const sseClients = new Set(); // Set<express Response>

export const EVENTS = {
  MESSAGE_INBOUND: 'message.inbound',
  MESSAGE_OUTBOUND: 'message.outbound',
  MESSAGE_ACK: 'message.ack',
  CONNECTION_STATUS: 'connection.status',
};

export function onEvent(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/** Publish an event to webhooks and every open SSE connection. */
export function emitEvent(event, data) {
  const envelope = { event, timestamp: new Date().toISOString(), data };
  bus.emit('event', envelope);
  broadcastSse(envelope);
  return envelope;
}

export function emitMessage(message) {
  const event = message.direction === 'inbound' ? EVENTS.MESSAGE_INBOUND : EVENTS.MESSAGE_OUTBOUND;
  return emitEvent(event, message);
}

export function emitConnectionStatus(sessionId, state) {
  return emitEvent(EVENTS.CONNECTION_STATUS, { sessionId, ...state });
}

export function emitAck(sessionId, waMessageId, ack) {
  return emitEvent(EVENTS.MESSAGE_ACK, { sessionId, waMessageId, ack });
}

// ── SSE ──────────────────────────────────────────────────────────────────────

export function addSseClient(res) {
  sseClients.add(res);
  logger.debug(`SSE client connected (${sseClients.size} open)`);
  res.on('close', () => {
    sseClients.delete(res);
    logger.debug(`SSE client disconnected (${sseClients.size} open)`);
  });
}

function broadcastSse(envelope) {
  if (sseClients.size === 0) return;
  const frame = `event: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** Keep proxies from closing idle SSE connections. */
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 30_000).unref();
