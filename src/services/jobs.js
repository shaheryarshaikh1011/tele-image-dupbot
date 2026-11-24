import crypto from 'node:crypto';
import { isDuplicateKeyError } from '../db.js';

export const JOB_STATUS = Object.freeze({
  pending: 'pending',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
});

/**
 * MongoDB-backed, bounded job queue with a small in-process worker pool.
 *
 *  - Jobs are claimed with an atomic findOneAndUpdate, so a job is never processed twice concurrently.
 *  - Job state lives in Mongo, so a Railway restart loses nothing: jobs left in `processing` by a dead
 *    worker are re-queued (or failed once out of attempts).
 *  - Failures are retried with exponential backoff up to `jobMaxAttempts`.
 *  - The queue is bounded: `enqueue` refuses new work beyond `maxQueueSize` outstanding jobs.
 */
export function createJobQueue({ cols, config, logger, processJob, onPermanentFailure = async () => {}, now = () => new Date() }) {
  const workerId = crypto.randomBytes(6).toString('hex');
  const retentionMs = config.recordRetentionDays * 86_400_000;
  let running = false;
  let active = 0;
  let pollTimer = null;
  let staleTimer = null;
  const inflight = new Set();

  async function outstanding() {
    return cols.jobs.countDocuments({ status: { $in: [JOB_STATUS.pending, JOB_STATUS.processing] } });
  }

  async function claim() {
    const t = now();
    return cols.jobs.findOneAndUpdate(
      { status: JOB_STATUS.pending, runAfter: { $lte: t } },
      { $set: { status: JOB_STATUS.processing, lockedAt: t, workerId, updatedAt: t }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
  }

  async function finish(job, status, fields = {}) {
    const t = now();
    await cols.jobs.updateOne(
      { _id: job._id, workerId },
      { $set: { status, finishedAt: t, updatedAt: t, purgeAt: new Date(t.getTime() + retentionMs), ...fields } },
    );
  }

  async function handleFailure(job, err) {
    const t = now();
    const error = String(err?.message ?? err).slice(0, 500);
    if (job.attempts >= config.jobMaxAttempts) {
      await finish(job, JOB_STATUS.failed, { lastError: error });
      return { final: true };
    }
    const backoffMs = Math.min(30_000 * 2 ** (job.attempts - 1), 15 * 60_000);
    await cols.jobs.updateOne(
      { _id: job._id, workerId },
      { $set: { status: JOB_STATUS.pending, runAfter: new Date(t.getTime() + backoffMs), lastError: error, updatedAt: t } },
    );
    return { final: false };
  }

  async function runJob(job) {
    const log = logger.child({ jobId: job._id, attempt: job.attempts });
    const started = Date.now();
    try {
      const result = await processJob(job, { final: job.attempts >= config.jobMaxAttempts });
      await finish(job, result?.skipped ? JOB_STATUS.skipped : JOB_STATUS.completed, {
        result: result ?? null,
        durationMs: Date.now() - started,
      });
      log.info('job finished', { durationMs: Date.now() - started, outcome: result?.outcome ?? null });
    } catch (err) {
      const { final } = await handleFailure(job, err);
      log.warn(final ? 'job failed permanently' : 'job failed, will retry', { err });
      if (final) await onPermanentFailure(job, err).catch((e) => log.error('failure hook error', { err: e }));
    }
  }

  /**
   * Start one worker slot if capacity allows. A slot that finds work immediately starts another
   * tick, so the pool ramps up to `workerConcurrency` only while there is a backlog; an idle queue
   * costs one cheap query per poll interval.
   */
  function tick() {
    if (!running || active >= config.workerConcurrency) return;
    active += 1;
    const p = claim()
      .then(async (job) => {
        if (!job) return false;
        tick(); // more work may be waiting — let another slot look while this one runs
        await runJob(job);
        return true;
      })
      .catch((err) => {
        logger.error('job queue error', { err });
        return false;
      })
      .then((didWork) => {
        active -= 1;
        inflight.delete(p);
        if (didWork) tick();
      });
    inflight.add(p);
  }

  /**
   * Move jobs stuck in `processing` back to `pending`. On startup every job not owned by this worker
   * is considered orphaned; afterwards only jobs locked longer than `jobStaleAfterMs`.
   */
  async function recoverStale({ startup = false } = {}) {
    const t = now();
    const stuck = startup
      ? { status: JOB_STATUS.processing, workerId: { $ne: workerId } }
      : { status: JOB_STATUS.processing, lockedAt: { $lt: new Date(t.getTime() - config.jobStaleAfterMs) } };

    const failed = await cols.jobs.updateMany(
      { ...stuck, attempts: { $gte: config.jobMaxAttempts } },
      {
        $set: {
          status: JOB_STATUS.failed,
          lastError: 'worker stopped while processing (out of attempts)',
          finishedAt: t,
          purgeAt: new Date(t.getTime() + retentionMs),
        },
      },
    );
    const requeued = await cols.jobs.updateMany(stuck, { $set: { status: JOB_STATUS.pending, runAfter: t, updatedAt: t } });
    const n = (requeued.modifiedCount ?? 0) + (failed.modifiedCount ?? 0);
    if (n) logger.warn('recovered stale jobs', { requeued: requeued.modifiedCount, failed: failed.modifiedCount });
    return { requeued: requeued.modifiedCount ?? 0, failed: failed.modifiedCount ?? 0 };
  }

  return {
    workerId,

    /** @returns {Promise<'queued'|'duplicate'|'queue_full'>} */
    async enqueue({ groupId, messageId, payload = {} }) {
      if ((await outstanding()) >= config.maxQueueSize) return 'queue_full';
      const t = now();
      try {
        await cols.jobs.insertOne({
          _id: `${groupId}:${messageId}`,
          groupId,
          messageId,
          payload,
          status: JOB_STATUS.pending,
          attempts: 0,
          runAfter: t,
          createdAt: t,
          updatedAt: t,
          lockedAt: null,
          workerId: null,
          purgeAt: null,
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) return 'duplicate';
        throw err;
      }
      tick();
      return 'queued';
    },

    async start() {
      if (running) return;
      running = true;
      await recoverStale({ startup: true });
      pollTimer = setInterval(tick, config.workerPollIntervalMs);
      staleTimer = setInterval(() => {
        recoverStale().catch((err) => logger.error('stale job recovery failed', { err }));
      }, Math.max(10_000, Math.floor(config.jobStaleAfterMs / 2)));
      pollTimer.unref?.();
      staleTimer.unref?.();
      tick();
    },

    /** Stop claiming new jobs and wait (bounded) for in-flight jobs to finish. */
    async stop({ timeoutMs = 20_000 } = {}) {
      running = false;
      clearInterval(pollTimer);
      clearInterval(staleTimer);
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    },

    recoverStale,
    outstanding,
    /** For tests: process everything currently runnable, sequentially. */
    async drain() {
      let processed = 0;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const job = await claim();
        if (!job) return processed;
        // eslint-disable-next-line no-await-in-loop
        await runJob(job);
        processed += 1;
      }
    },
  };
}
