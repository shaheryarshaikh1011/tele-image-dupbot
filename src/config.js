import os from 'node:os';
import path from 'node:path';

/**
 * Configuration is read from environment variables only (Railway injects them).
 * Secrets (BOT_TOKEN, MONGODB_URI) must never be committed to source control.
 */

const SENSITIVITY_PRESETS = Object.freeze({
  // minimum fraction of comparable frames that must match for a "suspected duplicate"
  strict: 0.9,
  balanced: 0.75,
  lenient: 0.6,
});

function readInt(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readFloat(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Build and validate the configuration object.
 * @param {Record<string, string | undefined>} env
 * @param {{ requireSecrets?: boolean }} [options]
 */
export function loadConfig(env = process.env, { requireSecrets = true } = {}) {
  const missing = [];
  if (requireSecrets) {
    if (!env.BOT_TOKEN) missing.push('BOT_TOKEN');
    if (!env.MONGODB_URI) missing.push('MONGODB_URI');
  }
  if (missing.length) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const config = {
    botToken: env.BOT_TOKEN ?? '',
    mongoUri: env.MONGODB_URI ?? '',
    mongoDbName: env.MONGODB_DB || 'tele_dupbot',
    logLevel: env.LOG_LEVEL || 'info',
    port: env.PORT ? readInt(env, 'PORT', 0, { min: 1, max: 65535 }) : null,

    // Media processing limits. Telegram's Bot API only lets bots download files up to 20 MB.
    maxVideoSizeMb: readFloat(env, 'MAX_VIDEO_SIZE_MB', 20, { min: 1, max: 2000 }),
    maxVideoDurationSec: readInt(env, 'MAX_VIDEO_DURATION_SEC', 600, { min: 1, max: 86400 }),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    ffmpegTimeoutMs: readInt(env, 'FFMPEG_TIMEOUT_MS', 30_000, { min: 1000 }),
    downloadTimeoutMs: readInt(env, 'DOWNLOAD_TIMEOUT_MS', 60_000, { min: 1000 }),
    tempDir: env.TEMP_DIR || path.join(os.tmpdir(), 'tele-dupbot'),

    // Fingerprinting / matching
    frameSamples: readInt(env, 'FRAME_SAMPLES', 12, { min: 4, max: 64 }),
    frameMatchMaxDistance: readInt(env, 'FRAME_MATCH_MAX_DISTANCE', 10, { min: 0, max: 32 }),
    maxFrameShift: readInt(env, 'MAX_FRAME_SHIFT', 1, { min: 0, max: 8 }),
    durationToleranceSec: readFloat(env, 'DURATION_TOLERANCE_SEC', 2, { min: 0 }),
    durationTolerancePct: readFloat(env, 'DURATION_TOLERANCE_PCT', 0.05, { min: 0, max: 1 }),
    maxCandidates: readInt(env, 'MAX_CANDIDATES', 8, { min: 1, max: 100 }),

    // Queue / reliability
    workerConcurrency: readInt(env, 'WORKER_CONCURRENCY', 1, { min: 1, max: 16 }),
    maxQueueSize: readInt(env, 'MAX_QUEUE_SIZE', 200, { min: 1 }),
    jobMaxAttempts: readInt(env, 'JOB_MAX_ATTEMPTS', 3, { min: 1, max: 20 }),
    jobStaleAfterMs: readInt(env, 'JOB_STALE_AFTER_MS', 10 * 60_000, { min: 10_000 }),
    workerPollIntervalMs: readInt(env, 'WORKER_POLL_INTERVAL_MS', 5_000, { min: 100 }),

    // Approval workflow
    approvalTtlMs: Math.round(readFloat(env, 'APPROVAL_TTL_HOURS', 5, { min: 0.01, max: 168 }) * 3_600_000),
    expirySweepIntervalMs: readInt(env, 'EXPIRY_SWEEP_INTERVAL_MS', 60_000, { min: 1000 }),
    // How long resolved/expired approval requests and finished jobs are kept before Mongo TTL removes them.
    recordRetentionDays: readInt(env, 'RECORD_RETENTION_DAYS', 30, { min: 1 }),

    sensitivityPresets: SENSITIVITY_PRESETS,
  };

  return Object.freeze(config);
}

export { SENSITIVITY_PRESETS };
