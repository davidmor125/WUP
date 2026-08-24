import pkg from 'whatsapp-web.js';
const { LocalAuth } = pkg;
import config from './env.js';

/**
 * Build whatsapp-web.js Client options for a specific session.
 * LocalAuth's `clientId` namespaces the auth folder so each session gets its
 * own Chromium profile and saved credentials under `{sessionDataPath}/session-{sessionId}/`.
 */
export function getClientOptions(sessionId) {
  if (!sessionId) throw new Error('getClientOptions: sessionId is required');
  return {
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: config.whatsapp.sessionDataPath,
    }),
    puppeteer: {
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
    qrMaxRetries: config.whatsapp.qrMaxRetries,
    authTimeoutMs: config.whatsapp.authTimeoutMs,
  };
}
