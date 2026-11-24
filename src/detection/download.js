import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/**
 * Stream a Telegram file to disk without buffering it in memory.
 * Aborts if the file grows beyond `maxBytes` or the transfer exceeds `timeoutMs`.
 *
 * @param {{ getFileLink: (fileId: string) => Promise<URL | string> }} telegram
 */
export async function downloadTelegramFile(telegram, fileId, destPath, { maxBytes, timeoutMs = 60_000, fetchFn = fetch } = {}) {
  let url;
  try {
    url = await telegram.getFileLink(fileId);
  } catch (err) {
    const description = err?.response?.description ?? err.message;
    if (/file is too big/i.test(description)) throw new DownloadError(description, 'TOO_LARGE');
    throw new DownloadError(`getFile failed: ${description}`, 'GET_FILE_FAILED');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url.toString(), { signal: controller.signal });
    if (!res.ok || !res.body) throw new DownloadError(`download failed with HTTP ${res.status}`, 'HTTP_ERROR');
    const declared = Number(res.headers.get('content-length'));
    if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
      throw new DownloadError(`file is ${declared} bytes, limit is ${maxBytes}`, 'TOO_LARGE');
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (maxBytes && received > maxBytes) cb(new DownloadError(`file exceeded ${maxBytes} bytes`, 'TOO_LARGE'));
        else cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(destPath));
    return { bytes: received };
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    if (err?.name === 'AbortError') throw new DownloadError(`download timed out after ${timeoutMs}ms`, 'TIMEOUT');
    throw new DownloadError(`download failed: ${err.message}`, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}
