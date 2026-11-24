import { safeCall } from '../telegram/safeCall.js';

const ADMIN_STATUSES = new Set(['creator', 'administrator']);

/**
 * Live membership check. Deliberately not cached: the plan requires permissions to be
 * re-checked on every privileged command and every approval button click.
 */
export async function getMemberStatus(telegram, chatId, userId) {
  try {
    const member = await safeCall(() => telegram.getChatMember(chatId, userId));
    return member?.status ?? null;
  } catch (err) {
    const code = err?.response?.error_code;
    if (code === 400 || code === 403) return null; // user/chat not found, bot kicked, etc.
    throw err;
  }
}

export async function isGroupAdmin(telegram, chatId, userId) {
  if (!userId) return false;
  return ADMIN_STATUSES.has(await getMemberStatus(telegram, chatId, userId));
}

/**
 * Is the sender of a group message a group admin?
 * Handles anonymous admins, whose messages are sent "as the group" (sender_chat === chat).
 */
export async function isMessageFromAdmin(telegram, message) {
  if (!message?.chat) return false;
  if (message.sender_chat && message.sender_chat.id === message.chat.id) return true;
  return isGroupAdmin(telegram, message.chat.id, message.from?.id);
}

/** Human administrators (incl. the owner) of a group. */
export async function listGroupAdmins(telegram, chatId) {
  const admins = await safeCall(() => telegram.getChatAdministrators(chatId));
  return admins.filter((m) => !m.user.is_bot && ADMIN_STATUSES.has(m.status));
}

/** What the bot itself is allowed to do in the group. */
export async function getBotPermissions(telegram, chatId, botId) {
  try {
    const member = await safeCall(() => telegram.getChatMember(chatId, botId));
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    return {
      isMember: member && !['left', 'kicked'].includes(member.status),
      isAdmin,
      canDelete: isAdmin && member.can_delete_messages !== false,
    };
  } catch (err) {
    const code = err?.response?.error_code;
    if (code === 400 || code === 403) return { isMember: false, isAdmin: false, canDelete: false };
    throw err;
  }
}
