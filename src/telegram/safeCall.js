const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function telegramErrorCode(err) {
  return err?.response?.error_code ?? err?.code;
}

export function telegramErrorDescription(err) {
  return err?.response?.description ?? err?.description ?? err?.message ?? String(err);
}

/** "Bot was blocked by the user", "chat not found", "user is deactivated", etc. */
export function isForbiddenError(err) {
  return telegramErrorCode(err) === 403;
}

export function isMessageNotModified(err) {
  return /message is not modified/i.test(telegramErrorDescription(err));
}

/**
 * Call the Telegram API with handling for flood limits (429 + retry_after) and transient
 * network / 5xx failures (exponential backoff). Other 4xx errors are thrown immediately.
 */
export async function safeCall(fn, { retries = 3, baseDelayMs = 500, maxRetryAfterSec = 60, sleepFn = sleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const code = telegramErrorCode(err);
      if (attempt >= retries) throw err;
      attempt += 1;

      if (code === 429) {
        const retryAfter = Number(err?.response?.parameters?.retry_after ?? 1);
        if (retryAfter > maxRetryAfterSec) throw err;
        await sleepFn(retryAfter * 1000 + 100);
        continue;
      }
      const transient =
        (typeof code === 'number' && code >= 500) ||
        RETRYABLE_NETWORK_CODES.has(code) ||
        RETRYABLE_NETWORK_CODES.has(err?.cause?.code) ||
        err?.name === 'FetchError' ||
        err?.name === 'AbortError';
      if (!transient) throw err;
      await sleepFn(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * Serialises outgoing notification messages with a small gap between them so that a burst of
 * approval requests does not trip Telegram's per-bot flood limits (~30 msg/s globally,
 * ~20 msg/min per group).
 */
export function createThrottle(minIntervalMs = 60, sleepFn = sleep) {
  let chain = Promise.resolve();
  let last = 0;
  return function throttle(fn) {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleepFn(wait);
      try {
        return await fn();
      } finally {
        last = Date.now();
      }
    });
    chain = run.catch(() => {});
    return run;
  };
}
