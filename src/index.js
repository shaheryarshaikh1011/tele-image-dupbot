import http from 'node:http';
import { createApp } from './app.js';
import { ALLOWED_UPDATES, registerCommands } from './bot/index.js';
import { ConfigError, loadConfig } from './config.js';
import { connectMongo } from './db.js';
import { runProcess } from './detection/ffmpeg.js';
import { createLogger } from './logger.js';

async function checkFfmpeg(config, logger) {
  try {
    await runProcess(config.ffmpegPath, ['-version'], { timeoutMs: 10_000 });
    await runProcess(config.ffprobePath, ['-version'], { timeoutMs: 10_000 });
  } catch (err) {
    logger.error('ffmpeg/ffprobe not available — smart video comparison will fail (exact matching still works)', { err });
  }
}

/** Optional liveness endpoint (Railway sets PORT for services with a public/private domain). */
function startHealthServer(port, getState, logger) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      const state = getState();
      res.writeHead(state.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => logger.info('health server listening', { port }));
  return server;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel, { service: 'tele-dupbot' });

  await checkFfmpeg(config, logger);
  const mongo = await connectMongo(config, logger);
  const app = createApp({ config, cols: mongo.cols, logger });

  let polling = false;
  const health = config.port ? startHealthServer(config.port, () => ({ ok: polling, polling }), logger) : null;

  await app.startBackground();
  await registerCommands(app.bot.telegram).catch((err) => logger.warn('setMyCommands failed', { err }));

  // Long polling: one persistent worker, no public webhook needed. launch() resolves only when
  // polling stops, so don't await it here.
  app.bot
    .launch({ allowedUpdates: ALLOWED_UPDATES, dropPendingUpdates: false }, () => {
      polling = true;
      logger.info('bot started', { username: app.bot.botInfo?.username });
    })
    .catch((err) => {
      logger.error('polling stopped with error', { err });
      process.exit(1);
    });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    polling = false;
    try {
      app.bot.stop(signal);
    } catch {
      /* not running */
    }
    await app.stopBackground();
    health?.close();
    await mongo.client.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
