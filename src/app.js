import fs from 'node:fs/promises';
import { createBot } from './bot/index.js';
import { createDetector } from './detection/detector.js';
import { createApprovalService } from './services/approvals.js';
import { createAuditService } from './services/audit.js';
import { createFingerprintService } from './services/fingerprints.js';
import { createGroupService } from './services/groups.js';
import { createJobQueue } from './services/jobs.js';
import { createStatsService } from './services/stats.js';
import { createUserService } from './services/users.js';
import { createThrottle } from './telegram/safeCall.js';

/**
 * Compose the application from its parts. Kept free of process-level concerns (signals, env,
 * network listeners) so tests can build a full app against fakes.
 *
 * @param {object} opts
 * @param {*} opts.config
 * @param {*} opts.cols         collection handles (see db.js collectionsFor)
 * @param {*} opts.logger
 * @param {object} [opts.telegrafOptions]
 * @param {object} [opts.overrides] test seams: fingerprintVideo, download
 */
export function createApp({ config, cols, logger, telegrafOptions, overrides = {} }) {
  // The bot owns the Telegram client; services receive it lazily so tests can swap the transport.
  let bot;
  const telegram = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const value = bot.telegram[prop];
        return typeof value === 'function' ? value.bind(bot.telegram) : value;
      },
    },
  );

  const audit = createAuditService({ cols, logger });
  const users = createUserService({ cols });
  const groups = createGroupService({ cols });
  const fingerprints = createFingerprintService({ cols, config });
  const stats = createStatsService({ cols });
  const approvals = createApprovalService({
    cols,
    telegram,
    config,
    logger: logger.child({ component: 'approvals' }),
    audit,
    users,
    fingerprints,
    throttle: overrides.throttle ?? createThrottle(60),
  });
  const detector = createDetector({
    config,
    logger: logger.child({ component: 'detector' }),
    telegram,
    groups,
    fingerprints,
    approvals,
    audit,
    ...(overrides.fingerprintVideo ? { fingerprintVideo: overrides.fingerprintVideo } : {}),
    ...(overrides.download ? { download: overrides.download } : {}),
  });
  const queue = createJobQueue({
    cols,
    config,
    logger: logger.child({ component: 'queue' }),
    processJob: (job) => detector.processJob(job),
    onPermanentFailure: (job, err) => detector.recordFailure(job, err),
  });

  bot = createBot({
    token: config.botToken,
    telegrafOptions,
    services: { groups, users, approvals, audit, stats, detector, queue },
    config,
    logger: logger.child({ component: 'bot' }),
  });

  let expiryTimer = null;

  return {
    bot,
    services: { audit, users, groups, fingerprints, stats, approvals, detector, queue },

    /** Start background work: job worker + approval expiry sweeper. */
    async startBackground() {
      // Leftover temp media from a previous crash.
      await fs.rm(config.tempDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(config.tempDir, { recursive: true });
      await queue.start();
      const sweep = () =>
        approvals.expireDue().catch((err) => logger.error('approval expiry sweep failed', { err }));
      await sweep();
      expiryTimer = setInterval(sweep, config.expirySweepIntervalMs);
      expiryTimer.unref?.();
    },

    async stopBackground() {
      clearInterval(expiryTimer);
      await queue.stop();
    },
  };
}
