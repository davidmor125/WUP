import { useState } from 'react';

/**
 * Render one message's content: media when present, then text.
 *
 * A message can legitimately have no text (a sticker, an image with no
 * caption), and media that failed to download leaves nothing to show at all.
 * Both used to render as a blank bubble, which reads as a bug. Every message
 * therefore falls back to a label describing what it actually is.
 */

const TYPE_LABEL = {
  sticker: '🎨 Sticker',
  image: '🖼️ Image',
  video: '🎥 Video',
  audio: '🎵 Audio',
  ptt: '🎤 Voice message',
  document: '📄 Document',
  location: '📍 Location',
  vcard: '👤 Contact card',
  multi_vcard: '👥 Contacts',
  poll_creation: '📊 Poll',
  revoked: '🚫 Message deleted',
  e2e_notification: '🔒 Encryption notice',
  notification_template: 'ℹ️ System notice',
  call_log: '📞 Call',
};

// Emoji render small inside a text run; a message that is *only* emoji reads
// better large, the way every chat client shows it.
const EMOJI_ONLY = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|️|‍|\s){1,12}$/u;

/**
 * Turn a stored media path into a URL the server actually serves.
 *
 * Paths are stored relative to the project ("data/media/x.jpg") but the server
 * mounts that folder at "/media", so the stored prefix has to be swapped rather
 * than simply prepended with a slash.
 */
function mediaUrl(storedPath) {
  if (!storedPath) return null;
  const clean = String(storedPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/media/${clean.replace(/^data\/media\//, '')}`;
}

export default function MessageBody({ message }) {
  const [broken, setBroken] = useState(false);
  const { body, type, hasMedia, media } = message;
  // The API supplies a ready URL; deriving from `path` covers rows delivered by
  // an older build (and messages arriving over SSE from one).
  const src = media?.url || mediaUrl(media?.path);
  const mime = media?.mimetype || '';

  const emojiOnly = body && EMOJI_ONLY.test(body) && /\p{Extended_Pictographic}/u.test(body);

  return (
    <>
      {src && (
        <div className="mb-1">
          {mime.startsWith('image/') || type === 'sticker' ? (
            broken ? (
              // A broken-image icon says nothing about what went wrong; name the
              // file and offer the link so the failure is diagnosable.
              <a href={src} target="_blank" rel="noreferrer"
                className="text-xs text-muted italic underline break-all">
                🖼️ {media.filename || 'Image'} — could not be displayed
              </a>
            ) : (
              <img
                src={src}
                alt={type === 'sticker' ? 'Sticker' : 'Image'}
                onError={() => setBroken(true)}
                className={type === 'sticker' ? 'max-h-32' : 'rounded max-w-full max-h-64'}
              />
            )
          ) : mime.startsWith('video/') ? (
            <video controls src={src} className="rounded max-w-full max-h-64" />
          ) : mime.startsWith('audio/') ? (
            <audio controls src={src} className="max-w-full" />
          ) : (
            <a href={src} download className="text-xs underline break-all">
              {media.filename || TYPE_LABEL[type] || 'Download attachment'}
            </a>
          )}
        </div>
      )}

      {body ? (
        <div className={emojiOnly ? 'text-4xl leading-tight' : 'text-sm whitespace-pre-wrap break-words'}>
          {body}
        </div>
      ) : (
        // No text: say what this message is rather than showing an empty bubble.
        !src && (
          <div className="text-sm text-muted italic">
            {TYPE_LABEL[type] || `[${type || 'message'}]`}
            {hasMedia && !src && ' — not downloaded'}
          </div>
        )
      )}
    </>
  );
}
