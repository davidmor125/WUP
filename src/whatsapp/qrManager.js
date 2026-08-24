import QRCode from 'qrcode';

// Per-session QR storage. Each connecting session gets its own QR while waiting
// for the scan; once it authenticates the entry is cleared.
const qrBySessionId = new Map();

export function setQR(sessionId, qrString) {
  if (!sessionId) return;
  qrBySessionId.set(sessionId, qrString);
}

export function clearQR(sessionId) {
  if (!sessionId) return;
  qrBySessionId.delete(sessionId);
}

export function getRawQR(sessionId) {
  if (!sessionId) return null;
  return qrBySessionId.get(sessionId) || null;
}

export async function getQRDataURL(sessionId) {
  const raw = getRawQR(sessionId);
  if (!raw) return null;
  return QRCode.toDataURL(raw, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}
