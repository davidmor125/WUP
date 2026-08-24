import { useState } from 'react';
import { apiFetch, getApiKey, setApiKey } from '../api/client';
import { useApi } from '../hooks/useApi';
import ConfirmDialog from './ConfirmDialog.jsx';

/**
 * Manage the shared API key.
 *
 * The key is generated and stored server-side so it can be rotated without
 * editing .env and restarting — but a key injected through the environment
 * still wins, and rotation is disabled in that case rather than pretending to
 * work and silently diverging from what the platform holds.
 */
export default function ApiKeySection() {
  const { data, refetch } = useApi('/auth/status');
  const status = data?.data || {};

  const [revealed, setRevealed] = useState(null);
  const [manual, setManual] = useState(getApiKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  async function run(fn) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      refetch();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const generate = () => run(async () => {
    const res = await apiFetch('/auth/rotate', { method: 'POST' });
    const key = res.data.key;
    // Save it locally at once — otherwise the rotation would lock this very
    // browser out of the API it just secured.
    setApiKey(key);
    setManual(key);
    setRevealed(key);
    setConfirmRotate(false);
    setNotice('New key generated and saved in this browser. Update any other clients.');
  });

  const reveal = () => run(async () => {
    const res = await apiFetch('/auth/key');
    setRevealed(res.data.key);
  });

  const disable = () => run(async () => {
    await apiFetch('/auth/disable', { method: 'POST' });
    setApiKey('');
    setManual('');
    setRevealed(null);
    setConfirmDisable(false);
    setNotice('Authentication disabled. Anyone who can reach this server can use the API.');
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(revealed);
      setNotice('Copied to clipboard.');
    } catch {
      setError('Could not copy — select the key and copy manually.');
    }
  }

  return (
    <section className="bg-surface border border-border rounded-xl p-5">
      <ConfirmDialog
        open={confirmRotate}
        title="Generate a new key?"
        message="The current key stops working immediately. Any script, webhook consumer, or other browser using it must be updated."
        confirmLabel="Generate"
        danger
        busy={busy}
        onConfirm={generate}
        onClose={() => setConfirmRotate(false)}
      />
      <ConfirmDialog
        open={confirmDisable}
        title="Disable authentication?"
        message="The API will accept every request without a key. Only do this on a machine that is not reachable from the internet."
        confirmLabel="Disable"
        danger
        busy={busy}
        onConfirm={disable}
        onClose={() => setConfirmDisable(false)}
      />

      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-sm font-medium">API key</h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${
          status.enabled ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
        }`}>
          {status.enabled ? `Protected · ${status.hint}` : 'Unprotected'}
        </span>
      </div>

      <p className="text-xs text-muted mb-4">
        {status.enabled
          ? 'Required on every API request. Sent automatically from this browser.'
          : 'The API currently accepts any request. Generate a key before exposing this server.'}
      </p>

      {status.envManaged && (
        <p className="text-xs text-muted bg-canvas border border-border rounded-md px-3 py-2 mb-3">
          The key comes from the <code>API_KEY</code> environment variable, so it can't be rotated
          here. Change it where the server is configured, then restart.
        </p>
      )}

      {revealed && (
        <div className="mb-3">
          <div className="flex gap-2">
            <code className="flex-1 text-xs bg-canvas border border-border rounded-md px-3 py-2 break-all">
              {revealed}
            </code>
            <button
              onClick={copy}
              className="text-sm px-3 py-2 rounded-md border border-border hover:bg-canvas transition-colors shrink-0"
            >
              Copy
            </button>
          </div>
          <p className="text-[11px] text-muted mt-1">
            Store this somewhere safe. Other clients need it to call the API.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!status.envManaged && (
          <button
            onClick={() => (status.enabled ? setConfirmRotate(true) : generate())}
            disabled={busy}
            className="text-sm bg-accent text-white px-4 py-2 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
          >
            {status.enabled ? 'Generate new key' : 'Generate key'}
          </button>
        )}
        {status.enabled && !revealed && (
          <button
            onClick={reveal}
            disabled={busy}
            className="text-sm px-4 py-2 rounded-md border border-border hover:bg-canvas transition-colors disabled:opacity-50"
          >
            Show current key
          </button>
        )}
        {status.enabled && !status.envManaged && (
          <button
            onClick={() => setConfirmDisable(true)}
            disabled={busy}
            className="text-sm px-4 py-2 rounded-md border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            Disable auth
          </button>
        )}
      </div>

      <details className="mt-4">
        <summary className="text-xs text-muted cursor-pointer">Use a key from another server</summary>
        <div className="flex gap-2 mt-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            type="password"
            placeholder="Paste an API key"
            className="flex-1 text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => { setApiKey(manual.trim()); setNotice('Saved in this browser.'); refetch(); }}
            className="text-sm px-4 py-2 rounded-md border border-border hover:bg-canvas transition-colors"
          >
            Save
          </button>
        </div>
        <p className="text-[11px] text-muted mt-1">
          Only stores the key in this browser — it does not change the server's key.
        </p>
      </details>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2 mt-3">{error}</p>
      )}
      {notice && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-md px-3 py-2 mt-3">{notice}</p>
      )}
    </section>
  );
}
