const API_BASE = import.meta.env.VITE_API_URL || '/api';
const KEY_STORAGE = 'wup_api_key';

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage unavailable */ }
}

export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `API error: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return res.json();
}

/**
 * Open the SSE stream. EventSource can't send headers, so the API key rides
 * along as a query parameter — the auth middleware accepts it there.
 */
export function openEventStream() {
  const key = getApiKey();
  const url = `${API_BASE}/events${key ? `?apiKey=${encodeURIComponent(key)}` : ''}`;
  return new EventSource(url);
}
