import pkg from 'whatsapp-web.js';
const { Client } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import { getClientOptions } from '../config/index.js';
import { setQR, clearQR } from './qrManager.js';
import { handleIncomingMessage, handleMessageAck } from './listener.js';
import { emitConnectionStatus } from '../services/events.service.js';
import logger from '../utils/logger.js';

// Per-session WhatsApp clients. Each linked device maintains its own Client
// instance, Chromium browser and LocalAuth session, so connecting one phone
// never bleeds into another session's data.
const clientsBySessionId = new Map();          // sessionId -> Client
const stateBySessionId = new Map();            // sessionId -> { status, lastError, phoneNumber, pushname }
const reconnectBySessionId = new Map();        // sessionId -> { attempt, timer }
const manualDisconnectBySessionId = new Map(); // sessionId -> bool
const watchdogBySessionId = new Map();         // sessionId -> NodeJS.Timer

const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

function setState(sessionId, patch) {
  const prev = stateBySessionId.get(sessionId) || { status: 'disconnected', lastError: null };
  const next = { ...prev, ...patch };
  stateBySessionId.set(sessionId, next);
  if (patch.status && patch.status !== prev.status) {
    emitConnectionStatus(sessionId, next);
  }
}

function scheduleReconnect(sessionId, reasonHint = '') {
  if (manualDisconnectBySessionId.get(sessionId)) {
    logger.info(`WhatsApp[${sessionId}]: reconnect skipped (manual disconnect).`);
    return;
  }
  const rc = reconnectBySessionId.get(sessionId) || { attempt: 0, timer: null };
  if (rc.timer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(rc.attempt, RECONNECT_DELAYS_MS.length - 1)];
  rc.attempt++;
  logger.warn(`WhatsApp[${sessionId}]: reconnect in ${delay / 1000}s (attempt ${rc.attempt}${reasonHint ? `, ${reasonHint}` : ''}).`);
  rc.timer = setTimeout(async () => {
    rc.timer = null;
    try {
      manualDisconnectBySessionId.set(sessionId, false);
      await destroyClient(sessionId, { keepReconnecting: true });
      await initializeClient(sessionId);
    } catch (err) {
      logger.error(`WhatsApp[${sessionId}]: reconnect failed: ${err.message}`);
      scheduleReconnect(sessionId, 'init_failed');
    }
  }, delay);
  reconnectBySessionId.set(sessionId, rc);
}

function cancelReconnect(sessionId) {
  const rc = reconnectBySessionId.get(sessionId);
  if (rc?.timer) clearTimeout(rc.timer);
  reconnectBySessionId.set(sessionId, { attempt: 0, timer: null });
}

function startWatchdog(sessionId) {
  if (watchdogBySessionId.get(sessionId)) return;
  const timer = setInterval(() => {
    if (manualDisconnectBySessionId.get(sessionId)) return;
    const s = (stateBySessionId.get(sessionId)?.status) || 'disconnected';
    if (s === 'ready' || s === 'authenticated' || s === 'initializing' || s === 'qr_pending') return;
    logger.warn(`WhatsApp[${sessionId}] watchdog: status="${s}" — forcing reconnect.`);
    scheduleReconnect(sessionId, 'watchdog');
  }, 5 * 60 * 1000);
  watchdogBySessionId.set(sessionId, timer);
}

function stopWatchdog(sessionId) {
  const t = watchdogBySessionId.get(sessionId);
  if (t) {
    clearInterval(t);
    watchdogBySessionId.delete(sessionId);
  }
}

export function getClientState(sessionId) {
  const s = stateBySessionId.get(sessionId) || { status: 'disconnected', lastError: null };
  const rc = reconnectBySessionId.get(sessionId) || { attempt: 0 };

  // The status and the client object live in separate Maps and can drift: if the
  // Chromium process dies, clientsBySessionId loses the client while
  // stateBySessionId stays on 'ready'. Callers that only read status would report
  // "connected" while every send/getChats call fails. Treat a missing client as
  // disconnected.
  const client = clientsBySessionId.get(sessionId);
  if ((s.status === 'ready' || s.status === 'authenticated') && !client) {
    return {
      ...s,
      status: 'disconnected',
      lastError: s.lastError || 'Client instance is gone (browser process likely died)',
      reconnectAttempt: rc.attempt,
    };
  }

  return { ...s, sessionId, reconnectAttempt: rc.attempt };
}

export function getClient(sessionId) {
  return clientsBySessionId.get(sessionId) || null;
}

export function getAllSessionIds() {
  return [...clientsBySessionId.keys()];
}

/** Every session we know about — running clients plus remembered states. */
export function listSessions() {
  const ids = new Set([...clientsBySessionId.keys(), ...stateBySessionId.keys()]);
  return [...ids].map((id) => getClientState(id));
}

/** Attach the full event set to a freshly built client. */
function bindEvents(sessionId, client, { onPairingCode } = {}) {
  client.on('qr', (qr) => {
    setState(sessionId, { status: 'qr_pending' });
    logger.info(`WhatsApp[${sessionId}]: QR code received.`);
    qrcodeTerminal.generate(qr, { small: true });
    setQR(sessionId, qr);
  });

  if (onPairingCode) {
    client.on('code', (code) => {
      setState(sessionId, { status: 'qr_pending' });
      logger.info(`WhatsApp[${sessionId}]: pairing code received: ${code}`);
      onPairingCode(code);
    });
  }

  client.on('authenticated', () => {
    setState(sessionId, { status: 'authenticated' });
    clearQR(sessionId);
    logger.info(`WhatsApp[${sessionId}]: authenticated.`);
  });

  client.on('ready', () => {
    setState(sessionId, {
      status: 'ready',
      phoneNumber: client.info?.wid?.user || null,
      pushname: client.info?.pushname || null,
    });
    clearQR(sessionId);
    cancelReconnect(sessionId);
    startWatchdog(sessionId);
    logger.info(`WhatsApp[${sessionId}]: ready.`);
  });

  client.on('auth_failure', (message) => {
    setState(sessionId, { status: 'disconnected', lastError: message });
    clearQR(sessionId);
    logger.error(`WhatsApp[${sessionId}]: auth failed: ${message}`);
    scheduleReconnect(sessionId, 'auth_failure');
  });

  client.on('disconnected', (reason) => {
    setState(sessionId, { status: 'disconnected', lastError: String(reason || '') });
    clearQR(sessionId);
    logger.warn(`WhatsApp[${sessionId}]: disconnected. Reason: ${reason}`);
    if (!manualDisconnectBySessionId.get(sessionId)) {
      scheduleReconnect(sessionId, String(reason || 'disconnected'));
    }
  });

  client.on('loading_screen', (percent, message) => {
    logger.debug(`WhatsApp[${sessionId}] loading: ${percent}% - ${message}`);
  });

  // `message_create` (not `message`) so we see OUTGOING messages too — including
  // ones typed on the phone. That is what makes the outbound webhook possible.
  client.on('message_create', (msg) => handleIncomingMessage(sessionId, msg));
  client.on('message_ack', (msg, ack) => handleMessageAck(sessionId, msg, ack));
}

export async function initializeClient(sessionId) {
  if (!sessionId) throw new Error('initializeClient: sessionId is required');

  if (clientsBySessionId.has(sessionId)) {
    logger.warn(`WhatsApp[${sessionId}]: client already exists. Destroying before re-init.`);
    await destroyClient(sessionId, { keepReconnecting: true });
  }

  manualDisconnectBySessionId.set(sessionId, false);
  setState(sessionId, { status: 'initializing', lastError: null });
  const client = new Client(getClientOptions(sessionId));

  bindEvents(sessionId, client);
  clientsBySessionId.set(sessionId, client);

  try {
    await client.initialize();
  } catch (error) {
    setState(sessionId, { status: 'disconnected', lastError: error.message });
    logger.error(`WhatsApp[${sessionId}]: initialize failed: ${error.message}`);
    scheduleReconnect(sessionId, 'initialize_threw');
    throw error;
  }
}

/**
 * Re-initialize a session's client in phone-pairing mode.
 * Resolves with the pairing code as soon as it's ready.
 */
export function initializeClientWithPhone(sessionId, phoneNumber) {
  if (!sessionId) return Promise.reject(new Error('initializeClientWithPhone: sessionId is required'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const done = finish(resolve);
    const fail = finish(reject);

    (async () => {
      try {
        if (clientsBySessionId.has(sessionId)) {
          await destroyClient(sessionId, { keepReconnecting: true });
        }

        manualDisconnectBySessionId.set(sessionId, false);
        setState(sessionId, { status: 'initializing', lastError: null });

        const options = getClientOptions(sessionId);
        options.pairWithPhoneNumber = { phoneNumber, showNotification: true };
        delete options.qrMaxRetries;

        const client = new Client(options);
        bindEvents(sessionId, client, { onPairingCode: done });
        clientsBySessionId.set(sessionId, client);

        client.initialize().catch((error) => {
          setState(sessionId, { status: 'disconnected', lastError: error.message });
          logger.error(`WhatsApp[${sessionId}]: initialize failed (phone pairing): ${error.message}`);
          fail(error);
        });

        setTimeout(() => fail(new Error('Pairing code request timed out')), 30_000);
      } catch (error) {
        fail(error);
      }
    })();
  });
}

export async function destroyClient(sessionId, { keepReconnecting = false } = {}) {
  if (!sessionId) return;
  if (!keepReconnecting) {
    manualDisconnectBySessionId.set(sessionId, true);
    cancelReconnect(sessionId);
    stopWatchdog(sessionId);
  }

  const oldClient = clientsBySessionId.get(sessionId);
  if (!oldClient) return;

  clientsBySessionId.delete(sessionId);
  setState(sessionId, { status: 'disconnected', lastError: null });
  clearQR(sessionId);

  let browserPid = null;
  try {
    const proc = oldClient.pupBrowser?.process();
    if (proc) browserPid = proc.pid;
  } catch { /* ignore */ }

  try {
    await oldClient.destroy();
    logger.info(`WhatsApp[${sessionId}]: client destroyed.`);
  } catch (error) {
    logger.error(`WhatsApp[${sessionId}]: error destroying client: ${error.message}`);
  }

  try {
    const browser = oldClient.pupBrowser;
    if (browser && browser.isConnected()) await browser.close();
  } catch { /* already dead */ }

  if (browserPid) {
    try {
      process.kill(browserPid, 'SIGKILL');
    } catch { /* already dead */ }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

/**
 * Full logout — clears the stored LocalAuth credentials so the next connect
 * asks for a fresh QR scan instead of silently restoring the old device.
 */
export async function logoutClient(sessionId) {
  const client = clientsBySessionId.get(sessionId);
  if (client) {
    try {
      await client.logout();
    } catch (error) {
      logger.warn(`WhatsApp[${sessionId}]: logout failed: ${error.message} — destroying anyway.`);
    }
  }
  await destroyClient(sessionId);
  stateBySessionId.delete(sessionId);
}
