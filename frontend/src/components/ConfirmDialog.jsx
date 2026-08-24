import { useEffect, useRef } from 'react';

/**
 * In-app replacement for window.confirm().
 *
 * The native dialog can't be styled, blocks the whole tab, and renders with the
 * browser's chrome ("localhost:5173 says…"), which looks like an error rather
 * than a deliberate choice. This keeps the same semantics — confirm or cancel —
 * inside the app's own design.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Focus the confirm button so Enter/Escape both work without reaching for
    // the mouse.
    const timer = setTimeout(() => confirmRef.current?.focus(), 0);
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 grid place-items-center px-4"
      onClick={() => !busy && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-sm p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium mb-1">{title}</h2>
        <p className="text-xs text-muted mb-5">{message}</p>

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-canvas transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`text-sm text-white px-4 py-1.5 rounded-md transition-colors disabled:opacity-50 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-dark'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
