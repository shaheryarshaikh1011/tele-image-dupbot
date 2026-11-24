import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { approvalCallbackData, parseApprovalCallback } from '../src/services/approvals.js';
import { ADMIN, createHarness, GROUP, MEMBER, OWNER } from './helpers/harness.js';

const OTHER_GROUP = { id: -1009999999999, type: 'supergroup', title: 'Other Group' };

describe('approval workflow (exact duplicates)', () => {
  let h;
  beforeEach(async () => {
    h = await createHarness();
    await h.setupEnabledGroup();
  });
  afterEach(() => h.close());

  async function postExactDuplicate() {
    const original = await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    const duplicate = await h.postVideo(MEMBER, { fileId: 'a2', fileUniqueId: 'same' });
    return { original, duplicate };
  }

  test('first upload is just recorded; nothing is downloaded or flagged', async () => {
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    assert.equal(await h.cols.fingerprints.countDocuments({}), 1);
    assert.equal(await h.cols.approvals.countDocuments({}), 0);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.api.callsTo('sendMessage').length, 0);
  });

  test('exact re-upload creates a request, a group notice and private requests — without downloading', async () => {
    const { original, duplicate } = await postExactDuplicate();
    const req = await h.lastApproval();
    assert.equal(req.status, 'pending');
    assert.equal(req.detectionMethod, 'exact_file_id');
    assert.equal(req.originalMessageId, original);
    assert.equal(req.duplicateMessageId, duplicate);
    assert.equal(req.score, 1);
    assert.equal(h.downloads.length, 0, 'exact matches need no download');

    const sent = h.api.callsTo('sendMessage');
    const groupNotice = sent.find((m) => m.chat_id === GROUP.id);
    assert.ok(groupNotice, 'group notice posted');
    assert.equal(groupNotice.reply_parameters.message_id, duplicate);
    const dms = sent.filter((m) => m.chat_id > 0).map((m) => m.chat_id).sort();
    assert.deepEqual(dms, [OWNER.id, ADMIN.id].sort(), 'owner and admin who started the bot get DMs');
    for (const m of sent) {
      const buttons = m.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
      assert.deepEqual(buttons, [approvalCallbackData(req._id, 'delete'), approvalCallbackData(req._id, 'keep')]);
    }
    const ttl = new Date(req.expiresAt) - new Date(req.createdAt);
    assert.equal(ttl, 5 * 3_600_000, 'five hour expiry');
  });

  test('admins who never started the bot privately are not messaged', async () => {
    await h.cols.users.updateOne({ _id: ADMIN.id }, { $set: { privateChatOpen: false } });
    await postExactDuplicate();
    const dms = h.api.callsTo('sendMessage').filter((m) => m.chat_id > 0).map((m) => m.chat_id);
    assert.deepEqual(dms, [OWNER.id]);
  });

  test('a user who blocked the bot is marked unreachable', async () => {
    h.api.failWhen('sendMessage', (p) => p.chat_id === OWNER.id, 403, 'Forbidden: bot was blocked by the user');
    await postExactDuplicate();
    const owner = await h.cols.users.findOne({ _id: OWNER.id });
    assert.equal(owner.privateChatOpen, false);
    const req = await h.lastApproval();
    assert.deepEqual(req.recipients, [ADMIN.id]);
  });

  test('non-admin clicks are rejected and nothing is deleted', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await h.click(MEMBER, approvalCallbackData(req._id, 'delete'));
    const answer = h.api.callsTo('answerCallbackQuery').at(-1);
    assert.match(answer.text, /Only current admins/);
    assert.equal(answer.show_alert, true);
    assert.equal(h.api.state.deleted.length, 0);
    assert.equal((await h.lastApproval()).status, 'pending');
  });

  test('admin Delete removes only the duplicate, updates every notice, and is audited', async () => {
    const { original, duplicate } = await postExactDuplicate();
    const req = await h.lastApproval();
    await h.click(ADMIN, approvalCallbackData(req._id, 'delete'));

    assert.deepEqual(h.api.state.deleted, [{ chatId: GROUP.id, messageId: duplicate }]);
    assert.ok(!h.api.state.deleted.some((d) => d.messageId === original), 'original never deleted');

    const after = await h.lastApproval();
    assert.equal(after.status, 'resolved');
    assert.equal(after.decision, 'delete');
    assert.equal(after.decidedBy, ADMIN.id);
    assert.equal(after.deletionResult.ok, true);
    assert.ok(after.purgeAt, 'resolved requests get a purge date');

    const edits = h.api.callsTo('editMessageText');
    assert.equal(edits.length, after.notifications.length, 'every notification updated');
    for (const e of edits) {
      assert.deepEqual(e.reply_markup.inline_keyboard, [], 'buttons removed');
      assert.match(e.text, /deleted/);
    }

    const fp = await h.cols.fingerprints.findOne({ messageId: duplicate });
    assert.equal(fp.deleted, true, 'deleted copies are excluded from future matching');

    const types = (await h.cols.audit.find({ groupId: GROUP.id }).toArray()).map((a) => a.type);
    for (const t of ['duplicate_detected', 'decision_delete', 'deletion_result']) assert.ok(types.includes(t), t);
    const del = await h.cols.audit.findOne({ type: 'deletion_result' });
    assert.equal(del.actorId, ADMIN.id);
    assert.equal(del.originalMessageId, original);
    assert.equal(del.duplicateMessageId, duplicate);
    assert.equal(del.uploaderId, MEMBER.id);
    assert.equal(del.detectionMethod, 'exact_file_id');
  });

  test('first decision wins; later clicks are rejected', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await h.click(OWNER, approvalCallbackData(req._id, 'keep'));
    await h.click(ADMIN, approvalCallbackData(req._id, 'delete'));
    const answers = h.api.callsTo('answerCallbackQuery');
    assert.match(answers.at(-1).text, /Already resolved/);
    assert.equal(h.api.state.deleted.length, 0);
    const after = await h.lastApproval();
    assert.equal(after.decision, 'keep');
    assert.equal(after.decidedBy, OWNER.id);
  });

  test('concurrent clicks from two admins: exactly one decision applies', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await Promise.all([
      h.click(OWNER, approvalCallbackData(req._id, 'delete')),
      h.click(ADMIN, approvalCallbackData(req._id, 'delete')),
      h.click(ADMIN, approvalCallbackData(req._id, 'keep')),
    ]);
    assert.ok(h.api.state.deleted.length <= 1, 'never deleted twice');
    const decisions = await h.cols.audit.countDocuments({ type: { $in: ['decision_delete', 'decision_keep'] } });
    assert.equal(decisions, 1);
  });

  test('an admin who lost admin rights cannot decide', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    h.api.setMember(GROUP.id, ADMIN, 'member');
    await h.click(ADMIN, approvalCallbackData(req._id, 'delete'));
    assert.equal(h.api.state.deleted.length, 0);
    assert.equal((await h.lastApproval()).status, 'pending');
  });

  test('Telegram deletion failure is recorded', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    h.api.failNext('deleteMessage', 400, "Bad Request: message can't be deleted");
    await h.click(OWNER, approvalCallbackData(req._id, 'delete'));
    const after = await h.lastApproval();
    assert.equal(after.deletionResult.ok, false);
    assert.match(after.deletionResult.error, /can't be deleted/);
    const audit = await h.cols.audit.findOne({ type: 'deletion_result' });
    assert.equal(audit.deletionResult.ok, false);
    assert.match(h.api.callsTo('answerCallbackQuery').at(-1).text, /could not delete/);
  });

  test('no response within the expiry window keeps the video', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await h.cols.approvals.updateOne({ _id: req._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await h.app.services.approvals.expireDue();
    assert.equal(expired, 1);
    const after = await h.lastApproval();
    assert.equal(after.status, 'expired');
    assert.equal(h.api.state.deleted.length, 0);
    assert.ok(await h.cols.audit.findOne({ type: 'request_expired', action: 'kept_no_response' }));
    for (const e of h.api.callsTo('editMessageText')) assert.match(e.text, /kept/);

    await h.click(OWNER, approvalCallbackData(req._id, 'delete'));
    assert.match(h.api.callsTo('answerCallbackQuery').at(-1).text, /expired/);
    assert.equal(h.api.state.deleted.length, 0);
  });

  test('a click after expiry but before the sweep also expires (never deletes)', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await h.cols.approvals.updateOne({ _id: req._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await h.click(OWNER, approvalCallbackData(req._id, 'delete'));
    assert.equal((await h.lastApproval()).status, 'expired');
    assert.equal(h.api.state.deleted.length, 0);
  });

  test('redelivered update does not create a second request', async () => {
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    const dupId = h.nextMessageId();
    const update = { message: { message_id: dupId, date: 1, chat: GROUP, from: MEMBER, video: { file_id: 'a2', file_unique_id: 'same', duration: 6 } } };
    await h.send(update);
    await h.send(update);
    assert.equal(await h.cols.approvals.countDocuments({}), 1);
  });

  test('forged or malformed callback data is rejected', async () => {
    assert.equal(parseApprovalCallback('ap:../../x:del'), null);
    assert.equal(parseApprovalCallback('ap:abcdefgh:nuke'), null);
    assert.deepEqual(parseApprovalCallback('ap:abcdefghij:keep'), { approvalId: 'abcdefghij', decision: 'keep' });
    await h.click(ADMIN, 'ap:doesnotexist1:del');
    assert.match(h.api.callsTo('answerCallbackQuery').at(-1).text, /no longer exists/);
    await h.click(ADMIN, 'garbage');
    assert.match(h.api.callsTo('answerCallbackQuery').at(-1).text, /no longer valid/);
  });

  test('pending requests stay actionable after /disable', async () => {
    await postExactDuplicate();
    const req = await h.lastApproval();
    await h.groupCommand(OWNER, '/disable');
    await h.click(ADMIN, approvalCallbackData(req._id, 'delete'));
    assert.equal(h.api.state.deleted.length, 1);
  });
});

describe('group isolation and enable/disable', () => {
  let h;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  test('videos are ignored while a group is disabled (not queued for later)', async () => {
    await h.setupEnabledGroup();
    await h.groupCommand(OWNER, '/disable');
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    await h.postVideo(MEMBER, { fileId: 'a2', fileUniqueId: 'same' });
    assert.equal(await h.cols.fingerprints.countDocuments({}), 0);
    assert.equal(await h.cols.jobs.countDocuments({}), 0);
    await h.groupCommand(OWNER, '/enable');
    await h.postVideo(MEMBER, { fileId: 'a3', fileUniqueId: 'same' });
    assert.equal(await h.cols.approvals.countDocuments({}), 0, 'videos posted while disabled are not history');
  });

  test('the same video in another group is not a duplicate', async () => {
    await h.setupEnabledGroup();
    await h.setupEnabledGroup({ chat: OTHER_GROUP });
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same', chat: GROUP });
    await h.postVideo(MEMBER, { fileId: 'a2', fileUniqueId: 'same', chat: OTHER_GROUP });
    assert.equal(await h.cols.approvals.countDocuments({}), 0);
    await h.postVideo(MEMBER, { fileId: 'a3', fileUniqueId: 'same', chat: OTHER_GROUP });
    const req = await h.lastApproval();
    assert.equal(req.groupId, OTHER_GROUP.id);
  });

  test('non-video messages are ignored', async () => {
    await h.setupEnabledGroup();
    await h.send({ message: { message_id: h.nextMessageId(), date: 1, chat: GROUP, from: MEMBER, photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] } });
    await h.send({ message: { message_id: h.nextMessageId(), date: 1, chat: GROUP, from: MEMBER, text: 'hello' } });
    assert.equal(await h.cols.fingerprints.countDocuments({}), 0);
  });
});
