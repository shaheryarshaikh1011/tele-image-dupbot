import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseSettingsCallback, parseSetupPayload, setupDeepLink } from '../src/bot/texts.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { messageLink } from '../src/telegram/format.js';
import { createThrottle, safeCall } from '../src/telegram/safeCall.js';
import { ADMIN, createHarness, GROUP, MEMBER, OWNER } from './helpers/harness.js';

const lastText = (h, chatId) => h.api.callsTo('sendMessage').filter((m) => m.chat_id === chatId).at(-1)?.text ?? '';

describe('public onboarding', () => {
  let h;
  beforeEach(async () => {
    h = await createHarness();
    h.api.setMember(GROUP.id, OWNER, 'creator');
    h.api.setMember(GROUP.id, ADMIN, 'administrator');
    h.api.setMember(GROUP.id, MEMBER, 'member');
  });
  afterEach(() => h.close());

  test('adding the bot without admin rights posts a welcome asking for promotion', async () => {
    await h.botAdded({ asAdmin: false });
    const group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.setupStatus, 'needs_admin_rights');
    assert.equal(group.enabled, false, 'processing is off until /enable');
    const welcome = h.api.callsTo('sendMessage').find((m) => m.chat_id === GROUP.id);
    assert.match(welcome.text, /promote me to admin/);
    assert.equal(welcome.reply_markup.inline_keyboard[0][0].url, setupDeepLink('dupbot', GROUP.id));
    assert.ok(await h.cols.audit.findOne({ type: 'group_added', actorId: OWNER.id }));
  });

  test('promotion to admin advances setup', async () => {
    await h.botAdded({ asAdmin: false });
    await h.send({
      my_chat_member: {
        chat: GROUP,
        from: OWNER,
        date: 1,
        old_chat_member: { status: 'member', user: h.api.me },
        new_chat_member: { status: 'administrator', user: h.api.me, can_delete_messages: true },
      },
    });
    const group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.setupStatus, 'needs_owner_setup');
    assert.equal(group.botCanDelete, true);
    assert.match(lastText(h, GROUP.id), /can now delete messages/);
  });

  test('private /start with setup link completes setup for an admin', async () => {
    await h.botAdded();
    await h.privateCommand(OWNER, `/start setup_${Math.abs(GROUP.id)}`);
    const group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.setupStatus, 'ready');
    assert.equal(group.setupBy, OWNER.id);
    assert.match(lastText(h, OWNER.id), /Send \/enable <b>in the group<\/b>/);
    const user = await h.cols.users.findOne({ _id: OWNER.id });
    assert.equal(user.privateChatOpen, true);
    assert.ok(await h.cols.audit.findOne({ type: 'setup_completed' }));
  });

  test('a non-admin cannot complete setup but is still registered for DMs', async () => {
    await h.botAdded();
    await h.privateCommand(MEMBER, `/start setup_${Math.abs(GROUP.id)}`);
    assert.match(lastText(h, MEMBER.id), /Only admins/);
    assert.equal((await h.cols.groups.findOne({ _id: GROUP.id })).setupStatus, 'needs_owner_setup');
  });

  test('plain /start registers private notifications', async () => {
    await h.privateCommand(ADMIN, '/start');
    assert.equal((await h.cols.users.findOne({ _id: ADMIN.id })).privateChatOpen, true);
    assert.match(lastText(h, ADMIN.id), /Private notifications are on/);
  });

  test('/enable requires an admin', async () => {
    await h.botAdded();
    await h.groupCommand(MEMBER, '/enable');
    assert.match(lastText(h, GROUP.id), /Only group admins/);
    assert.equal((await h.cols.groups.findOne({ _id: GROUP.id })).enabled, false);
  });

  test('/enable requires the bot to have delete permission', async () => {
    await h.botAdded({ asAdmin: false });
    await h.groupCommand(OWNER, '/enable');
    assert.match(lastText(h, GROUP.id), /Delete messages/);
    assert.equal((await h.cols.groups.findOne({ _id: GROUP.id })).enabled, false);
  });

  test('/enable and /disable toggle processing and are audited', async () => {
    await h.botAdded();
    await h.groupCommand(ADMIN, '/enable');
    let group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.enabled, true);
    assert.equal(group.enabledBy, ADMIN.id);
    assert.match(lastText(h, GROUP.id), /enabled/);
    assert.match(lastText(h, GROUP.id), /No admin has started me privately/);

    await h.groupCommand(OWNER, '/disable');
    group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.enabled, false);
    const types = (await h.cols.audit.find({}).toArray()).map((a) => a.type);
    assert.ok(types.includes('processing_enabled'));
    assert.ok(types.includes('processing_disabled'));
  });

  test('anonymous admins (posting as the group) can use admin commands', async () => {
    await h.botAdded();
    await h.send({
      message: {
        message_id: h.nextMessageId(),
        date: 1,
        chat: GROUP,
        from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
        sender_chat: GROUP,
        text: '/enable',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });
    assert.equal((await h.cols.groups.findOne({ _id: GROUP.id })).enabled, true);
  });

  test('admin commands in a private chat are redirected to the group', async () => {
    await h.privateCommand(OWNER, '/status');
    assert.match(lastText(h, OWNER.id), /inside the group/);
  });

  test('removing the bot disables the group', async () => {
    await h.botAdded();
    await h.groupCommand(OWNER, '/enable');
    await h.send({
      my_chat_member: {
        chat: GROUP,
        from: OWNER,
        date: 1,
        old_chat_member: { status: 'administrator', user: h.api.me },
        new_chat_member: { status: 'left', user: h.api.me },
      },
    });
    const group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.active, false);
    assert.equal(group.enabled, false);
  });

  test('group → supergroup migration keeps settings and history', async () => {
    const basic = { id: -4001, type: 'group', title: 'Basic' };
    h.api.setMember(basic.id, OWNER, 'creator');
    await h.botAdded({ chat: basic });
    await h.groupCommand(OWNER, '/enable', basic);
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same', chat: basic });
    await h.send({ message: { message_id: h.nextMessageId(), date: 1, chat: basic, from: OWNER, migrate_to_chat_id: -100777 } });
    const migrated = await h.cols.groups.findOne({ _id: -100777 });
    assert.equal(migrated.enabled, true);
    assert.equal(await h.cols.groups.countDocuments({ _id: basic.id }), 0);
    const fp = await h.cols.fingerprints.findOne({ groupId: -100777 });
    assert.ok(fp.messageId < 0, 'old message ids moved out of the way');
  });
});

describe('status, stats, audit and settings', () => {
  let h;
  beforeEach(async () => {
    h = await createHarness();
    await h.setupEnabledGroup();
  });
  afterEach(() => h.close());

  test('/status summarises state', async () => {
    await h.groupCommand(ADMIN, '/status');
    const text = lastText(h, GROUP.id);
    assert.match(text, /enabled/);
    assert.match(text, /Bot can delete messages: yes/);
    assert.match(text, /Admins receiving private requests: 2\/2/);
    assert.match(text, /Sensitivity: Balanced/);
  });

  test('/stats and /audit reflect moderation activity', async () => {
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    await h.postVideo(MEMBER, { fileId: 'a2', fileUniqueId: 'same' });
    const req = await h.lastApproval();
    await h.click(ADMIN, `ap:${req._id}:del`);

    await h.groupCommand(ADMIN, '/stats');
    const stats = lastText(h, GROUP.id);
    assert.match(stats, /Videos tracked: 2/);
    assert.match(stats, /Duplicates suspected: 1 \(exact file: 1, visual match: 0\)/);
    assert.match(stats, /Deleted by admins: 1/);

    await h.groupCommand(ADMIN, '/audit');
    const audit = lastText(h, GROUP.id);
    assert.match(audit, /duplicate suspected/);
    assert.match(audit, /delete chosen/);
    assert.match(audit, /deleted ✓/);
  });

  test('members cannot see stats or audit', async () => {
    await h.groupCommand(MEMBER, '/audit');
    assert.match(lastText(h, GROUP.id), /Only group admins/);
  });

  test('/settings changes sensitivity and notification channels', async () => {
    await h.groupCommand(OWNER, '/settings');
    const msg = h.api.callsTo('sendMessage').at(-1);
    assert.ok(msg.reply_markup.inline_keyboard.length >= 3);

    await h.click(ADMIN, 'st:sensitivity:strict', { message_id: 5, chat: GROUP });
    await h.click(ADMIN, 'st:groupNotices:off', { message_id: 5, chat: GROUP });
    let group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.settings.sensitivity, 'strict');
    assert.equal(group.settings.groupNotices, false);

    // Turning off the last channel is refused
    await h.click(ADMIN, 'st:privateNotices:off', { message_id: 5, chat: GROUP });
    group = await h.cols.groups.findOne({ _id: GROUP.id });
    assert.equal(group.settings.privateNotices, true);
    assert.match(h.api.callsTo('answerCallbackQuery').at(-1).text, /At least one/);

    // Non-admin cannot change settings
    await h.click(MEMBER, 'st:sensitivity:lenient', { message_id: 5, chat: GROUP });
    assert.equal((await h.cols.groups.findOne({ _id: GROUP.id })).settings.sensitivity, 'strict');

    assert.equal(await h.cols.audit.countDocuments({ type: 'setting_changed' }), 2);
  });

  test('with group notices off, only private requests are sent', async () => {
    await h.click(ADMIN, 'st:groupNotices:off', { message_id: 5, chat: GROUP });
    h.api.reset();
    await h.postVideo(MEMBER, { fileId: 'a1', fileUniqueId: 'same' });
    await h.postVideo(MEMBER, { fileId: 'a2', fileUniqueId: 'same' });
    const sent = h.api.callsTo('sendMessage');
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((m) => m.chat_id > 0));
  });
});

describe('helpers', () => {
  test('config validation', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ BOT_TOKEN: 'x', MONGODB_URI: 'y', WORKER_CONCURRENCY: 'lots' }), /WORKER_CONCURRENCY/);
    const c = loadConfig({ BOT_TOKEN: 'x', MONGODB_URI: 'y', APPROVAL_TTL_HOURS: '5' });
    assert.equal(c.approvalTtlMs, 5 * 3_600_000);
    assert.equal(c.maxVideoSizeMb, 20);
    assert.equal(c.workerConcurrency, 1);
  });

  test('deep link payloads round-trip', () => {
    assert.equal(parseSetupPayload('setup_1001234567890'), -1001234567890);
    assert.equal(parseSetupPayload('setup_abc'), null);
    assert.equal(parseSetupPayload(''), null);
  });

  test('settings callback parsing rejects junk', () => {
    assert.deepEqual(parseSettingsCallback('st:groupNotices:off'), { key: 'groupNotices', value: false });
    assert.deepEqual(parseSettingsCallback('st:sensitivity:lenient'), { key: 'sensitivity', value: 'lenient' });
    assert.equal(parseSettingsCallback('st:sensitivity:on'), null);
    assert.equal(parseSettingsCallback('st:enabled:on'), null);
  });

  test('message links', () => {
    assert.equal(messageLink({ id: -1001234567890 }, 5), 'https://t.me/c/1234567890/5');
    assert.equal(messageLink({ id: -100, username: 'pub' }, 5), 'https://t.me/pub/5');
    assert.equal(messageLink({ id: -4001 }, 5), null);
  });

  test('safeCall retries flood limits and transient errors, not client errors', async () => {
    const sleeps = [];
    const sleepFn = async (ms) => sleeps.push(ms);
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) throw { response: { error_code: 429, parameters: { retry_after: 2 } } };
      if (n === 2) throw { response: { error_code: 502 } };
      return 'ok';
    };
    assert.equal(await safeCall(flaky, { sleepFn }), 'ok');
    assert.deepEqual(sleeps, [2100, 1000]);
    await assert.rejects(safeCall(async () => { throw { response: { error_code: 400 } }; }, { sleepFn }));
  });

  test('throttle serialises calls', async () => {
    const throttle = createThrottle(0);
    const order = [];
    await Promise.all([1, 2, 3].map((i) => throttle(async () => order.push(i))));
    assert.deepEqual(order, [1, 2, 3]);
  });
});
