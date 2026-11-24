const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    code: err.code ?? err.response?.error_code,
    description: err.response?.description,
    stack: err.stack?.split('\n').slice(0, 6).join('\n'),
  };
}

/**
 * Minimal structured (JSON-lines) logger. Railway captures stdout/stderr.
 */
export function createLogger(level = 'info', bindings = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...bindings };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        entry[key] = key === 'err' ? serializeError(value) : value;
      }
    }
    const line = JSON.stringify(entry);
    if (LEVELS[lvl] >= LEVELS.warn) process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

export const silentLogger = createLogger('silent');
