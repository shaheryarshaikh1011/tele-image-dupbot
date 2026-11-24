import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { approvalCallbackData } from '../src/services/approvals.js';
import { ADMIN, createHarness, MEMBER, OWNER } from './helpers/harness.js';
import { hasFfmpeg, makeTestVideos } from './helpers/videos.js';

describe('smart (visual) detection pipeline with real FFmpeg', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, () => {
  let v;
  let h;
  before(() => {
    v = makeTestVideos();
  });
  beforeEach(async () => {
    h = await createHarness({
      files: {
        orig: v.original,
        resized: v.resized,
        brighter: v.brighter,
        different: v.different,
        pattern: v.pattern,
        black: v.black,
        garbage: v.garbage,
      },
    });
    await h.setupEnabledGroup();
  });
  afterEach(() => h.close());

  test('a re-encoded, resized copy is flagged after analysis; admin can delete it', async () => {
    const original = await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    assert.equal(await h.cols.jobs.countDocuments({}), 0, 'first video: no candidates, nothing queued');
    assert.equal(h.downloads.length, 0, 'lazy: nothing downloaded yet');

    const copy = await h.postVideo(ADMIN, { fileId: 'resized', duration: 6 });
    assert.equal(await h.cols.jobs.countDocuments({ status: 'pending' }), 1);
    await h.app.services.queue.drain();

    assert.deepEqual(h.downloads.sort(), ['orig', 'resized'], 'both videos fingerprinted on demand');
    const req = await h.lastApproval();
    assert.ok(req, 'approval requested');
    assert.equal(req.detectionMethod, 'visual_similarity');
    assert.equal(req.originalMessageId, original);
    assert.equal(req.duplicateMessageId, copy);
    assert.ok(req.score >= 0.9, `score ${req.score}`);
    assert.equal(req.details.threshold, 0.75);

    const job = await h.cols.jobs.findOne({});
    assert.equal(job.status, 'completed');
    assert.equal(job.result.outcome, 'visual_match');
    assert.ok(job.purgeAt);

    await h.click(OWNER, approvalCallbackData(req._id, 'delete'));
    assert.deepEqual(h.api.state.deleted.map((d) => d.messageId), [copy]);
  });

  test('fingerprints are reused: the original is downloaded only once', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 6 });
    await h.app.services.queue.drain();
    await h.postVideo(MEMBER, { fileId: 'brighter', duration: 6 });
    await h.app.services.queue.drain();
    assert.equal(h.downloads.filter((f) => f === 'orig').length, 1);
    assert.equal(await h.cols.approvals.countDocuments({}), 2);
  });

  test('unrelated videos with the same duration are not flagged', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'different', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'pattern', duration: 6 });
    await h.app.services.queue.drain();
    assert.equal(await h.cols.approvals.countDocuments({}), 0);
    const outcomes = (await h.cols.jobs.find({}).toArray()).map((j) => j.result.outcome);
    assert.deepEqual(outcomes, ['no_match', 'no_match']);
  });

  test('videos with very different durations are never compared', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 60 });
    assert.equal(await h.cols.jobs.countDocuments({}), 0);
    assert.equal(h.downloads.length, 0);
  });

  test('video sent as a file (no duration metadata) is still compared', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', asDocument: true });
    await h.app.services.queue.drain();
    const req = await h.lastApproval();
    assert.equal(req?.detectionMethod, 'visual_similarity');
  });

  test('files over the size limit are not downloaded (exact matching only)', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 6, fileSize: 50 * 1024 * 1024 });
    assert.equal(await h.cols.jobs.countDocuments({}), 0);
    const fp = await h.cols.fingerprints.findOne({ fileId: 'resized' });
    assert.equal(fp.status, 'unavailable');
    assert.equal(fp.unavailableReason, 'too_large');
  });

  test('strict sensitivity raises the threshold', async () => {
    await h.cols.groups.updateOne({}, { $set: { 'settings.sensitivity': 'strict' } });
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 6 });
    await h.app.services.queue.drain();
    const req = await h.lastApproval();
    assert.equal(req.details.threshold, 0.9);
  });

  test('black / undecodable videos are marked unavailable instead of retried', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'black', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'garbage', duration: 6 });
    await h.app.services.queue.drain();
    const jobs = await h.cols.jobs.find({}).sort({ createdAt: 1 }).toArray();
    assert.deepEqual(jobs.map((j) => j.status), ['completed', 'completed']);
    assert.equal(jobs[0].result.outcome, 'not_enough_information');
    assert.equal(jobs[1].result.outcome, 'unavailable');
    assert.equal(await h.cols.approvals.countDocuments({}), 0);
  });

  test('temporary files are cleaned up after processing and after failures', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'garbage', duration: 6 });
    await h.app.services.queue.drain();
    const left = await fs.readdir(h.tempDir).catch(() => []);
    assert.deepEqual(left, []);
  });

  test('jobs queued before /disable are skipped (no backlog processing)', async () => {
    await h.postVideo(MEMBER, { fileId: 'orig', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'resized', duration: 6 });
    await h.groupCommand(OWNER, '/disable');
    await h.app.services.queue.drain();
    const job = await h.cols.jobs.findOne({});
    assert.equal(job.status, 'skipped');
    assert.equal(h.downloads.length, 0);
  });
});

describe('job queue reliability', () => {
  let h;
  after(() => {});
  beforeEach(async () => {
    h = await createHarness({ env: { JOB_MAX_ATTEMPTS: '2', MAX_QUEUE_SIZE: '2' } });
    await h.setupEnabledGroup();
  });
  afterEach(() => h.close());

  test('transient failures are retried with backoff, then fail permanently with an audit entry', async () => {
    // No fixture for these file ids → download throws a NETWORK error (transient).
    await h.postVideo(MEMBER, { fileId: 'missing1', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'missing2', duration: 6 });
    const q = h.app.services.queue;
    await q.drain();
    let job = await h.cols.jobs.findOne({});
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.ok(new Date(job.runAfter) > new Date(), 'backoff scheduled');
    assert.match(job.lastError, /no fixture/);

    await h.cols.jobs.updateOne({ _id: job._id }, { $set: { runAfter: new Date(0) } });
    await q.drain();
    job = await h.cols.jobs.findOne({});
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 2);
    assert.ok(await h.cols.audit.findOne({ type: 'analysis_failed' }));
  });

  test('jobs stuck in processing after a restart are re-queued', async () => {
    const t = new Date(Date.now() - 60 * 60_000);
    await h.cols.jobs.insertOne({ _id: 'g:1', groupId: -1, messageId: 1, status: 'processing', attempts: 1, lockedAt: t, workerId: 'dead', runAfter: t, createdAt: t });
    await h.cols.jobs.insertOne({ _id: 'g:2', groupId: -1, messageId: 2, status: 'processing', attempts: 2, lockedAt: t, workerId: 'dead', runAfter: t, createdAt: t });
    const r = await h.app.services.queue.recoverStale({ startup: true });
    assert.deepEqual(r, { requeued: 1, failed: 1 });
    assert.equal((await h.cols.jobs.findOne({ _id: 'g:1' })).status, 'pending');
    assert.equal((await h.cols.jobs.findOne({ _id: 'g:2' })).status, 'failed');
  });

  test('periodic recovery only touches jobs locked longer than the stale window', async () => {
    const fresh = new Date();
    await h.cols.jobs.insertOne({ _id: 'g:3', groupId: -1, messageId: 3, status: 'processing', attempts: 1, lockedAt: fresh, workerId: 'other', runAfter: fresh, createdAt: fresh });
    const r = await h.app.services.queue.recoverStale();
    assert.deepEqual(r, { requeued: 0, failed: 0 });
  });

  test('the queue is bounded', async () => {
    const q = h.app.services.queue;
    assert.equal(await q.enqueue({ groupId: -1, messageId: 1 }), 'queued');
    assert.equal(await q.enqueue({ groupId: -1, messageId: 1 }), 'duplicate');
    assert.equal(await q.enqueue({ groupId: -1, messageId: 2 }), 'queued');
    assert.equal(await q.enqueue({ groupId: -1, messageId: 3 }), 'queue_full');
  });

  test('background worker processes queued jobs on its own', async () => {
    await h.app.startBackground();
    await h.postVideo(MEMBER, { fileId: 'missing1', duration: 6 });
    await h.postVideo(MEMBER, { fileId: 'missing2', duration: 6 });
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const job = await h.cols.jobs.findOne({});
      if (job?.attempts >= 1 && job.status !== 'processing') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    const job = await h.cols.jobs.findOne({});
    assert.equal(job.attempts, 1);
    await h.app.stopBackground();
  });
});
