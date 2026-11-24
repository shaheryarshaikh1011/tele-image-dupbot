export const DEFAULT_GROUP_SETTINGS = Object.freeze({
  sensitivity: 'balanced', // strict | balanced | lenient
  groupNotices: true, // post a notice (with Delete/Keep buttons) in the group itself
  privateNotices: true, // DM approval requests to admins who started the bot
});

export const SETUP_STATUS = Object.freeze({
  needsAdminRights: 'needs_admin_rights',
  needsOwnerSetup: 'needs_owner_setup',
  ready: 'ready',
});

/**
 * Per-group state. Every group is isolated: its own toggle, settings, fingerprints, approvals and audit trail.
 */
export function createGroupService({ cols }) {
  async function get(chatId) {
    const doc = await cols.groups.findOne({ _id: chatId });
    if (!doc) return null;
    return { ...doc, settings: { ...DEFAULT_GROUP_SETTINGS, ...(doc.settings ?? {}) } };
  }

  return {
    get,

    /** Create or refresh a group record from a Telegram chat object. */
    async upsertFromChat(chat, patch = {}) {
      const now = new Date();
      const defaults = {
        enabled: false,
        settings: { ...DEFAULT_GROUP_SETTINGS },
        setupStatus: SETUP_STATUS.needsAdminRights,
        createdAt: now,
      };
      // MongoDB rejects an update that touches the same path in $set and $setOnInsert.
      for (const key of Object.keys(patch)) delete defaults[key];
      await cols.groups.updateOne(
        { _id: chat.id },
        {
          $set: {
            title: chat.title ?? null,
            username: chat.username ?? null,
            type: chat.type,
            updatedAt: now,
            ...patch,
          },
          $setOnInsert: defaults,
        },
        { upsert: true },
      );
      return get(chat.id);
    },

    async update(chatId, patch) {
      await cols.groups.updateOne({ _id: chatId }, { $set: { ...patch, updatedAt: new Date() } });
      return get(chatId);
    },

    async setEnabled(chatId, enabled, actorId) {
      await cols.groups.updateOne(
        { _id: chatId },
        {
          $set: {
            enabled,
            [enabled ? 'enabledBy' : 'disabledBy']: actorId,
            [enabled ? 'enabledAt' : 'disabledAt']: new Date(),
            updatedAt: new Date(),
          },
        },
      );
      return get(chatId);
    },

    async updateSetting(chatId, key, value) {
      if (!(key in DEFAULT_GROUP_SETTINGS)) throw new Error(`Unknown setting ${key}`);
      await cols.groups.updateOne({ _id: chatId }, { $set: { [`settings.${key}`]: value, updatedAt: new Date() } });
      return get(chatId);
    },

    /**
     * A basic group upgraded to a supergroup gets a new chat id. Move all group-scoped data so the
     * group keeps its settings and history.
     */
    async migrate(oldId, newId) {
      const existing = await cols.groups.findOne({ _id: oldId });
      if (existing) {
        const { _id, ...rest } = existing;
        await cols.groups.updateOne({ _id: newId }, { $set: { ...rest, type: 'supergroup', migratedFrom: oldId, updatedAt: new Date() } }, { upsert: true });
        await cols.groups.deleteOne({ _id: oldId });
      }
      // Message ids restart in the new supergroup, so old fingerprints can no longer link to their
      // messages. Keep them for matching under negative ids (which never collide with real ones).
      const old = await cols.fingerprints.find({ groupId: oldId }).toArray();
      for (const fp of old) {
        // eslint-disable-next-line no-await-in-loop
        await cols.fingerprints.updateOne(
          { _id: fp._id },
          { $set: { groupId: newId, messageId: -Math.abs(fp.messageId), migratedFrom: oldId, originalMessageIdBeforeMigration: fp.messageId } },
        );
      }
      await cols.audit.updateMany({ groupId: oldId }, { $set: { groupId: newId, migratedFrom: oldId } });
    },
  };
}
