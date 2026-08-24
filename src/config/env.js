import 'dotenv/config';

const runtime = (process.env.RUNTIME || 'local').toLowerCase();
const isLocal = runtime === 'local';

const config = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || (isLocal ? 'development' : 'production'),
  runtime,
  isLocal,
  isServer: !isLocal,

  // Single shared API key guarding every /api route except /health and the
  // inbound webhook. Keeps the service usable without a full user system.
  apiKey: process.env.API_KEY || '',

  whatsapp: {
    enabled: process.env.WA_ENABLED !== 'false',
    sessionDataPath: process.env.WA_SESSION_DATA_PATH || '.wwebjs_auth',
    qrMaxRetries: parseInt(process.env.WA_QR_MAX_RETRIES, 10) || 20,
    authTimeoutMs: parseInt(process.env.WA_AUTH_TIMEOUT_MS, 10) || 60000,
    // Sessions to auto-restore on boot are discovered from the session folder,
    // exactly like wupbot does. This is the id used when none is supplied.
    defaultSessionId: process.env.WA_DEFAULT_SESSION_ID || 'default',
  },

  db: {
    file: process.env.DB_FILE || 'data/wup.db',
  },

  webhooks: {
    // Retry backoff for outbound delivery attempts.
    retryDelaysMs: [1_000, 5_000, 25_000],
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 10_000,
  },
});

export default config;
