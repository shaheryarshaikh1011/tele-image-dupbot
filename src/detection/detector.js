import fs from 'node:fs/promises';
import path from 'node:path';
import { compareFrameSequences } from './compare.js';
import { DownloadError, downloadTelegramFile } from './download.js';
import { fingerprintVideo as defaultFingerprintVideo } from './ffmpeg.js';
import { FP_STATUS } from '../services/fingerprints.js';
import { DETECTION_METHOD } from '../services/approvals.js';
import { AUDIT } from '../services/audit.js';

/**
 * Pull the video attributes we care about out of a Telegram message.
 * Handles native videos and videos sent as files (documents with a video/* MIME type).
 * Returns null for anything else — the MVP is video-only.
 */
export function extractVideo(message) {
  if (message?.video) {
    const v = message.video;
    return {
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      duration: v.duration ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      fileSize: v.file_size ?? null,
      mimeType: v.mime_type ?? null,
      kind: 'video',
    };
  }
  const d = message?.document;
  if (d && typeof d.mime_type === 'string' && d.mime_type.startsWith('video/')) {
    return {
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      duration: null,
      width: null,
      height: null,
      fileSize: d.file_size ?? null,
      mimeType: d.mime_type,
      kind: 'document',
    };
  }
  return null;
}

/**
 * Two-stage duplicate detection.
 *   Stage 1 (inline, cheap): exact Telegram `file_unique_id` match within the group — no download.
 *   Stage 2 (queued, expensive): download + FFmpeg frame extraction + ordered perceptual-hash
 *   comparison against duration-compatible earlier videos in the same group.
 */
export function createDetector({ config, logger, telegram, groups, fingerprints, approvals, audit, fingerprintVideo = defaultFingerprintVideo, download = downloadTelegramFile }) {
  const maxBytes = Math.round(config.maxVideoSizeMb * 1024 * 1024);

  function analysable(fp) {
    if (fp.fileSize && fp.fileSize > maxBytes) return { ok: false, reason: 'too_large' };
    if (fp.duration && fp.duration > config.maxVideoDurationSec) return { ok: false, reason: 'too_long' };
    return { ok: true };
  }

  /** Download + fingerprint a stored video if not done yet. Returns the frames, or null if unavailable. */
  async function ensureFrames(fp) {
    if (fp.status === FP_STATUS.ready) return fp;
    if (fp.status === FP_STATUS.unavailable) return null;
    const check = analysable(fp);
    if (!check.ok) {
      await fingerprints.markUnavailable(fp.groupId, fp.messageId, check.reason);
      return null;
    }

    await fs.mkdir(config.tempDir, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(config.tempDir, 'job-'));
    const file = path.join(workDir, 'video');
    const started = Date.now();
    try {
      await download(telegram, fp.fileId, file, { maxBytes, timeoutMs: config.downloadTimeoutMs });
      const result = await fingerprintVideo(file, {
        samples: config.frameSamples,
        knownDuration: fp.duration,
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        timeoutMs: config.ffmpegTimeoutMs,
      });
      if (result.duration > config.maxVideoDurationSec) {
        await fingerprints.markUnavailable(fp.groupId, fp.messageId, 'too_long');
        return null;
      }
      await fingerprints.saveFrames(fp.groupId, fp.messageId, result);
      logger.debug('fingerprinted video', { groupId: fp.groupId, messageId: fp.messageId, ms: Date.now() - started });
      return { ...fp, ...result, status: FP_STATUS.ready };
    } catch (err) {
      if (err instanceof DownloadError && ['TOO_LARGE', 'GET_FILE_FAILED'].includes(err.code)) {
        await fingerprints.markUnavailable(fp.groupId, fp.messageId, err.code.toLowerCase());
        return null;
      }
      if (err?.code === 'NO_DURATION' || err?.exitCode !== undefined) {
        // Undecodable media will never succeed — don't burn retries on it.
        await fingerprints.markUnavailable(fp.groupId, fp.messageId, 'undecodable');
        return null;
      }
      throw err; // transient (network, timeout) → job retry
    } finally {
      // Always clean temporary media, including on failure.
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    /**
     * Handle a new video message in an enabled group. Runs inline in the update handler and only
     * does database work; anything expensive is queued.
     * @returns {Promise<{ outcome: string, approvalId?: string }>}
     */
    async handleNewVideo({ group, message, video, enqueue }) {
      const groupId = group._id;
      const fp = await fingerprints.recordSeen({
        groupId,
        messageId: message.message_id,
        ...video,
        uploaderId: message.from?.id ?? null,
        messageDate: message.date ? new Date(message.date * 1000) : null,
      });

      // Stage 1: identical Telegram media already posted in this group.
      const exact = await fingerprints.findExact(groupId, video.fileUniqueId, message.message_id);
      if (exact) {
        const req = await approvals.create({
          group,
          original: exact,
          duplicate: { messageId: message.message_id, uploaderId: message.from?.id, uploaderName: message.from?.first_name },
          detectionMethod: DETECTION_METHOD.exact,
          score: 1,
          details: { fileUniqueId: video.fileUniqueId },
        });
        return { outcome: 'exact_match', approvalId: req?._id };
      }

      const check = analysable(fp);
      if (!check.ok) {
        await fingerprints.markUnavailable(groupId, message.message_id, check.reason);
        return { outcome: `not_analysable_${check.reason}` };
      }

      // Lazy stage 2: only spend CPU/bandwidth if an earlier video could plausibly match.
      // (Documents have no duration until probed, so they always qualify.)
      const candidates = await fingerprints.findCandidates(groupId, message.message_id, video.duration, fp.firstSeenAt);
      if (!candidates.length) return { outcome: 'no_candidates' };

      const queued = await enqueue({
        groupId,
        messageId: message.message_id,
        payload: { uploaderName: message.from?.first_name ?? null },
      });
      if (queued === 'queue_full') {
        logger.warn('analysis queue full, skipping smart comparison', { groupId, messageId: message.message_id });
      }
      return { outcome: queued === 'queued' ? 'queued' : queued };
    },

    /** Job processor for stage 2. */
    async processJob(job) {
      const { groupId, messageId } = job;
      const group = await groups.get(groupId);
      // Disabled groups get no backlog processing (plan §5).
      if (!group || !group.enabled || group.active === false) return { skipped: true, outcome: 'group_disabled' };

      const fp = await fingerprints.get(groupId, messageId);
      if (!fp || fp.deleted) return { skipped: true, outcome: 'message_gone' };

      const current = await ensureFrames(fp);
      if (!current) return { outcome: 'unavailable' };
      if (current.informativeFrames < 3) return { outcome: 'not_enough_information' };

      const candidates = await fingerprints.findCandidates(groupId, messageId, current.duration, fp.firstSeenAt);
      const threshold = config.sensitivityPresets[group.settings.sensitivity] ?? config.sensitivityPresets.balanced;

      let best = null;
      let compared = 0;
      for (const candidate of candidates) {
        let other;
        try {
          // eslint-disable-next-line no-await-in-loop
          other = await ensureFrames(candidate);
        } catch (err) {
          logger.warn('could not fingerprint candidate', { err, groupId, messageId: candidate.messageId });
          continue;
        }
        if (!other) continue;
        compared += 1;
        const result = compareFrameSequences(current.frames, other.frames, {
          frameMatchMaxDistance: config.frameMatchMaxDistance,
          maxShift: config.maxFrameShift,
        });
        if (!result.conclusive || result.score < threshold) continue;
        if (!best || result.score > best.result.score || (result.score === best.result.score && result.meanDistance < best.result.meanDistance)) {
          best = { candidate: other, result };
        }
      }

      if (!best) return { outcome: 'no_match', compared };

      const req = await approvals.create({
        group,
        original: best.candidate,
        duplicate: { messageId, uploaderId: fp.uploaderId, uploaderName: job.payload?.uploaderName ?? null },
        detectionMethod: DETECTION_METHOD.visual,
        score: best.result.score,
        details: {
          matchedFrames: best.result.matchedFrames,
          comparedFrames: best.result.comparedFrames,
          meanDistance: Number(best.result.meanDistance.toFixed(2)),
          shift: best.result.shift,
          threshold,
        },
      });
      return { outcome: 'visual_match', approvalId: req?._id ?? null, score: best.result.score, compared };
    },

    /** Called by the queue when a job is out of retries, for audit visibility. */
    async recordFailure(job, err) {
      await audit.record({
        groupId: job.groupId,
        type: AUDIT.analysisFailed,
        duplicateMessageId: job.messageId,
        details: { error: String(err?.message ?? err).slice(0, 300) },
      });
    },
  };
}
