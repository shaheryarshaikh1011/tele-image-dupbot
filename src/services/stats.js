import { FP_STATUS } from './fingerprints.js';

export function createStatsService({ cols }) {
  return {
    async forGroup(groupId) {
      const count = (col, q) => col.countDocuments({ groupId, ...q });
      const [videosTracked, videosFingerprinted, detected, exact, pending, expired, deleted, kept, deleteFailures] = await Promise.all([
        count(cols.fingerprints, {}),
        count(cols.fingerprints, { status: FP_STATUS.ready }),
        count(cols.approvals, {}),
        count(cols.approvals, { detectionMethod: 'exact_file_id' }),
        count(cols.approvals, { status: 'pending' }),
        count(cols.approvals, { status: 'expired' }),
        count(cols.approvals, { decision: 'delete', 'deletionResult.ok': true }),
        count(cols.approvals, { decision: 'keep' }),
        count(cols.approvals, { decision: 'delete', 'deletionResult.ok': false }),
      ]);
      return {
        videosTracked,
        videosFingerprinted,
        detected,
        exact,
        visual: detected - exact,
        pending,
        expired,
        deleted,
        kept,
        deleteFailures,
      };
    },
  };
}
