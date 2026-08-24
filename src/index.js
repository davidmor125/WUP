import fs from 'node:fs';
import config from './config/env.js';
import { createApp } from './server/app.js';
import { initDb } from './db/index.js';
import { initializeClient, destroyClient, getAllSessionIds } from './whatsapp/client.js';
import { startDispatcher } from './webhooks/dispatcher.js';
import logger from './utils/logger.js';

async function main() {
  // 1. Storage first — the listener writes to it the moment WhatsApp connects.
  initDb();

  // 2. Webhook dispatcher subscribes to the event bus.
  startDispatcher();

  // 3. HTTP server.
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`WUP server running on 0.0.0.0:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv} | Runtime: ${config.runtime}`);
    if (!config.apiKey) {
      logger.warn('API_KEY is not set — the API is UNAUTHENTICATED. Set API_KEY before exposing this service.');
    }
  });

  // 4. Restore previously linked devices.
  if (config.whatsapp.enabled) {
    restoreExistingSessions().catch((err) =>
      logger.error(`WhatsApp session restore failed: ${err.message}`));
  } else {
    logger.info('WhatsApp client disabled (WA_ENABLED=false). API-only mode.');
  }

  // 5. Graceful shutdown.
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Starting graceful shutdown...`);
    await Promise.all(getAllSessionIds().map((id) => destroyClient(id).catch(() => {})));
    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled Rejection:', reason));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    shutdown('uncaughtException');
  });
}

/**
 * whatsapp-web.js stores each LocalAuth session under
 * `{sessionDataPath}/session-{sessionId}/`, so the folder names tell us which
 * devices were previously linked. Re-initialize one client per folder,
 * staggered so a batch of Chromium processes doesn't start all at once.
 */
async function restoreExistingSessions() {
  const dataPath = config.whatsapp.sessionDataPath;

  let entries = [];
  try {
    entries = fs.readdirSync(dataPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info(`No session dir at ${dataPath}. Link a device via POST /api/whatsapp/connect.`);
      return;
    }
    throw err;
  }

  const sessionIds = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
    .map((e) => e.name.slice('session-'.length))
    .filter(Boolean);

  if (sessionIds.length === 0) {
    logger.info('No saved WhatsApp sessions found. Clients will start on demand.');
    return;
  }

  logger.info(`Restoring ${sessionIds.length} WhatsApp session(s)…`);
  for (const sessionId of sessionIds) {
    initializeClient(sessionId)
      .then(() => logger.info(`WhatsApp[${sessionId}]: restored.`))
      .catch((err) => logger.error(`WhatsApp[${sessionId}] restore failed: ${err.message}`));
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main();
