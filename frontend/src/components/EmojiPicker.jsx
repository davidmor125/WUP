import { useEffect, useRef, useState } from 'react';

// A compact, dependency-free picker. WhatsApp accepts any Unicode emoji in a
// plain text message, so there is nothing to encode — these are just characters.
const GROUPS = {
  Smileys: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','😘','😗','😋','😛','🤪','🤨','🧐','🤓','😎','🥳','😏','😒','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','🤗','🤔','🤭','🤫','🤥','😐','😑','😬','🙄','😯','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕'],
  Gestures: ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','✍️','💪','🦾','👏','🙌','👐','🤲','🫶','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝','🔥','⭐','🌟','✨','💫','💯'],
  Objects: ['📱','💻','⌨️','🖥️','🖨️','📷','📸','🎥','📞','☎️','📠','📺','📻','⏰','⌚','📅','📆','📌','📎','✂️','📝','📄','📁','📂','🗂️','📊','📈','📉','💰','💵','💳','🧾','🎁','📦','✉️','📧','📨','📩','📤','📥','🔒','🔓','🔑','🔨','🔧','⚙️','🧰','🔍','💡','🔔','🔕'],
  Travel: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🚲','✈️','🛫','🛬','🚀','🛸','🚁','⛵','🚤','🛳️','🏠','🏢','🏥','🏦','🏨','🏫','🏭','⛪','🕌','🗼','🗽','⛲','🌍','🌎','🌏','🗺️','🧭','⛱️','🏖️','🏝️','⛰️','🏔️','🌋'],
  Food: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🥦','🥕','🌽','🌶️','🥒','🥬','🧄','🧅','🍄','🥜','🌰','🍞','🥐','🥖','🥨','🧀','🥚','🍳','🥞','🧇','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥗','🍝','🍜','🍲','🍣','🍱','🍦','🍰','🎂','🍫','🍬','☕','🍵','🍺','🍷'],
  Symbols: ['✅','❌','⭕','❗','❓','⚠️','🚫','💤','♻️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🔶','🔷','🔺','🔻','▶️','⏸️','⏹️','⏭️','🔀','🔁','🔄','➕','➖','✖️','➗','🟰','💲','🆗','🆕','🆙','🔝','🔜','#️⃣','1️⃣','2️⃣','3️⃣','🎉','🎊','🎈','🏆','🥇','🎯','🎵','🎶'],
};

export default function EmojiPicker({ onPick, onClose }) {
  const [tab, setTab] = useState('Smileys');
  const ref = useRef(null);

  // Close on outside click or Escape — a picker that traps the user is worse
  // than no picker.
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-14 left-3 z-20 w-80 bg-surface border border-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="flex border-b border-border overflow-x-auto">
        {Object.keys(GROUPS).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setTab(g)}
            className={`text-[11px] px-2.5 py-2 whitespace-nowrap transition-colors ${
              tab === g ? 'text-accent-dark font-medium border-b-2 border-accent' : 'text-muted hover:text-text'
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-8 gap-0.5 p-2 max-h-56 overflow-y-auto">
        {GROUPS[tab].map((e, i) => (
          <button
            key={`${e}-${i}`}
            type="button"
            onClick={() => onPick(e)}
            className="text-xl leading-none p-1 rounded hover:bg-canvas transition-colors"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
