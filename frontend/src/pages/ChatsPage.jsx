import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useEventStream } from '../hooks/useEventStream';
import { toChatId } from '../lib/chatId';
import NewChatDialog from '../components/NewChatDialog.jsx';
import EmojiPicker from '../components/EmojiPicker.jsx';
import MessageBody from '../components/MessageBody.jsx';

const TABS = [
  { key: '', label: 'All' },
  { key: 'private', label: 'People' },
  { key: 'group', label: 'Groups' },
];

function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

const ACK_LABEL = { 0: '🕘', 1: '✓', 2: '✓✓', 3: '✓✓', 4: '✓✓' };

export default function ChatsPage() {
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  // 16 MB is WhatsApp's practical ceiling for most media; the API also caps the
  // JSON body, and base64 inflates a file by roughly a third.
  const MAX_FILE_BYTES = 16 * 1024 * 1024;

  function pickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after removing it
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB — the limit is 16 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setError(null);
      setAttachment({
        filename: file.name,
        mimetype: file.type || 'application/octet-stream',
        size: file.size,
        preview: dataUrl,
        base64: dataUrl.split(',')[1], // strip the "data:…;base64," prefix
      });
    };
    reader.onerror = () => setError(`Could not read "${file.name}".`);
    reader.readAsDataURL(file);
  }

  // Three sources, merged into one list:
  //  - contacts: the device address book, available the moment you link
  //  - chats:    every conversation on the device, including unsaved numbers
  //  - stored:   what this service has captured, for unread counts + previews
  const { data: contactsData } = useApi('/whatsapp/contacts');
  const { data: chatsData } = useApi('/whatsapp/chats', { interval: 60000 });
  const { data: storedData, refetch: refetchStored } = useApi('/messages/chats', { interval: 15000 });

  const entries = useMemo(() => {
    const merged = new Map();

    /**
     * Key on the phone number for private chats.
     *
     * WhatsApp knows a person by two identities: their phone number
     * (972500000000@c.us) and, once they use a linked device, an opaque LID
     * (241952805122230@lid). The address book returns the first, conversations
     * return the second — so keying on `id` listed the same person twice.
     * Groups have no phone number and key on their id as before.
     */
    const keyOf = (item) =>
      (item.type === 'private' && item.phone) ? `phone:${item.phone}` : item.id;

    const put = (item) => {
      const key = keyOf(item);
      const prev = merged.get(key);
      merged.set(key, {
        ...prev,
        ...item,
        // Never let a later source blank out a name we already have.
        name: item.name || prev?.name || null,
        // Keep whichever id can actually be messaged. A @lid chat is the live
        // conversation, so it wins over the address-book @c.us entry.
        id: (item.id?.endsWith('@lid') ? item.id : prev?.id?.endsWith('@lid') ? prev.id : item.id),
        lastMessageAt: item.lastMessageAt || prev?.lastMessageAt || null,
        lastMessage: item.lastMessage || prev?.lastMessage || null,
      });
    };

    for (const c of contactsData?.data || []) {
      put({ id: c.id, type: c.type, phone: c.phone, name: c.name });
    }
    for (const c of chatsData?.data || []) {
      put({
        id: c.id, type: c.type, phone: c.phone, name: c.name,
        lastMessageAt: c.lastMessageAt, deviceUnread: c.unreadCount,
        participantsCount: c.participantsCount,
      });
    }
    for (const c of storedData?.data || []) {
      put({
        id: c.id, type: c.type, phone: c.phone, name: c.name,
        lastMessageAt: c.lastMessageAt, lastMessage: c.lastMessage, unreadCount: c.unreadCount,
      });
    }

    return [...merged.values()];
  }, [contactsData, chatsData, storedData]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return entries
      .filter((c) => !tab || c.type === tab)
      .filter((c) => !q
        || c.name?.toLowerCase().includes(q)
        // Guard on `digits` — an empty string makes includes() match everything.
        || (digits && c.phone?.includes(digits)))
      .sort((a, b) => {
        // Conversations first (most recent on top), then the rest of the book.
        if (!!a.lastMessageAt !== !!b.lastMessageAt) return a.lastMessageAt ? -1 : 1;
        if (a.lastMessageAt && b.lastMessageAt) return b.lastMessageAt.localeCompare(a.lastMessageAt);
        return (a.name || a.phone || '').localeCompare(b.name || b.phone || '');
      })
      .slice(0, 400);
  }, [entries, tab, search]);

  // A typed phone number that matches nothing becomes a "message this number" row.
  const adHoc = useMemo(() => {
    const digits = search.replace(/\D/g, '');
    if (digits.length < 7) return null;
    const id = toChatId(digits);
    if (entries.some((c) => c.id === id)) return null;
    return { id, type: 'private', phone: digits, name: null, isNew: true };
  }, [search, entries]);

  const loadMessages = useCallback(async (chatId) => {
    const res = await apiFetch(`/messages?chatId=${encodeURIComponent(chatId)}&limit=100`);
    setMessages((res.data || []).slice().reverse()); // API is newest-first
  }, []);

  useEffect(() => {
    if (!active) return;
    setMessages([]);
    loadMessages(active.id).catch((err) => setError(err.message));
    apiFetch(`/messages/chats/${encodeURIComponent(active.id)}/read`, { method: 'POST' })
      .then(refetchStored)
      .catch(() => {});
  }, [active, loadMessages, refetchStored]);

  useEventStream((envelope) => {
    if (envelope.event === 'message.ack') {
      const { waMessageId, ack } = envelope.data;
      setMessages((prev) => prev.map((m) => (m.waMessageId === waMessageId ? { ...m, ack } : m)));
      return;
    }
    if (envelope.event !== 'message.inbound' && envelope.event !== 'message.outbound') return;

    const msg = envelope.data;
    setMessages((prev) => {
      if (msg.chatId !== active?.id) return prev;
      if (prev.some((m) => m.waMessageId === msg.waMessageId)) return prev;
      return [...prev, msg];
    });
    refetchStored();
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    if (!active || (!draft.trim() && !attachment)) return;
    setSending(true);
    setError(null);
    setEmojiOpen(false);
    try {
      const res = await apiFetch('/messages', {
        method: 'POST',
        body: JSON.stringify({
          to: active.id,
          body: draft.trim(),
          // With media the text rides along as the caption.
          ...(attachment && {
            media: {
              base64: attachment.base64,
              mimetype: attachment.mimetype,
              filename: attachment.filename,
            },
          }),
        }),
      });
      setDraft('');
      setAttachment(null);
      setMessages((prev) =>
        prev.some((m) => m.waMessageId === res.data.waMessageId) ? prev : [...prev, res.data]);
      refetchStored();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  const counts = useMemo(() => ({
    people: entries.filter((c) => c.type === 'private').length,
    groups: entries.filter((c) => c.type === 'group').length,
  }), [entries]);

  function Row({ c }) {
    const selected = active?.id === c.id;
    return (
      <button
        onClick={() => { setActive(c); setError(null); }}
        className={`w-full text-left px-3 py-2.5 border-b border-border/60 transition-colors ${
          selected ? 'bg-accent/5' : 'hover:bg-canvas'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs shrink-0">{c.type === 'group' ? '👥' : '👤'}</span>
          <span className="text-sm truncate flex-1">
            {c.name || (c.phone ? `+${c.phone}` : c.id)}
          </span>
          {c.lastMessageAt && (
            <span className="text-[10px] text-muted shrink-0">{timeOf(c.lastMessageAt)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 pl-6">
          <span className="text-xs text-muted truncate flex-1">
            {/* WhatsApp allows two groups to share a name, so show the member
                count to tell same-named groups apart. */}
            {c.lastMessage
              || (c.type === 'group' && c.participantsCount ? `${c.participantsCount} members` : '')
              || (c.name && c.phone ? `+${c.phone}` : '')}
          </span>
          {c.unreadCount > 0 && (
            <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 shrink-0">
              {c.unreadCount}
            </span>
          )}
        </div>
      </button>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-8.5rem)]">
      <NewChatDialog
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onStart={(target) => { setActive(target); setSearch(''); setError(null); }}
      />

      <aside className="w-80 shrink-0 bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-border space-y-2">
          <button
            onClick={() => setNewChatOpen(true)}
            className="w-full text-sm font-medium bg-accent text-white px-4 py-2 rounded-md hover:bg-accent-dark transition-colors flex items-center justify-center gap-1.5"
          >
            <span className="text-base leading-none">+</span> New chat
          </button>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search, or type a number…"
            className="w-full text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
          />
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${
                  tab === t.key ? 'bg-accent/10 text-accent-dark font-medium' : 'text-muted hover:text-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted">{counts.people} people · {counts.groups} groups</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {adHoc && (
            <button
              onClick={() => { setActive(adHoc); setError(null); }}
              className="w-full text-left px-3 py-2.5 border-b border-border bg-accent/5 hover:bg-accent/10 transition-colors"
            >
              <div className="text-sm font-medium">💬 Message +{adHoc.phone}</div>
              <div className="text-[11px] text-muted">Not in your contacts — start a new chat</div>
            </button>
          )}
          {visible.length === 0 && !adHoc && (
            <p className="text-xs text-muted text-center py-8 px-4">
              No matches. Type a full phone number to message someone new.
            </p>
          )}
          {visible.map((c) => <Row key={c.id} c={c} />)}
        </div>
      </aside>

      <section className="flex-1 bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
        {!active ? (
          <div className="flex-1 grid place-items-center text-sm text-muted px-8 text-center">
            Pick a contact, group, or type a phone number to start.
          </div>
        ) : (
          <>
            <header className="px-4 py-3 border-b border-border">
              <div className="text-sm font-medium">
                {active.name || (active.phone ? `+${active.phone}` : active.id)}
              </div>
              <div className="text-xs text-muted">
                {active.type === 'group' ? 'Group' : active.phone ? `+${active.phone}` : ''} · {active.id}
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {messages.length === 0 && (
                <p className="text-xs text-muted text-center py-8">
                  {active.isNew
                    ? `New conversation with +${active.phone}. Send the first message below.`
                    : 'No messages stored yet. Anything sent or received from now on appears here.'}
                </p>
              )}
              {messages.map((m) => {
                const outbound = m.direction === 'outbound';
                return (
                  <div key={m.waMessageId} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-lg px-3 py-2 ${outbound ? 'bg-accent/15' : 'bg-canvas'}`}>
                      {active.type === 'group' && !outbound && (
                        <div className="text-[11px] font-medium text-accent-dark mb-0.5">
                          {m.authorName || m.authorId}
                        </div>
                      )}
                      <MessageBody message={m} />
                      <div className="text-[10px] text-muted text-right mt-0.5">
                        {timeOf(m.timestamp)} {outbound && (ACK_LABEL[m.ack] || '')}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error && <p className="px-4 py-2 text-xs text-red-600 bg-red-50">{error}</p>}

            {attachment && (
              <div className="flex items-center gap-3 px-3 py-2 border-t border-border bg-canvas">
                {attachment.mimetype.startsWith('image/') ? (
                  <img src={attachment.preview} alt="" className="w-12 h-12 object-cover rounded" />
                ) : (
                  <span className="text-2xl">📄</span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{attachment.filename}</div>
                  <div className="text-[11px] text-muted">{Math.round(attachment.size / 1024)} KB</div>
                </div>
                <button
                  onClick={() => setAttachment(null)}
                  className="text-xs text-muted hover:text-red-600 px-2"
                >
                  Remove
                </button>
              </div>
            )}

            <form onSubmit={send} className="relative flex gap-2 p-3 border-t border-border">
              {emojiOpen && (
                <EmojiPicker
                  onPick={(e) => setDraft((d) => d + e)}
                  onClose={() => setEmojiOpen(false)}
                />
              )}

              <button
                type="button"
                onClick={() => setEmojiOpen((v) => !v)}
                title="Emoji"
                className="text-lg px-2 rounded-md hover:bg-canvas transition-colors"
              >
                😀
              </button>

              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Attach image or file"
                className="text-lg px-2 rounded-md hover:bg-canvas transition-colors"
              >
                📎
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
                onChange={pickFile}
              />

              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={attachment ? 'Add a caption…' : 'Type a message…'}
                className="flex-1 text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={sending || (!draft.trim() && !attachment)}
                className="text-sm bg-accent text-white px-4 py-2 rounded-md hover:bg-accent-dark transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
