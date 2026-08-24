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

export default function MessageBody({ message }) {
  const { body, type, hasMedia, media } = message;
  const src = media?.path ? `/${media.path}` : null;
  const mime = media?.mimetype || '';

  const emojiOnly = body && EMOJI_ONLY.test(body) && /\p{Extended_Pictographic}/u.test(body);

  return (
    <>
      {src && (
        <div className="mb-1">
          {mime.startsWith('image/') || type === 'sticker' ? (
            <img
              src={src}
              alt={type === 'sticker' ? 'Sticker' : 'Image'}
              className={type === 'sticker' ? 'max-h-32' : 'rounded max-w-full max-h-64'}
            />
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
