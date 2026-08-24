/**
 * Build the correct WhatsApp chat ID for a phone number or group id.
 *
 * - A value that already carries a WhatsApp suffix (@c.us, @g.us, @lid) is
 *   passed through untouched — that lets callers hand us a group id directly.
 * - Linked-device contacts use opaque LID ids (long numeric, not real phone
 *   numbers) and need the @lid suffix; regular contacts use @c.us.
 */
export function toChatId(input) {
  const value = String(input || '').trim();
  if (/@(c\.us|g\.us|lid|broadcast|newsletter)$/.test(value)) return value;

  const phone = value.replace(/[\s+\-().]/g, '');
  const isLid = phone.length > 13 || !/^[1-9]\d{6,12}$/.test(phone);
  return `${phone}@${isLid ? 'lid' : 'c.us'}`;
}

/** Strip the @domain suffix, leaving the bare number / id. */
export function fromChatId(chatId) {
  return String(chatId || '').replace(/@.*$/, '');
}

/** True when the chat id addresses a group. */
export function isGroupChatId(chatId) {
  return String(chatId || '').endsWith('@g.us');
}
