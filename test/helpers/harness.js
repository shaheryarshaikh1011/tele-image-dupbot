import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { collectionsFor, ensureIndexes } from '../../src/db.js';
import { silentLogger } from '../../src/logger.js';
import { FakeDb } from './fakeMongo.js';
import { startFakeTelegram } from './fakeTelegram.js';

export const GROUP = { id: -1001234567890, type: 'supergroup', title: 'Test Group' };
export const OWNER = { id: 1, is_bot: false, first_name: 'Olivia' };
export const ADMIN = { id: 2, is_bot: false, first_name: 'Adam' };
export const MEMBER = { id: 3, is_bot: false, first_name: 'Mia' };

let updateId = 0;

/**
 * Build the full application against an in-memory database and a fake Telegram API server.
 * `files` maps Telegram file_id -> local video path for the download seam.
 */
export async function createHarness({ env = {}, files = {} } = {}) {
  const api = await startFakeTelegram();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dupbot-test-'));
  const config = loadConfig({ BOT_TOKEN: 'TEST:TOKEN', MONGODB_URI: 'mongodb://fake', TEMP_DIR: tempDir, FRAME_SAMPLES: '8', ...env });
  const db = new FakeDb();
  const cols = collectionsFor(db);
  await ensureIndexes(cols);

  const downloads = [];
  const app = createApp({
    config,
    cols,
    logger: silentLogger,
    telegrafOptions: { telegram: { apiRoot: api.apiRoot } },
    overrides: {
      throttle: (fn) => fn(),
      download: async (_telegram, fileId, dest) => {
        downloads.push(fileId);
        if (!files[fileId]) throw Object.assign(new Error(`no fixture for ${fileId}`), { code: 'NETWORK' });
        await fs.copyFile(files[fileId], dest);
        return { bytes: (await fs.stat(dest)).size };
      },
    },
  });
  app.bot.botInfo = api.me;

  const send = (update) => app.bot.handleUpdate({ update_id: ++updateId, ...update });
  let messageId = 100;

  const h = {
    api,
    app,
    cols,
    config,
    files,
    downloads,
    tempDir,
    send,
    nextMessageId: () => ++messageId,

    async groupCommand(from, text, chat = GROUP) {
      return send({ message: { message_id: ++messageId, date: now(), chat, from, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } });
    },

    async privateCommand(from, text) {
      return send({
        message: { message_id: ++messageId, date: now(), chat: { id: from.id, type: 'private', first_name: from.first_name }, from, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] },
      });
    },

    /** Post a video into a group. Returns the message id. */
    async postVideo(from, { fileId, fileUniqueId = `uniq_${fileId}`, duration = 6, fileSize = 100_000, chat = GROUP, asDocument = false } = {}) {
      const id = ++messageId;
      const media = asDocument
        ? { document: { file_id: fileId, file_unique_id: fileUniqueId, mime_type: 'video/mp4', file_size: fileSize } }
        : { video: { file_id: fileId, file_unique_id: fileUniqueId, duration, width: 320, height: 240, file_size: fileSize, mime_type: 'video/mp4' } };
      await send({ message: { message_id: id, date: now(), chat, from, ...media } });
      return id;
    },

    async click(from, data, message = { message_id: 1, chat: GROUP }) {
      return send({ callback_query: { id: String(++updateId), from, chat_instance: 'x', data, message: { date: now(), ...message } } });
    },

    async botAdded({ asAdmin = true, by = OWNER, chat = GROUP } = {}) {
      api.setMember(chat.id, api.me, asAdmin ? 'administrator' : 'member', asAdmin ? { can_delete_messages: true } : {});
      return send({
        my_chat_member: {
          chat,
          from: by,
          date: now(),
          old_chat_member: { status: 'left', user: api.me },
          new_chat_member: asAdmin ? { status: 'administrator', user: api.me, can_delete_messages: true } : { status: 'member', user: api.me },
        },
      });
    },

    /** Typical ready-to-use group: bot is admin, owner + admin exist, both started the bot, enabled. */
    async setupEnabledGroup({ privateStart = [OWNER, ADMIN], chat = GROUP } = {}) {
      api.setMember(chat.id, OWNER, 'creator');
      api.setMember(chat.id, ADMIN, 'administrator');
      api.setMember(chat.id, MEMBER, 'member');
      await h.botAdded({ chat });
      for (const u of privateStart) await h.privateCommand(u, `/start setup_${Math.abs(chat.id)}`);
      await h.groupCommand(OWNER, '/enable', chat);
      api.reset();
    },

    lastApproval: async () => (await cols.approvals.find({}).sort({ createdAt: -1 }).limit(1).toArray())[0],

    async close() {
      await app.stopBackground().catch(() => {});
      await api.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
  return h;
}

function now() {
  return Math.floor(Date.now() / 1000);
}
