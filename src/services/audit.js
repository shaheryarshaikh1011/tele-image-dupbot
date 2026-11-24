export const AUDIT = Object.freeze({
  groupAdded: 'group_added',
  groupRemoved: 'group_removed',
  setupCompleted: 'setup_completed',
  processingEnabled: 'processing_enabled',
  processingDisabled: 'processing_disabled',
  settingChanged: 'setting_changed',
  duplicateDetected: 'duplicate_detected',
  decisionDelete: 'decision_delete',
  decisionKeep: 'decision_keep',
  deletionResult: 'deletion_result',
  requestExpired: 'request_expired',
  analysisFailed: 'analysis_failed',
});

/**
 * Append-only moderation history. Stores metadata only — never copies of users' videos.
 */
export function createAuditService({ cols, logger }) {
  return {
    async record(event) {
      const doc = {
        groupId: event.groupId,
        type: event.type,
        actorId: event.actorId ?? null,
        originalMessageId: event.originalMessageId ?? null,
        duplicateMessageId: event.duplicateMessageId ?? null,
        uploaderId: event.uploaderId ?? null,
        approvalId: event.approvalId ?? null,
        detectionMethod: event.detectionMethod ?? null,
        score: event.score ?? null,
        action: event.action ?? null,
        deletionResult: event.deletionResult ?? null,
        details: event.details ?? null,
        createdAt: new Date(),
      };
      try {
        await cols.audit.insertOne(doc);
      } catch (err) {
        // Auditing must never break moderation, but a failure is worth shouting about.
        logger.error('audit write failed', { err, event: doc });
      }
      return doc;
    },

    async recent(groupId, limit = 10) {
      return cols.audit.find({ groupId }).sort({ createdAt: -1 }).limit(limit).toArray();
    },
  };
}
