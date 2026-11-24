#!/usr/bin/env node
/**
 * Calibrate duplicate detection against a labelled set of video pairs and measure processing time.
 *
 *   node scripts/benchmark.js pairs.json      # your own labelled pairs
 *   node scripts/benchmark.js --synthetic     # generated test videos (needs ffmpeg)
 *
 * pairs.json:
 *   [ { "a": "videos/clip.mp4", "b": "videos/clip-reupload.mp4", "duplicate": true }, ... ]
 * Paths are relative to the JSON file. Run this on the deployed Railway hardware (e.g. `railway run`)
 * to get realistic timings, then pick FRAME_SAMPLES / thresholds from the output.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { compareFrameSequences } from '../src/detection/compare.js';
import { fingerprintVideo } from '../src/detection/ffmpeg.js';
import { SENSITIVITY_PRESETS } from '../src/config.js';

const samples = Number(process.env.FRAME_SAMPLES ?? 12);
const frameMatchMaxDistance = Number(process.env.FRAME_MATCH_MAX_DISTANCE ?? 10);
const maxShift = Number(process.env.MAX_FRAME_SHIFT ?? 1);

async function loadPairs(arg) {
  if (arg === '--synthetic') {
    const { makeTestVideos } = await import('../test/helpers/videos.js');
    const v = makeTestVideos();
    return [
      { a: v.original, b: v.resized, duplicate: true },
      { a: v.original, b: v.brighter, duplicate: true },
      { a: v.original, b: v.mpeg4, duplicate: true },
      { a: v.original, b: v.different, duplicate: false },
      { a: v.original, b: v.pattern, duplicate: false },
      { a: v.different, b: v.pattern, duplicate: false },
    ];
  }
  if (!arg) {
    console.error('usage: node scripts/benchmark.js <pairs.json> | --synthetic');
    process.exit(2);
  }
  const base = path.dirname(path.resolve(arg));
  const pairs = JSON.parse(await fs.readFile(arg, 'utf8'));
  return pairs.map((p) => ({ ...p, a: path.resolve(base, p.a), b: path.resolve(base, p.b) }));
}

const pairs = await loadPairs(process.argv[2]);
const cache = new Map();
const timings = [];

async function fp(file) {
  if (!cache.has(file)) {
    const t = performance.now();
    cache.set(file, await fingerprintVideo(file, { samples }));
    timings.push({ file, ms: performance.now() - t });
  }
  return cache.get(file);
}

const rows = [];
for (const pair of pairs) {
  // eslint-disable-next-line no-await-in-loop
  const [a, b] = [await fp(pair.a), await fp(pair.b)];
  const r = compareFrameSequences(a.frames, b.frames, { frameMatchMaxDistance, maxShift });
  rows.push({ ...pair, ...r });
  console.log(
    `${pair.duplicate ? 'DUP ' : 'DIFF'}  score=${r.score.toFixed(2)}  meanDist=${r.meanDistance?.toFixed(1) ?? '-'}  frames=${r.matchedFrames}/${r.comparedFrames}${r.conclusive ? '' : ' (inconclusive)'}  ${path.basename(pair.a)} vs ${path.basename(pair.b)}`,
  );
}

console.log(`\nSettings: FRAME_SAMPLES=${samples} FRAME_MATCH_MAX_DISTANCE=${frameMatchMaxDistance} MAX_FRAME_SHIFT=${maxShift}`);
const avg = timings.reduce((s, t) => s + t.ms, 0) / Math.max(1, timings.length);
console.log(`Fingerprint time: avg ${avg.toFixed(0)} ms, max ${Math.max(...timings.map((t) => t.ms)).toFixed(0)} ms over ${timings.length} videos\n`);

for (const [name, threshold] of Object.entries(SENSITIVITY_PRESETS)) {
  const flagged = (r) => r.conclusive && r.score >= threshold;
  const tp = rows.filter((r) => r.duplicate && flagged(r)).length;
  const fpos = rows.filter((r) => !r.duplicate && flagged(r)).length;
  const fn = rows.filter((r) => r.duplicate && !flagged(r)).length;
  const precision = tp + fpos ? tp / (tp + fpos) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  console.log(`${name.padEnd(9)} (≥${threshold}): precision ${(precision * 100).toFixed(0)}%  recall ${(recall * 100).toFixed(0)}%  false positives ${fpos}`);
}
