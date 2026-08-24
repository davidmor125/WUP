/**
 * Mirror of the server's toChatId() — used to build the id for a number the
 * user types that isn't in their contacts yet, so the ad-hoc chat addresses
 * exactly the same target the backend would resolve.
 */
export function toChatId(input) {
  const value = String(input || '').trim();
  if (/@(c\.us|g\.us|lid|broadcast|newsletter)$/.test(value)) return value;

  const phone = value.replace(/[\s+\-().]/g, '');
  const isLid = phone.length > 13 || !/^[1-9]\d{6,12}$/.test(phone);
  return `${phone}@${isLid ? 'lid' : 'c.us'}`;
}
