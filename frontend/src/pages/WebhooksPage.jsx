import { useState } from 'react';
import { apiFetch } from '../api/client';
import { useApi } from '../hooks/useApi';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

const CHAT_FILTERS = [
  { value: 'all', label: 'All chats' },
  { value: 'private', label: 'People only' },
  { value: 'group', label: 'Groups only' },
];

const EMPTY = { name: '', url: '', chatFilter: 'all', events: [] };

export default function WebhooksPage() {
  const { data: hooksData, refetch } = useApi('/webhooks');
  const { data: eventsData } = useApi('/webhooks/events');
  const { data: deliveriesData, refetch: refetchDeliveries } = useApi('/webhooks/deliveries', {
    params: { limit: 25 },
    interval: 10000,
  });

  const webhooks = hooksData?.data || [];
  const availableEvents = eventsData?.data || [];
  const deliveries = deliveriesData?.data || [];

  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  async function run(fn, message) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
      refetch();
      refetchDeliveries();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const create = (e) => {
    e.preventDefault();
    return run(async () => {
      await apiFetch('/webhooks', { method: 'POST', body: JSON.stringify(form) });
      setForm(EMPTY);
    }, 'Webhook created.');
  };

  const toggle = (hook) =>
    run(() => apiFetch(`/webhooks/${hook.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !hook.enabled }),
    }));

  const remove = (hook) =>
    run(async () => {
      await apiFetch(`/webhooks/${hook.id}`, { method: 'DELETE' });
      setPendingDelete(null);
    }, 'Webhook deleted.');

  const test = (hook) =>
    run(async () => {
      const res = await apiFetch(`/webhooks/${hook.id}/test`, { method: 'POST' });
      if (!res.success) throw new Error(res.data?.error || 'Test delivery failed');
    }, 'Test delivery succeeded.');

  const retry = (delivery) =>
    run(() => apiFetch(`/webhooks/deliveries/${delivery.id}/retry`, { method: 'POST' }), 'Retried.');

  function toggleEvent(name) {
    setForm((f) => ({
      ...f,
      events: f.events.includes(name) ? f.events.filter((e) => e !== name) : [...f.events, name],
    }));
  }

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this webhook?"
        message={`${pendingDelete?.name || pendingDelete?.url || ''} will stop receiving events. Its delivery history is removed too.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => remove(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{error}</p>
      )}
      {notice && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-md px-3 py-2">{notice}</p>
      )}

      <section className="bg-surface border border-border rounded-xl p-5">
        <h2 className="text-sm font-medium mb-1">Add a webhook</h2>
        <p className="text-xs text-muted mb-4">
          Every event is POSTed as JSON, signed with <code>X-Webhook-Signature</code> (HMAC-SHA256 over
          <code> {'{timestamp}.{body}'}</code>). Failures retry three times before being logged.
        </p>

        <form onSubmit={create} className="space-y-3">
          <div className="flex gap-2">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name (optional)"
              className="w-48 text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
            />
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://example.com/hook"
              required
              className="flex-1 text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
            />
            <select
              value={form.chatFilter}
              onChange={(e) => setForm({ ...form, chatFilter: e.target.value })}
              className="text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
            >
              {CHAT_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            {availableEvents.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggleEvent(name)}
                className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                  form.events.includes(name)
                    ? 'bg-accent text-white border-accent'
                    : 'border-border text-muted hover:text-text'
                }`}
              >
                {name}
              </button>
            ))}
            <span className="text-xs text-muted self-center">
              {form.events.length === 0 && '(none selected → subscribes to all)'}
            </span>
          </div>

          <button
            type="submit"
            disabled={busy || !form.url.trim()}
            className="text-sm bg-accent text-white px-4 py-2 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
          >
            Add webhook
          </button>
        </form>
      </section>

      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <h2 className="text-sm font-medium px-5 py-3 border-b border-border">
          Webhooks ({webhooks.length})
        </h2>
        {webhooks.length === 0 ? (
          <p className="text-xs text-muted px-5 py-6">No webhooks configured.</p>
        ) : (
          <ul className="divide-y divide-border">
            {webhooks.map((hook) => (
              <li key={hook.id} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${hook.enabled ? 'bg-green-500' : 'bg-zinc-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{hook.name || hook.url}</div>
                    <div className="text-xs text-muted truncate">{hook.url}</div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {hook.chatFilter} · {hook.events.join(', ')}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => test(hook)} disabled={busy}
                      className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-canvas disabled:opacity-50">
                      Test
                    </button>
                    <button onClick={() => toggle(hook)} disabled={busy}
                      className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-canvas disabled:opacity-50">
                      {hook.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => setPendingDelete(hook)} disabled={busy}
                      className="text-xs px-2.5 py-1 rounded-md border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="text-[11px] text-muted cursor-pointer">Signing secret</summary>
                  <code className="text-[11px] break-all">{hook.secret}</code>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <h2 className="text-sm font-medium px-5 py-3 border-b border-border">Recent deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="text-xs text-muted px-5 py-6">Nothing delivered yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-5 py-2">Event</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
                <th className="text-left font-medium px-3 py-2">Attempts</th>
                <th className="text-left font-medium px-3 py-2">When</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="px-5 py-2">{d.event}</td>
                  <td className="px-3 py-2">
                    <span className={
                      d.status === 'sent' ? 'text-green-600'
                        : d.status === 'failed' ? 'text-red-600' : 'text-amber-600'
                    }>
                      {d.status}{d.statusCode ? ` (${d.statusCode})` : ''}
                    </span>
                    {d.error && <div className="text-[10px] text-muted truncate max-w-xs">{d.error}</div>}
                  </td>
                  <td className="px-3 py-2">{d.attempts}</td>
                  <td className="px-3 py-2 text-muted">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">
                    {d.status === 'failed' && (
                      <button onClick={() => retry(d)} disabled={busy}
                        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-canvas disabled:opacity-50">
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
