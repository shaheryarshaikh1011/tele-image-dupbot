import { durationWindow } from '../detection/compare.js';

export const FP_STATUS = Object.freeze({
  pending: 'pending', // metadata stored, frames not yet extracted (lazy — only done when needed)
  ready: 'ready', // frame hashes available
  unavailable: 'unavailable', // cannot be analysed (too large, download failed, undecodable)
});

/**
 * Group-scoped media fingerprints. Fingerprinting is lazy: a video is only downloaded and analysed
 * when another video with a compatible duration shows up in the same group.
 */
export function createFingerprintService({ cols, config }) {
  return {
    /** Record a newly seen video. Idempotent per (groupId, messageId). */
    async recordSeen(media) {
      const now = new Date();
      await cols.fingerprints.updateOne(
        { groupId: media.groupId, messageId: media.messageId },
        {
          $setOnInsert: {
            groupId: media.groupId,
            messageId: media.messageId,
            fileId: media.fileId,
            fileUniqueId: media.fileUniqueId,
            duration: media.duration ?? null,
            width: media.width ?? null,
            height: media.height ?? null,
            fileSize: media.fileSize ?? null,
            mimeType: media.mimeType ?? null,
            uploaderId: media.uploaderId ?? null,
            messageDate: media.messageDate ?? null,
            status: FP_STATUS.pending,
            frames: null,
            deleted: false,
            firstSeenAt: now,
          },
        },
        { upsert: true },
      );
      return cols.fingerprints.findOne({ groupId: media.groupId, messageId: media.messageId });
    },

    get(groupId, messageId) {
      return cols.fingerprints.findOne({ groupId, messageId });
    },

    /** Stage 1: same Telegram media (file_unique_id) already posted in this group. */
    findExact(groupId, fileUniqueId, excludeMessageId) {
      return cols.fingerprints.findOne(
        { groupId, fileUniqueId, deleted: { $ne: true }, messageId: { $ne: excludeMessageId } },
        { sort: { firstSeenAt: 1 } },
      );
    },

    /**
     * Stage 2 candidates: earlier, non-deleted videos in the same group with a compatible duration.
     * Cheap metadata filtering keeps the number of expensive frame comparisons bounded.
     */
    async findCandidates(groupId, messageId, duration, seenBefore = new Date()) {
      const query = {
        groupId,
        messageId: { $ne: messageId },
        firstSeenAt: { $lte: seenBefore },
        deleted: { $ne: true },
        status: { $ne: FP_STATUS.unavailable },
      };
      if (Number.isFinite(duration) && duration > 0) {
        const { min, max } = durationWindow(duration, {
          toleranceSec: config.durationToleranceSec,
          tolerancePct: config.durationTolerancePct,
        });
        // Videos sent as files have no duration until fingerprinted, so they stay candidates.
        query.$or = [{ duration: { $gte: min, $lte: max } }, { duration: null }];
      }
      return cols.fingerprints.find(query).sort({ firstSeenAt: -1 }).limit(config.maxCandidates).toArray();
    },

    async saveFrames(groupId, messageId, result) {
      await cols.fingerprints.updateOne(
        { groupId, messageId },
        {
          $set: {
            status: FP_STATUS.ready,
            frames: result.frames,
            informativeFrames: result.informativeFrames,
            duration: result.duration,
            width: result.width,
            height: result.height,
            fingerprintedAt: new Date(),
          },
        },
      );
    },

    async markUnavailable(groupId, messageId, reason) {
      await cols.fingerprints.updateOne(
        { groupId, messageId },
        { $set: { status: FP_STATUS.unavailable, unavailableReason: reason, updatedAt: new Date() } },
      );
    },

    /** Deleted duplicates are excluded from future matching. */
    async markDeleted(groupId, messageId) {
      await cols.fingerprints.updateOne({ groupId, messageId }, { $set: { deleted: true, deletedAt: new Date() } });
    },
  };
}
