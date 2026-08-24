/**
 * WUP webhook receiver — a complete, runnable example.
 *
 *   node examples/webhook-receiver.mjs
 *
 * It does three things:
 *   1. verifies the HMAC signature, so it only trusts genuine WUP deliveries
 *   2. logs every inbound and outbound message, groups included
 *   3. auto-replies to anyone who writes "ping" (private chats only)
 *
 * Configure with environment variables, or edit the constants below:
 *   WEBHOOK_SECRET  the webhook's signing secret (Webhooks screen → Signing secret)
 *   WUP_API_KEY     your API key, needed only for the auto-reply
 *   PORT            defaults to 4000
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.WEBHOOK_SECRET || '';
const API_KEY = process.env.WUP_API_KEY || '';
const WUP_URL = process.env.WUP_URL || 'http://localhost:3000';

// Reject a delivery whose timestamp is too old. The signature covers the
// timestamp, so without this check a captured request stays replayable forever.
const MAX_SKEW_SECONDS = 300;

/**
 * The signature is an HMAC-SHA256 over `{timestamp}.{rawBody}`.
 * Compare with timingSafeEqual so a wrong signature can't be discovered one
 * byte at a time by measuring how long the comparison takes.
 */
function verify(rawBody, signatureHeader, timestampHeader) {
  if (!SECRET) return { ok: true, reason: 'no secret configured — verification skipped' };
  if (!signatureHeader || !timestampHeader) return { ok: false, reason: 'missing signature headers' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestampHeader));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) {
    return { ok: false, reason: `stale timestamp (${age}s old)` };
  }

  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');
  const got = String(signatureHeader).replace(/^sha256=/, '');

  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

/** Send a message back through the WUP API. */
async function sendMessage(to, body) {
  const res = await fetch(`${WUP_URL}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY && { 'X-API-Key': API_KEY }),
    },
    body: JSON.stringify({ to, body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Decide what to do with one delivered event. */
async function handleEvent({ event, data }) {
  if (event === 'connection.status') {
    console.log(`  ⚡ session ${data.sessionId} → ${data.status}`);
    return;
  }

  if (event === 'message.inbound' || event === 'message.outbound') {
    const arrow = event === 'message.inbound' ? '←' : '→';
    const who = data.chatType === 'group'
      ? `[${data.chatName}] ${data.authorName || data.authorId}`
      : (data.chatName || data.chatId);
    const text = data.body || `<${data.type}>`;
    console.log(`  ${arrow} ${who}: ${text}`);
  }

  // Auto-reply. Guard on direction, or the reply would trigger this handler
  // again through the outbound event and answer itself in a loop.
  if (event !== 'message.inbound') return;
  if (data.chatType !== 'private') return;            // stay quiet in groups
  if ((data.body || '').trim().toLowerCase() !== 'ping') return;

  try {
    await sendMessage(data.chatId, 'pong 🏓');
    console.log('  ✅ replied "pong"');
  } catch (err) {
    console.log(`  ❌ reply failed: ${err.message}`);
  }
}

http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  // Collect the RAW body: the signature is over the exact bytes sent, so
  // re-serializing a parsed object would produce a different digest.
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    const check = verify(
      raw,
      req.headers['x-webhook-signature'],
      req.headers['x-webhook-timestamp'],
    );

    if (!check.ok) {
      console.log(`\n🚫 rejected: ${check.reason}`);
      // 401 is a client error, so WUP will not retry — correct here, since a
      // bad signature will fail identically every time.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: check.reason }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('Invalid JSON');
      return;
    }

    console.log(`\n📨 ${payload.event}  ${payload.timestamp}`);

    // Answer immediately, then work in the background: WUP treats a slow
    // response as a failure and retries, which would double-process the event.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));

    handleEvent(payload).catch((err) => console.error('  handler error:', err.message));
  });
}).listen(PORT, () => {
  console.log(`WUP webhook receiver listening on http://localhost:${PORT}`);
  console.log(SECRET ? '✅ signature verification ON' : '⚠️  no WEBHOOK_SECRET — signatures NOT verified');
  console.log(API_KEY ? '✅ API key set — auto-reply enabled' : '⚠️  no WUP_API_KEY — auto-reply will fail');
  console.log('\nWaiting for events… (send yourself "ping" on WhatsApp to test)\n');
});
