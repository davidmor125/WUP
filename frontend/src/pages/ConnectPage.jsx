import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { apiFetch } from '../api/client';
import StatusDot from '../components/StatusDot.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import ApiKeySection from '../components/ApiKeySection.jsx';

export default function ConnectPage() {
  const { data: statusData, refetch } = useApi('/whatsapp/status', { interval: 3000 });
  const status = statusData?.data?.status || 'disconnected';
  const info = statusData?.data || {};

  const awaitingScan = status === 'qr_pending';
  const connecting = status === 'initializing';
  const connected = status === 'ready' || status === 'authenticated';

  // Only poll for a QR while one can actually exist.
  const { data: qrData } = useApi('/whatsapp/qr-data', {
    interval: 2000,
    enabled: awaitingScan || connecting,
  });
  const qrImage = qrData?.data?.qr;

  const [mode, setMode] = useState('qr');
  const [phone, setPhone] = useState('');
  const [pairCode, setPairCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refetch();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const connect = () => run(async () => {
    setPairCode(null);
    await apiFetch('/whatsapp/connect', { method: 'POST' });
  });

  const disconnect = () => run(() => apiFetch('/whatsapp/disconnect', { method: 'POST' }));

  const logout = () => run(async () => {
    await apiFetch('/whatsapp/logout', { method: 'POST' });
    setConfirmUnlink(false);
  });

  const requestPairCode = () => run(async () => {
    const res = await apiFetch('/whatsapp/pair', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: phone }),
    });
    setPairCode(res.data.code);
  });

  return (
    <div className="max-w-2xl space-y-5">
      <ConfirmDialog
        open={confirmUnlink}
        title="Unlink this device?"
        message="The saved WhatsApp session is cleared. Reconnecting will require scanning a new QR code."
        confirmLabel="Unlink"
        danger
        busy={busy}
        onConfirm={logout}
        onClose={() => setConfirmUnlink(false)}
      />

      <section className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusDot status={status} />
            <div>
              <div className="text-sm font-medium capitalize">{status.replace('_', ' ')}</div>
              {info.phoneNumber && (
                <div className="text-xs text-muted">
                  +{info.phoneNumber}{info.pushname ? ` · ${info.pushname}` : ''}
                </div>
              )}
              {info.lastError && <div className="text-xs text-red-600 mt-0.5">{info.lastError}</div>}
            </div>
          </div>

          <div className="flex gap-2">
            {!connected && (
              <button
                onClick={connect}
                disabled={busy}
                className="text-sm font-medium bg-accent text-white px-4 py-1.5 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
              >
                {connecting || awaitingScan ? 'Restart' : 'Connect'}
              </button>
            )}
            {connected && (
              <>
                <button
                  onClick={disconnect}
                  disabled={busy}
                  className="text-sm px-4 py-1.5 rounded-md border border-border hover:bg-canvas transition-colors disabled:opacity-50"
                >
                  Disconnect
                </button>
                <button
                  onClick={() => setConfirmUnlink(true)}
                  disabled={busy}
                  className="text-sm px-4 py-1.5 rounded-md border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  Unlink
                </button>
              </>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
        )}

        {(awaitingScan || connecting) && (
          <div className="mt-5 pt-5 border-t border-border">
            <div className="flex justify-center gap-2 mb-4">
              {['qr', 'phone'].map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setPairCode(null); }}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                    mode === m ? 'bg-accent text-white border-accent' : 'border-border text-muted hover:text-text'
                  }`}
                >
                  {m === 'qr' ? 'Scan QR code' : 'Pair with phone number'}
                </button>
              ))}
            </div>

            {mode === 'qr' ? (
              <div className="text-center">
                {qrImage ? (
                  <>
                    <img src={qrImage} alt="WhatsApp QR code" className="mx-auto w-64 h-64 rounded-md" />
                    <p className="text-xs text-muted mt-3">
                      WhatsApp → Settings → Linked devices → Link a device
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted py-16">Waiting for a QR code…</p>
                )}
              </div>
            ) : (
              <div className="text-center space-y-3">
                {pairCode ? (
                  <>
                    <div className="text-3xl font-mono tracking-[0.3em] py-4">{pairCode}</div>
                    <p className="text-xs text-muted">Enter this code on your phone to finish linking.</p>
                  </>
                ) : (
                  <>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="972500000000"
                      className="w-56 text-sm text-center border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
                    />
                    <div>
                      <button
                        onClick={requestPairCode}
                        disabled={busy || !phone.trim()}
                        className="text-sm bg-accent text-white px-4 py-1.5 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
                      >
                        Get pairing code
                      </button>
                    </div>
                    <p className="text-xs text-muted">Country code, no + or spaces.</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <ApiKeySection />
    </div>
  );
}
