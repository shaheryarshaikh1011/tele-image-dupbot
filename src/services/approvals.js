import crypto from 'node:crypto';
import { isDuplicateKeyError } from '../db.js';
import { escapeHtml, formatPercent, linkOrText, messageLink, userMention } from '../telegram/format.js';
import { isForbiddenError, isMessageNotModified, safeCall, telegramErrorDescription } from '../telegram/safeCall.js';
import { isGroupAdmin, listGroupAdmins } from './admins.js';
import { AUDIT } from './audit.js';

export const APPROVAL_STATUS = Object.freeze({ pending: 'pending', resolved: 'resolved', expired: 'expired' });
export const DECISION = Object.freeze({ delete: 'delete', keep: 'keep' });
export const DETECTION_METHOD = Object.freeze({ exact: 'exact_file_id', visual: 'visual_similarity' });

const CALLBACK_PREFIX = 'ap';
const DECISION_CODES = { del: DECISION.delete, keep: DECISION.keep };

export function approvalCallbackData(id, decision) {
  return `${CALLBACK_PREFIX}:${id}:${decision === DECISION.delete ? 'del' : 'keep'}`;
}

/** Parse "ap:<id>:<del|keep>". Returns null for anything malformed (forged/stale data). */
export function parseApprovalCallback(data) {
  const match = /^ap:([A-Za-z0-9_-]{8,32}):(del|keep)$/.exec(data ?? '');
  if (!match) return null;
  return { approvalId: match[1], decision: DECISION_CODES[match[2]] };
}

function approvalKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '🗑 Delete duplicate', callback_data: approvalCallbackData(id, DECISION.delete) },
        { text: '✅ Keep', callback_data: approvalCallbackData(id, DECISION.keep) },
      ],
    ],
  };
}

function methodLabel(method) {
  return method === DETECTION_METHOD.exact ? 'identical Telegram file' : 'visually similar video';
}

/** Text shown in group notices and private approval requests. */
export function renderApprovalText(req, { includeGroup = false } = {}) {
  const chat = { id: req.groupId, username: req.groupUsername };
  const dupLink = messageLink(chat, req.duplicateMessageId);
  const origLink = req.originalMessageId > 0 ? messageLink(chat, req.originalMessageId) : null;
  const lines = [];

  if (req.status === APPROVAL_STATUS.pending) lines.push('⚠️ <b>Possible duplicate video</b>');
  else if (req.status === APPROVAL_STATUS.expired) lines.push('⌛ <b>Duplicate review expired</b>');
  else lines.push('☑️ <b>Duplicate review resolved</b>');

  if (includeGroup) lines.push(`Group: <b>${escapeHtml(req.groupTitle ?? String(req.groupId))}</b>`);
  lines.push(`Posted by: ${userMention({ id: req.uploaderId, first_name: req.uploaderName })}`);
  lines.push(`Suspected copy: ${linkOrText(dupLink, `message #${req.duplicateMessageId}`)}`);
  lines.push(
    `Earlier post: ${req.originalMessageId > 0 ? linkOrText(origLink, `message #${req.originalMessageId}`) : 'from before a group upgrade'}`,
  );
  lines.push(`Detection: ${methodLabel(req.detectionMethod)} · similarity ${formatPercent(req.score)}`);

  if (req.status === APPROVAL_STATUS.pending) {
    const hours = Math.max(0, (new Date(req.expiresAt).getTime() - Date.now()) / 3_600_000);
    lines.push('');
    lines.push(`An admin can delete the suspected copy or keep it. The earlier post is never touched.`);
    lines.push(`<i>If nobody decides within ${hours >= 1 ? `${Math.round(hours)}h` : `${Math.ceil(hours * 60)}m`}, the video is kept.</i>`);
  } else if (req.status === APPROVAL_STATUS.expired) {
    lines.push('');
    lines.push('No admin decided in time, so the video was <b>kept</b>.');
  } else {
    lines.push('');
    const who = userMention({ id: req.decidedBy, first_name: req.decidedByName });
    if (req.decision === DECISION.keep) {
      lines.push(`Decision: <b>kept</b> by ${who}.`);
    } else if (req.deletionResult?.ok) {
      lines.push(`Decision: <b>deleted</b> by ${who}.`);
    } else {
      lines.push(`Decision: delete by ${who}, but Telegram refused: <code>${escapeHtml(req.deletionResult?.error ?? 'unknown error')}</code>`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {*} deps.cols
 * @param {*} deps.telegram Telegraf `Telegram` instance (or test double)
 * @param {*} deps.config
 * @param {*} deps.logger
 * @param {ReturnType<import('./audit.js').createAuditService>} deps.audit
 * @param {ReturnType<import('./users.js').createUserService>} deps.users
 * @param {ReturnType<import('./fingerprints.js').createFingerprintService>} deps.fingerprints
 * @param {(fn: () => Promise<any>) => Promise<any>} [deps.throttle]
 */
export function createApprovalService({ cols, telegram, config, logger, audit, users, fingerprints, throttle = (fn) => fn() }) {
  const retentionMs = config.recordRetentionDays * 86_400_000;
  const send = (fn) => throttle(() => safeCall(fn));

  async function refreshNotifications(req) {
    const text = (n) => renderApprovalText(req, { includeGroup: n.kind === 'private' });
    for (const n of req.notifications ?? []) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await send(() =>
          telegram.editMessageText(n.chatId, n.messageId, undefined, text(n), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [] },
          }),
        );
      } catch (err) {
        if (!isMessageNotModified(err)) logger.warn('could not update approval message', { err, approvalId: req._id, chatId: n.chatId });
      }
    }
  }

  async function notify(req, group) {
    const settings = group.settings;
    // At least one channel must exist, otherwise nobody could ever decide.
    const groupNotices = settings.groupNotices || !settings.privateNotices;
    const notifications = [];

    if (groupNotices) {
      try {
        const msg = await send(() =>
          telegram.sendMessage(req.groupId, renderApprovalText(req), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: req.duplicateMessageId, allow_sending_without_reply: true },
            reply_markup: approvalKeyboard(req._id),
          }),
        );
        notifications.push({ kind: 'group', chatId: req.groupId, messageId: msg.message_id });
      } catch (err) {
        logger.warn('group notice failed', { err, groupId: req.groupId });
      }
    }

    const recipients = [];
    if (settings.privateNotices) {
      let adminIds = [];
      try {
        adminIds = (await listGroupAdmins(telegram, req.groupId)).map((m) => m.user.id);
      } catch (err) {
        logger.warn('could not list group admins', { err, groupId: req.groupId });
      }
      const reachable = await users.filterReachable(adminIds);
      for (const userId of reachable) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const msg = await send(() =>
            telegram.sendMessage(userId, renderApprovalText(req, { includeGroup: true }), {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: approvalKeyboard(req._id),
            }),
          );
          recipients.push(userId);
          notifications.push({ kind: 'private', chatId: userId, messageId: msg.message_id });
        } catch (err) {
          if (isForbiddenError(err)) await users.markUnreachable(userId);
          else logger.warn('private approval request failed', { err, userId, approvalId: req._id });
        }
      }
    }

    await cols.approvals.updateOne({ _id: req._id }, { $set: { recipients, notifications } });
    if (!notifications.length) logger.warn('approval request has no delivered notifications', { approvalId: req._id });
    return { ...req, recipients, notifications };
  }

  async function finalize(req, statusLabel) {
    await cols.approvals.updateOne({ _id: req._id }, { $set: { purgeAt: new Date(Date.now() + retentionMs) } });
    await refreshNotifications(req);
    logger.info(`approval ${statusLabel}`, { approvalId: req._id, groupId: req.groupId, decision: req.decision ?? null });
  }

  async function expireOne(id) {
    const now = new Date();
    const expired = await cols.approvals.findOneAndUpdate(
      { _id: id, status: APPROVAL_STATUS.pending, expiresAt: { $lte: now } },
      { $set: { status: APPROVAL_STATUS.expired, resolvedAt: now } },
      { returnDocument: 'after' },
    );
    if (!expired) return null;
    await audit.record({
      groupId: expired.groupId,
      type: AUDIT.requestExpired,
      approvalId: expired._id,
      originalMessageId: expired.originalMessageId,
      duplicateMessageId: expired.duplicateMessageId,
      uploaderId: expired.uploaderId,
      detectionMethod: expired.detectionMethod,
      score: expired.score,
      action: 'kept_no_response',
    });
    await finalize(expired, 'expired');
    return expired;
  }

  return {
    /**
     * Open an approval request for a suspected duplicate and notify admins.
     * Returns null if a request for this message already exists (e.g. a redelivered update).
     */
    async create({ group, original, duplicate, detectionMethod, score, details }) {
      const now = new Date();
      const req = {
        _id: crypto.randomBytes(9).toString('base64url'),
        groupId: group._id,
        groupTitle: group.title ?? null,
        groupUsername: group.username ?? null,
        originalMessageId: original.messageId,
        duplicateMessageId: duplicate.messageId,
        uploaderId: duplicate.uploaderId ?? null,
        uploaderName: duplicate.uploaderName ?? null,
        detectionMethod,
        score,
        details: details ?? null,
        status: APPROVAL_STATUS.pending,
        decision: null,
        decidedBy: null,
        decidedAt: null,
        deletionResult: null,
        recipients: [],
        notifications: [],
        createdAt: now,
        expiresAt: new Date(now.getTime() + config.approvalTtlMs),
        purgeAt: null,
      };
      try {
        await cols.approvals.insertOne(req);
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
      await audit.record({
        groupId: req.groupId,
        type: AUDIT.duplicateDetected,
        approvalId: req._id,
        originalMessageId: req.originalMessageId,
        duplicateMessageId: req.duplicateMessageId,
        uploaderId: req.uploaderId,
        detectionMethod,
        score,
        action: 'approval_requested',
        details,
      });
      return notify(req, group);
    },

    /**
     * Apply an admin's button click. First valid decision wins; permissions are re-checked live.
     * @returns {Promise<{ ok: boolean, message: string }>} message is shown as the callback answer
     */
    async decide({ approvalId, decision, user }) {
      const req = await cols.approvals.findOne({ _id: approvalId });
      if (!req) return { ok: false, message: 'This request no longer exists.' };
      if (req.status === APPROVAL_STATUS.expired) return { ok: false, message: 'This request has expired; the video was kept.' };
      if (req.status === APPROVAL_STATUS.resolved) return { ok: false, message: 'Already resolved by another admin.' };
      if (new Date(req.expiresAt).getTime() <= Date.now()) {
        await expireOne(approvalId);
        return { ok: false, message: 'This request has expired; the video was kept.' };
      }

      if (!(await isGroupAdmin(telegram, req.groupId, user.id))) {
        logger.warn('non-admin approval attempt', { approvalId, userId: user.id, groupId: req.groupId });
        return { ok: false, message: 'Only current admins of this group can decide.' };
      }

      const now = new Date();
      const resolved = await cols.approvals.findOneAndUpdate(
        { _id: approvalId, status: APPROVAL_STATUS.pending, expiresAt: { $gt: now } },
        {
          $set: {
            status: APPROVAL_STATUS.resolved,
            decision,
            decidedBy: user.id,
            decidedByName: user.first_name ?? user.username ?? null,
            decidedAt: now,
            resolvedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (!resolved) return { ok: false, message: 'Already resolved by another admin.' };

      await audit.record({
        groupId: resolved.groupId,
        type: decision === DECISION.delete ? AUDIT.decisionDelete : AUDIT.decisionKeep,
        actorId: user.id,
        approvalId,
        originalMessageId: resolved.originalMessageId,
        duplicateMessageId: resolved.duplicateMessageId,
        uploaderId: resolved.uploaderId,
        detectionMethod: resolved.detectionMethod,
        score: resolved.score,
        action: decision,
      });

      let final = resolved;
      if (decision === DECISION.delete) {
        // Only ever the suspected duplicate — never the original message.
        let deletionResult;
        try {
          await safeCall(() => telegram.deleteMessage(resolved.groupId, resolved.duplicateMessageId));
          deletionResult = { ok: true, error: null, at: new Date() };
        } catch (err) {
          deletionResult = { ok: false, error: telegramErrorDescription(err), at: new Date() };
        }
        const gone = deletionResult.ok || /message to delete not found/i.test(deletionResult.error ?? '');
        if (gone) await fingerprints.markDeleted(resolved.groupId, resolved.duplicateMessageId);
        await cols.approvals.updateOne({ _id: approvalId }, { $set: { deletionResult } });
        await audit.record({
          groupId: resolved.groupId,
          type: AUDIT.deletionResult,
          actorId: user.id,
          approvalId,
          originalMessageId: resolved.originalMessageId,
          duplicateMessageId: resolved.duplicateMessageId,
          uploaderId: resolved.uploaderId,
          detectionMethod: resolved.detectionMethod,
          score: resolved.score,
          action: 'delete',
          deletionResult,
        });
        final = { ...resolved, deletionResult };
      }

      await finalize(final, 'resolved');
      if (decision === DECISION.keep) return { ok: true, message: 'Kept. Thanks!' };
      return final.deletionResult.ok
        ? { ok: true, message: 'Duplicate deleted.' }
        : { ok: false, message: `Telegram could not delete it: ${final.deletionResult.error}`.slice(0, 190) };
    },

    expireOne,

    /** Expire every overdue pending request (no response → keep the video). */
    async expireDue({ batchSize = 50 } = {}) {
      const due = await cols.approvals
        .find({ status: APPROVAL_STATUS.pending, expiresAt: { $lte: new Date() } })
        .sort({ expiresAt: 1 })
        .limit(batchSize)
        .toArray();
      let count = 0;
      for (const req of due) {
        // eslint-disable-next-line no-await-in-loop
        if (await expireOne(req._id)) count += 1;
      }
      return count;
    },

    pendingCount(groupId) {
      return cols.approvals.countDocuments({ groupId, status: APPROVAL_STATUS.pending });
    },
  };
}
