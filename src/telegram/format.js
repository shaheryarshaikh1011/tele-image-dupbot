/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build a t.me link to a message. Works for public groups (username) and for private
 * supergroups (t.me/c/<internal id>/<message id>). Basic groups have no message links.
 */
export function messageLink(chat, messageId) {
  if (!chat || !messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id ?? chat._id ?? '');
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}/${messageId}`;
  return null;
}

export function displayName(user) {
  if (!user) return 'unknown user';
  const name = [user.first_name ?? user.firstName, user.last_name ?? user.lastName].filter(Boolean).join(' ');
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return `user ${user.id}`;
}

export function userMention(user) {
  if (!user?.id) return escapeHtml(displayName(user));
  return `<a href="tg://user?id=${user.id}">${escapeHtml(displayName(user))}</a>`;
}

export function linkOrText(url, text) {
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '?';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m ? `${m}m ${rem}s` : `${rem}s`;
}

export function formatPercent(score) {
  if (score == null || !Number.isFinite(score)) return '—';
  return `${Math.round(score * 100)}%`;
}
