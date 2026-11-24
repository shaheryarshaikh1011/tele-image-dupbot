import { MongoClient } from 'mongodb';

export const COLLECTIONS = Object.freeze({
  groups: 'groups',
  users: 'users',
  fingerprints: 'media_fingerprints',
  approvals: 'approval_requests',
  jobs: 'processing_jobs',
  audit: 'audit_logs',
});

/**
 * Wrap a Mongo `Db` (or a compatible fake in tests) into named collection handles.
 * @param {import('mongodb').Db} db
 */
export function collectionsFor(db) {
  return {
    groups: db.collection(COLLECTIONS.groups),
    users: db.collection(COLLECTIONS.users),
    fingerprints: db.collection(COLLECTIONS.fingerprints),
    approvals: db.collection(COLLECTIONS.approvals),
    jobs: db.collection(COLLECTIONS.jobs),
    audit: db.collection(COLLECTIONS.audit),
  };
}

/**
 * Create the indexes the application relies on. Idempotent.
 *
 * Retention notes (see plan §6):
 *  - approval_requests and processing_jobs carry a `purgeAt` field that is only set once a record
 *    reaches a terminal state; a TTL index removes them afterwards.
 *  - media_fingerprints and audit_logs deliberately have NO TTL index: their retention policy is
 *    still an open decision and must be configured explicitly.
 */
export async function ensureIndexes(cols) {
  await Promise.all([
    cols.groups.createIndex({ enabled: 1 }),

    cols.fingerprints.createIndex({ groupId: 1, messageId: 1 }, { unique: true }),
    cols.fingerprints.createIndex({ groupId: 1, fileUniqueId: 1 }),
    cols.fingerprints.createIndex({ groupId: 1, duration: 1 }),

    cols.approvals.createIndex({ groupId: 1, duplicateMessageId: 1 }, { unique: true }),
    cols.approvals.createIndex({ status: 1, expiresAt: 1 }),
    cols.approvals.createIndex({ groupId: 1, createdAt: -1 }),
    cols.approvals.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),

    cols.jobs.createIndex({ groupId: 1, messageId: 1 }, { unique: true }),
    cols.jobs.createIndex({ status: 1, runAfter: 1, createdAt: 1 }),
    cols.jobs.createIndex({ status: 1, lockedAt: 1 }),
    cols.jobs.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),

    cols.audit.createIndex({ groupId: 1, createdAt: -1 }),
  ]);
}

export async function connectMongo(config, logger) {
  const client = new MongoClient(config.mongoUri, {
    appName: 'tele-dupbot',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 15_000,
  });
  await client.connect();
  const db = client.db(config.mongoDbName);
  const cols = collectionsFor(db);
  await ensureIndexes(cols);
  logger.info('mongo connected', { db: config.mongoDbName });
  return { client, db, cols };
}

/** True if the error is a Mongo duplicate-key error (E11000). */
export function isDuplicateKeyError(err) {
  return err?.code === 11000;
}
