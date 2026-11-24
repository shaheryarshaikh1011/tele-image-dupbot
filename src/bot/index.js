import { Telegraf } from 'telegraf';
import { getBotPermissions, isGroupAdmin, isMessageFromAdmin, listGroupAdmins } from '../services/admins.js';
import { parseApprovalCallback } from '../services/approvals.js';
import { AUDIT } from '../services/audit.js';
import { SETUP_STATUS } from '../services/groups.js';
import { extractVideo } from '../detection/detector.js';
import { escapeHtml } from '../telegram/format.js';
import { isMessageNotModified, safeCall } from '../telegram/safeCall.js';
import {
  auditText,
  helpText,
  parseSettingsCallback,
  parseSetupPayload,
  settingsKeyboard,
  settingsText,
  setupDeepLink,
  statsText,
  statusText,
  welcomeText,
} from './texts.js';

const GROUP_TYPES = new Set(['group', 'supergroup']);
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

export const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Start the bot / enable private notifications' },
  { command: 'help', description: 'Setup instructions and commands' },
];

export const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'enable', description: 'Start checking new videos for duplicates' },
  { command: 'disable', description: 'Pause duplicate checking' },
  { command: 'status', description: 'Show processing state and configuration' },
  { command: 'settings', description: 'Change sensitivity and notifications' },
  { command: 'stats', description: 'Detection and moderation statistics' },
  { command: 'audit', description: 'Recent moderation decisions' },
];

/**
 * Wire all Telegram update handlers.
 * @param {object} deps
 */
export function createBot({ token, telegrafOptions, services, config, logger }) {
  const { groups, users, approvals, audit, stats, detector, queue } = services;
  const bot = new Telegraf(token, telegrafOptions);
  const botUsername = () => bot.botInfo?.username ?? 'this_bot';
  const botId = () => bot.botInfo?.id;

  // ---------- helpers ----------

  async function ensureGroup(chat) {
    return (await groups.get(chat.id)) ?? groups.upsertFromChat(chat, { active: true });
  }

  /** Guard for group-admin commands. Returns the group record, or null after replying. */
  async function requireGroupAdmin(ctx) {
    const chat = ctx.chat;
    if (!chat || !GROUP_TYPES.has(chat.type)) {
      await ctx.reply('Please use this command inside the group you want to manage.');
      return null;
    }
    if (!(await isMessageFromAdmin(ctx.telegram, ctx.message))) {
      await ctx.reply('Only group admins can use this command.', { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } });
      return null;
    }
    return ensureGroup(chat);
  }

  const sensitivityThreshold = (group) => config.sensitivityPresets[group.settings.sensitivity] ?? config.sensitivityPresets.balanced;

  // ---------- membership / onboarding ----------

  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    const chat = upd.chat;
    if (!GROUP_TYPES.has(chat.type)) return; // groups only (not channels/private)
    const before = upd.old_chat_member.status;
    const after = upd.new_chat_member.status;
    const wasIn = !['left', 'kicked'].includes(before);
    const isIn = !['left', 'kicked'].includes(after);

    if (!isIn) {
      await groups.upsertFromChat(chat, { active: false, enabled: false, botIsAdmin: false, botCanDelete: false, removedAt: new Date() });
      await audit.record({ groupId: chat.id, type: AUDIT.groupRemoved, actorId: upd.from?.id });
      logger.info('bot removed from group', { groupId: chat.id });
      return;
    }

    const canDelete = after === 'administrator' && upd.new_chat_member.can_delete_messages !== false;
    const existing = await groups.get(chat.id);
    let setupStatus = existing?.setupStatus ?? SETUP_STATUS.needsAdminRights;
    if (canDelete && setupStatus === SETUP_STATUS.needsAdminRights) setupStatus = SETUP_STATUS.needsOwnerSetup;

    await groups.upsertFromChat(chat, {
      active: true,
      botIsAdmin: after === 'administrator',
      botCanDelete: canDelete,
      setupStatus,
      ...(wasIn ? {} : { addedBy: upd.from?.id ?? null, addedAt: new Date() }),
    });

    const button = { reply_markup: { inline_keyboard: [[{ text: '🔧 Finish setup privately', url: setupDeepLink(botUsername(), chat.id) }]] } };

    if (!wasIn) {
      await audit.record({ groupId: chat.id, type: AUDIT.groupAdded, actorId: upd.from?.id });
      logger.info('bot added to group', { groupId: chat.id, canDelete });
      await safeCall(() => ctx.telegram.sendMessage(chat.id, welcomeText({ botUsername: botUsername(), canDelete }), { ...HTML, ...button }));
    } else if (before !== 'administrator' && after === 'administrator') {
      const text = canDelete
        ? '✅ Thanks — I can now delete messages. An admin can finish setup privately, then send /enable.'
        : '⚠️ I am an admin now, but I still need the <i>Delete messages</i> permission.';
      await safeCall(() => ctx.telegram.sendMessage(chat.id, text, { ...HTML, ...(canDelete ? button : {}) }));
    } else if (before === 'administrator' && after !== 'administrator') {
      await safeCall(() =>
        ctx.telegram.sendMessage(chat.id, '⚠️ I am no longer an admin, so I cannot delete duplicates. Video checking keeps its current setting, but deletions will fail until I am promoted again.', HTML),
      );
    } else if (after === 'administrator' && existing?.botCanDelete && !canDelete) {
      await safeCall(() => ctx.telegram.sendMessage(chat.id, '⚠️ My <i>Delete messages</i> permission was removed. Approved deletions will fail until it is restored.', HTML));
    }
  });

  // Group upgraded to supergroup → chat id changes.
  bot.on('message', async (ctx, next) => {
    const to = ctx.message.migrate_to_chat_id;
    if (to) {
      await groups.migrate(ctx.chat.id, to);
      logger.info('group migrated', { from: ctx.chat.id, to });
      return undefined;
    }
    return next();
  });

  // ---------- public commands ----------

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(helpText(botUsername()), HTML);
      return;
    }
    await users.registerPrivateStart(ctx.from);
    const payload = (ctx.message.text.split(/\s+/)[1] ?? '').trim();
    const groupId = parseSetupPayload(payload);
    if (!groupId) {
      await ctx.reply(
        `✅ Private notifications are on. You will receive duplicate-review requests for groups where you are an admin.\n\n${helpText(botUsername())}`,
        HTML,
      );
      return;
    }

    const group = await groups.get(groupId);
    if (!group || group.active === false) {
      await ctx.reply('I am not in that group any more. Add me to the group again and use the setup button there.');
      return;
    }
    if (!(await isGroupAdmin(ctx.telegram, groupId, ctx.from.id))) {
      await ctx.reply(`Only admins of <b>${escapeHtml(group.title)}</b> can set me up there.`, HTML);
      return;
    }
    const perms = await getBotPermissions(ctx.telegram, groupId, botId());
    const setupStatus = perms.canDelete ? SETUP_STATUS.ready : SETUP_STATUS.needsAdminRights;
    const firstCompletion = group.setupStatus !== SETUP_STATUS.ready && setupStatus === SETUP_STATUS.ready;
    await groups.update(groupId, { setupStatus, botIsAdmin: perms.isAdmin, botCanDelete: perms.canDelete, setupBy: ctx.from.id, setupAt: new Date() });
    if (firstCompletion) await audit.record({ groupId, type: AUDIT.setupCompleted, actorId: ctx.from.id });

    const lines = [`🔧 <b>Setup for ${escapeHtml(group.title)}</b>`, '', '✅ You are a group admin — private review requests will come to this chat.'];
    lines.push(perms.canDelete ? '✅ I have permission to delete messages.' : '⚠️ I still need to be promoted to admin with the <i>Delete messages</i> permission.');
    lines.push(group.enabled ? '🟢 Video checking is already enabled.' : '➡️ Send /enable <b>in the group</b> to start checking new videos.');
    lines.push('', 'Other admins who want private requests should also open this chat and press Start.', 'Use /settings in the group to adjust sensitivity and notifications.');
    await ctx.reply(lines.join('\n'), HTML);
  });

  bot.help((ctx) => ctx.reply(helpText(botUsername()), HTML));

  // ---------- group admin commands ----------

  bot.command('enable', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    const perms = await getBotPermissions(ctx.telegram, ctx.chat.id, botId());
    if (!perms.canDelete) {
      await groups.update(ctx.chat.id, { botIsAdmin: perms.isAdmin, botCanDelete: false });
      await ctx.reply('I need to be an admin with the <i>Delete messages</i> permission before checking can be enabled.', HTML);
      return;
    }
    if (group.enabled) {
      await ctx.reply('🟢 Video checking is already enabled.');
      return;
    }
    await groups.update(ctx.chat.id, { botIsAdmin: true, botCanDelete: true, setupStatus: SETUP_STATUS.ready });
    await groups.setEnabled(ctx.chat.id, true, ctx.from?.id);
    await audit.record({ groupId: ctx.chat.id, type: AUDIT.processingEnabled, actorId: ctx.from?.id });
    const reachable = await users.filterReachable((await listGroupAdmins(ctx.telegram, ctx.chat.id)).map((m) => m.user.id));
    const lines = ['🟢 <b>Video checking enabled.</b> New videos will be compared with earlier ones in this group.'];
    if (!reachable.length) {
      lines.push('', `ℹ️ No admin has started me privately yet, so review requests will only appear here. Admins can open @${escapeHtml(botUsername())} and press Start to get them privately.`);
    }
    await ctx.reply(lines.join('\n'), HTML);
  });

  bot.command('disable', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    if (!group.enabled) {
      await ctx.reply('⚪️ Video checking is already disabled.');
      return;
    }
    await groups.setEnabled(ctx.chat.id, false, ctx.from?.id);
    await audit.record({ groupId: ctx.chat.id, type: AUDIT.processingDisabled, actorId: ctx.from?.id });
    await ctx.reply('⚪️ <b>Video checking paused.</b> New videos are ignored (not queued for later). Pending reviews can still be decided until they expire.', HTML);
  });

  bot.command('status', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    const perms = await getBotPermissions(ctx.telegram, ctx.chat.id, botId());
    const admins = await listGroupAdmins(ctx.telegram, ctx.chat.id);
    const reachable = await users.filterReachable(admins.map((m) => m.user.id));
    const pending = await approvals.pendingCount(ctx.chat.id);
    await ctx.reply(
      statusText({ group, perms, pending, reachableAdmins: reachable.length, totalAdmins: admins.length, threshold: sensitivityThreshold(group) }),
      HTML,
    );
  });

  bot.command('stats', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    await ctx.reply(statsText(group, await stats.forGroup(ctx.chat.id)), HTML);
  });

  bot.command('audit', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    await ctx.reply(auditText(await audit.recent(ctx.chat.id, 15)), HTML);
  });

  bot.command('settings', async (ctx) => {
    const group = await requireGroupAdmin(ctx);
    if (!group) return;
    await ctx.reply(settingsText(group), { ...HTML, reply_markup: settingsKeyboard(group) });
  });

  // ---------- callbacks ----------

  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;

    const approval = parseApprovalCallback(data);
    if (approval) {
      const result = await approvals.decide({ ...approval, user: ctx.from });
      await ctx.answerCbQuery(result.message, { show_alert: !result.ok });
      return;
    }

    const setting = parseSettingsCallback(data);
    const chat = ctx.callbackQuery.message?.chat;
    if (setting && chat && GROUP_TYPES.has(chat.type)) {
      if (!(await isGroupAdmin(ctx.telegram, chat.id, ctx.from.id))) {
        await ctx.answerCbQuery('Only group admins can change settings.', { show_alert: true });
        return;
      }
      if (setting.key === 'close') {
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        return;
      }
      let group = await ensureGroup(chat);
      const next = { ...group.settings, [setting.key]: setting.value };
      if (!next.groupNotices && !next.privateNotices) {
        await ctx.answerCbQuery('At least one notification channel must stay on, or nobody could review duplicates.', { show_alert: true });
        return;
      }
      if (group.settings[setting.key] !== setting.value) {
        group = await groups.updateSetting(chat.id, setting.key, setting.value);
        await audit.record({ groupId: chat.id, type: AUDIT.settingChanged, actorId: ctx.from.id, details: { key: setting.key, value: setting.value } });
      }
      await ctx.answerCbQuery('Saved.');
      await ctx.editMessageText(settingsText(group), { ...HTML, reply_markup: settingsKeyboard(group) }).catch((err) => {
        if (!isMessageNotModified(err)) throw err;
      });
      return;
    }

    await ctx.answerCbQuery('This button is no longer valid.');
  });

  // ---------- videos ----------

  bot.on('message', async (ctx) => {
    const message = ctx.message;
    if (!GROUP_TYPES.has(ctx.chat.type)) return;
    const video = extractVideo(message);
    if (!video) return;
    if (message.from?.id === botId()) return;

    const group = await ensureGroup(ctx.chat);
    // Disabled: ignore entirely — no analysis and no backlog (plan §5).
    if (!group.enabled || group.active === false) return;

    const result = await detector.handleNewVideo({ group, message, video, enqueue: queue.enqueue });
    logger.debug('video handled', { groupId: group._id, messageId: message.message_id, outcome: result.outcome });
  });

  bot.catch((err, ctx) => {
    logger.error('update handler failed', { err, updateId: ctx.update?.update_id, updateType: ctx.updateType });
  });

  return bot;
}

/** Register the command menus shown in Telegram clients. */
export async function registerCommands(telegram) {
  await telegram.setMyCommands(PUBLIC_COMMANDS, { scope: { type: 'default' } });
  await telegram.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'all_chat_administrators' } });
}
