/**
 * Tracks which users have opened a private chat with the bot (/start). Only these users can
 * receive private approval requests — Telegram does not allow bots to message users first.
 */
export function createUserService({ cols }) {
  return {
    async registerPrivateStart(user) {
      const now = new Date();
      await cols.users.updateOne(
        { _id: user.id },
        {
          $set: {
            firstName: user.first_name ?? null,
            lastName: user.last_name ?? null,
            username: user.username ?? null,
            privateChatOpen: true,
            lastStartAt: now,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    },

    /** Called when Telegram rejects a private message (user blocked the bot / deleted account). */
    async markUnreachable(userId) {
      await cols.users.updateOne({ _id: userId }, { $set: { privateChatOpen: false, updatedAt: new Date() } });
    },

    /** Subset of `userIds` that can currently receive private messages. */
    async filterReachable(userIds) {
      if (!userIds.length) return [];
      const docs = await cols.users.find({ _id: { $in: userIds }, privateChatOpen: true }).toArray();
      const reachable = new Set(docs.map((d) => d._id));
      return userIds.filter((id) => reachable.has(id));
    },
  };
}
