import { escapeHtml, formatPercent } from '../telegram/format.js';
import { SETUP_STATUS } from '../services/groups.js';

export const SENSITIVITY_LABELS = { strict: 'Strict', balanced: 'Balanced', lenient: 'Lenient' };

export function setupDeepLink(botUsername, groupId) {
  return `https://t.me/${botUsername}?start=setup_${Math.abs(groupId)}`;
}

/** "setup_1001234567890" → -1001234567890. Returns null if malformed. */
export function parseSetupPayload(payload) {
  const m = /^setup_(\d{1,20})$/.exec(payload ?? '');
  return m ? -Number(m[1]) : null;
}

export function helpText(botUsername) {
  return [
    '<b>Anti-Duplicate Bot</b> spots re-posted videos in your group and asks admins whether to delete them. Nothing is ever deleted automatically.',
    '',
    '<b>Setup</b>',
    `1. Add @${escapeHtml(botUsername)} to your group.`,
    '2. Promote it to admin with the <i>Delete messages</i> permission.',
    `3. Open a private chat with @${escapeHtml(botUsername)} and press <b>Start</b> (every admin who wants private approval requests should do this).`,
    '4. Send /enable in the group.',
    '',
    '<b>Group admin commands</b>',
    '/enable — start checking newly posted videos',
    '/disable — pause checking (commands and pending decisions keep working)',
    '/status — current state and configuration',
    '/settings — sensitivity and notification options',
    '/stats — detection and moderation statistics',
    '/audit — recent moderation decisions',
    '',
    '<b>How decisions work</b>',
    '• Suspected duplicates get a notice in the group and a private message to admins who started the bot.',
    '• The first admin to press <b>Delete</b> or <b>Keep</b> decides. Only the new copy can be deleted — the earlier post is never touched.',
    '• If nobody decides within 5 hours, the video is kept.',
    '',
    '<i>Currently checks videos only. Each group’s settings and history are kept separate.</i>',
  ].join('\n');
}

export function welcomeText({ botUsername, canDelete }) {
  const lines = ['👋 <b>Thanks for adding me!</b> I look for duplicate videos and let admins decide what to delete.', ''];
  if (!canDelete) {
    lines.push('➡️ <b>Step 1:</b> promote me to admin with the <i>Delete messages</i> permission.');
    lines.push('➡️ <b>Step 2:</b> tap the button below to finish setup in a private chat.');
  } else {
    lines.push('✅ I already have permission to delete messages.');
    lines.push('➡️ Tap the button below to finish setup in a private chat.');
  }
  lines.push('');
  lines.push('Video checking stays <b>off</b> until an admin sends /enable here.');
  lines.push(`See /help@${escapeHtml(botUsername)} for all commands.`);
  return lines.join('\n');
}

const SETUP_LABELS = {
  [SETUP_STATUS.needsAdminRights]: 'waiting for the bot to be made admin',
  [SETUP_STATUS.needsOwnerSetup]: 'waiting for an admin to finish private setup',
  [SETUP_STATUS.ready]: 'complete',
};

export function statusText({ group, perms, pending, reachableAdmins, totalAdmins, threshold }) {
  const s = group.settings;
  return [
    `<b>Status for ${escapeHtml(group.title ?? 'this group')}</b>`,
    '',
    `Video checking: ${group.enabled ? '🟢 <b>enabled</b>' : '⚪️ <b>disabled</b>'}`,
    `Setup: ${SETUP_LABELS[group.setupStatus] ?? group.setupStatus}`,
    `Bot can delete messages: ${perms.canDelete ? 'yes' : '<b>no</b> — please grant the permission'}`,
    `Pending reviews: ${pending}`,
    `Admins receiving private requests: ${reachableAdmins}/${totalAdmins}`,
    '',
    '<b>Settings</b>',
    `Sensitivity: ${SENSITIVITY_LABELS[s.sensitivity] ?? s.sensitivity} (≥${formatPercent(threshold)} of frames must match)`,
    `Group notices: ${s.groupNotices ? 'on' : 'off'}`,
    `Private admin requests: ${s.privateNotices ? 'on' : 'off'}`,
  ].join('\n');
}

export function settingsText(group) {
  const s = group.settings;
  return [
    `<b>Settings for ${escapeHtml(group.title ?? 'this group')}</b>`,
    '',
    `<b>Sensitivity:</b> ${SENSITIVITY_LABELS[s.sensitivity]}`,
    '<i>Strict flags only near-identical copies; Lenient also flags heavily edited ones (more false alarms). Admins always decide.</i>',
    '',
    `<b>Group notices:</b> ${s.groupNotices ? 'on' : 'off'} — post a review notice in the group`,
    `<b>Private requests:</b> ${s.privateNotices ? 'on' : 'off'} — DM admins who started the bot`,
    '',
    'Tap a button to change a setting.',
  ].join('\n');
}

export function settingsKeyboard(group) {
  const s = group.settings;
  const sens = (key) => ({ text: `${s.sensitivity === key ? '● ' : ''}${SENSITIVITY_LABELS[key]}`, callback_data: `st:sensitivity:${key}` });
  return {
    inline_keyboard: [
      [sens('strict'), sens('balanced'), sens('lenient')],
      [{ text: `Group notices: ${s.groupNotices ? 'ON' : 'OFF'}`, callback_data: `st:groupNotices:${s.groupNotices ? 'off' : 'on'}` }],
      [{ text: `Private requests: ${s.privateNotices ? 'ON' : 'OFF'}`, callback_data: `st:privateNotices:${s.privateNotices ? 'off' : 'on'}` }],
      [{ text: 'Done', callback_data: 'st:close:x' }],
    ],
  };
}

export function parseSettingsCallback(data) {
  const m = /^st:(sensitivity|groupNotices|privateNotices|close):(strict|balanced|lenient|on|off|x)$/.exec(data ?? '');
  if (!m) return null;
  const [, key, raw] = m;
  if (key === 'close') return { key };
  if (key === 'sensitivity') return ['strict', 'balanced', 'lenient'].includes(raw) ? { key, value: raw } : null;
  if (raw !== 'on' && raw !== 'off') return null;
  return { key, value: raw === 'on' };
}

const AUDIT_LABELS = {
  group_added: '➕ bot added',
  group_removed: '➖ bot removed',
  setup_completed: '🛠 setup completed',
  processing_enabled: '🟢 checking enabled',
  processing_disabled: '⚪️ checking disabled',
  setting_changed: '⚙️ setting changed',
  duplicate_detected: '⚠️ duplicate suspected',
  decision_delete: '🗑 delete chosen',
  decision_keep: '✅ keep chosen',
  deletion_result: '📬 deletion result',
  request_expired: '⌛ request expired (kept)',
  analysis_failed: '❗️ analysis failed',
};

export function auditText(entries) {
  if (!entries.length) return 'No moderation events recorded yet.';
  const lines = ['<b>Recent moderation events</b>', ''];
  for (const e of entries) {
    const when = new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 16);
    const parts = [`<code>${when}</code> ${AUDIT_LABELS[e.type] ?? escapeHtml(e.type)}`];
    if (e.duplicateMessageId) parts.push(`msg #${e.duplicateMessageId}`);
    if (e.originalMessageId && e.originalMessageId > 0) parts.push(`(orig #${e.originalMessageId})`);
    if (e.score != null && e.type === 'duplicate_detected') parts.push(`${formatPercent(e.score)} via ${e.detectionMethod === 'exact_file_id' ? 'exact file' : 'visual match'}`);
    if (e.deletionResult) parts.push(e.deletionResult.ok ? 'deleted ✓' : `failed: ${escapeHtml(e.deletionResult.error ?? '?')}`);
    if (e.type === 'setting_changed' && e.details) parts.push(escapeHtml(`${e.details.key} → ${e.details.value}`));
    if (e.actorId) parts.push(`by <a href="tg://user?id=${e.actorId}">${e.actorId}</a>`);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

export function statsText(group, s) {
  return [
    `<b>Statistics for ${escapeHtml(group.title ?? 'this group')}</b>`,
    '',
    `Videos tracked: ${s.videosTracked}`,
    `Videos analysed (smart fingerprint): ${s.videosFingerprinted}`,
    `Duplicates suspected: ${s.detected} (exact file: ${s.exact}, visual match: ${s.visual})`,
    '',
    `Deleted by admins: ${s.deleted}`,
    `Kept by admins: ${s.kept}`,
    `Expired (kept, no response): ${s.expired}`,
    `Pending review: ${s.pending}`,
    s.deleteFailures ? `Deletions Telegram refused: ${s.deleteFailures}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}
