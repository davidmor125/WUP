import { useEffect, useMemo, useRef, useState } from 'react';
import { toChatId } from '../lib/chatId';

/**
 * Start a conversation with a number that isn't in the address book.
 *
 * WhatsApp needs the full international number without a leading + or zeros,
 * so the entry is normalized and previewed before sending — a wrong country
 * code silently delivers to the wrong person, or to nobody.
 */
export default function NewChatDialog({ open, onClose, onStart, defaultCountry = '972' }) {
  const [raw, setRaw] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRaw('');
      // Autofocus so the dialog is usable straight from the keyboard.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const normalized = useMemo(() => {
    let digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    // A local number like 054-123-4567 becomes 972541234567.
    if (raw.trim().startsWith('0') || (digits.startsWith('0') && !raw.includes('+'))) {
      digits = defaultCountry + digits.replace(/^0+/, '');
    }
    if (digits.length < 8) return null;
    return digits;
  }, [raw, defaultCountry]);

  if (!open) return null;

  function submit(e) {
    e.preventDefault();
    if (!normalized) return;
    onStart({
      id: toChatId(normalized),
      type: 'private',
      phone: normalized,
      name: null,
      isNew: true,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 grid place-items-center px-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-sm p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium mb-1">New chat</h2>
        <p className="text-xs text-muted mb-4">
          Message any WhatsApp number, saved or not.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="054-123-4567 or +972541234567"
            className="w-full text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
          />

          <p className="text-xs text-muted min-h-4">
            {normalized
              ? <>Will message <span className="font-medium text-text">+{normalized}</span></>
              : raw.trim() && 'Enter a full number including country code.'}
          </p>

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-canvas transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!normalized}
              className="text-sm bg-accent text-white px-4 py-1.5 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
            >
              Start chat
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
