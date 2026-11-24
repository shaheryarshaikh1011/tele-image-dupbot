import { spawn } from 'node:child_process';
import { FRAME_SIZE, frameStdDev, phash } from './phash.js';

const FRAME_BYTES = FRAME_SIZE * FRAME_SIZE;
// Frames flatter than this (std-dev of 0..255 luma) are treated as "no information".
export const LOW_INFORMATION_STDDEV = 6;

/**
 * Run a binary, collecting stdout into a Buffer (bounded) and stderr as text. Never uses a shell.
 */
export function runProcess(cmd, args, { timeoutMs = 30_000, maxStdoutBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxStdoutBytes) {
        child.kill('SIGKILL');
        finish(new Error(`${cmd} produced more than ${maxStdoutBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout: Buffer.concat(chunks), stderr });
      else finish(Object.assign(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 500)}`), { exitCode: code }));
    });
  });
}

/**
 * Read container/stream metadata with ffprobe.
 * @returns {Promise<{ duration: number|null, width: number|null, height: number|null }>}
 */
export async function probeVideo(filePath, { ffprobePath = 'ffprobe', timeoutMs = 15_000 } = {}) {
  const { stdout } = await runProcess(
    ffprobePath,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration',
      '-of', 'json',
      filePath,
    ],
    { timeoutMs },
  );
  const info = JSON.parse(stdout.toString() || '{}');
  const stream = info.streams?.[0] ?? {};
  const duration = Number(stream.duration ?? info.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: stream.width ?? null,
    height: stream.height ?? null,
  };
}

/**
 * Relative sample positions: the centre of each of `count` equal segments. Avoids the very first
 * and last frames, which are often black or carry intros/outros.
 */
export function samplePositions(duration, count) {
  return Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
}

/** Decode one frame at `seconds`, scaled to 32x32 grayscale. Returns null if no frame decoded. */
export async function extractFramePixels(filePath, seconds, { ffmpegPath = 'ffmpeg', timeoutMs = 15_000 } = {}) {
  const { stdout } = await runProcess(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-threads', '1',
      '-ss', seconds.toFixed(3),
      '-i', filePath,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      '-vf', `scale=${FRAME_SIZE}:${FRAME_SIZE}:flags=area,format=gray`,
      '-f', 'rawvideo',
      'pipe:1',
    ],
    { timeoutMs, maxStdoutBytes: FRAME_BYTES * 4 },
  );
  if (stdout.length < FRAME_BYTES) return null;
  return stdout.subarray(0, FRAME_BYTES);
}

/**
 * Compute the ordered frame-hash fingerprint for a local video file.
 * Frames are decoded one at a time with fast input seeking, so memory stays tiny and the
 * whole video is never decoded.
 *
 * @returns {Promise<{ frames: (string|null)[], informativeFrames: number, duration: number|null, width: number|null, height: number|null }>}
 */
export async function fingerprintVideo(filePath, { samples = 12, knownDuration = null, ffmpegPath, ffprobePath, timeoutMs } = {}) {
  const meta = await probeVideo(filePath, { ffprobePath, timeoutMs });
  const duration = meta.duration ?? (Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration : null);
  if (!duration) throw Object.assign(new Error('Could not determine video duration'), { code: 'NO_DURATION' });

  const frames = [];
  for (const position of samplePositions(duration, samples)) {
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: bounded CPU usage
    const pixels = await extractFramePixels(filePath, position, { ffmpegPath, timeoutMs });
    if (!pixels || frameStdDev(pixels) < LOW_INFORMATION_STDDEV) frames.push(null);
    else frames.push(phash(pixels));
  }
  return {
    frames,
    informativeFrames: frames.filter(Boolean).length,
    duration,
    width: meta.width,
    height: meta.height,
  };
}
