import { hammingDistance } from './phash.js';

/**
 * Compare two ordered sequences of frame hashes sampled at the same relative positions of
 * each video (see ffmpeg.js `samplePositions`). Entries may be `null` for frames that carried
 * too little information (black screens, fades) — those are skipped.
 *
 * Order matters: frame i of A is only compared with frame i (± a small shift) of B, so two
 * unrelated videos that merely share some similar-looking scenes do not score highly.
 *
 * @param {(string|null)[]} a
 * @param {(string|null)[]} b
 * @param {{ frameMatchMaxDistance?: number, maxShift?: number, minComparableFrames?: number }} [opts]
 */
export function compareFrameSequences(a, b, opts = {}) {
  const { frameMatchMaxDistance = 10, maxShift = 1, minComparableFrames } = opts;
  const minFrames = minComparableFrames ?? Math.max(3, Math.ceil(Math.min(a.length, b.length) / 2));

  let best = null;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    let compared = 0;
    let matched = 0;
    let distanceSum = 0;
    for (let i = 0; i < a.length; i += 1) {
      const j = i + shift;
      if (j < 0 || j >= b.length) continue;
      if (!a[i] || !b[j]) continue;
      const d = hammingDistance(a[i], b[j]);
      compared += 1;
      distanceSum += d;
      if (d <= frameMatchMaxDistance) matched += 1;
    }
    if (compared === 0) continue;
    const candidate = {
      shift,
      comparedFrames: compared,
      matchedFrames: matched,
      meanDistance: distanceSum / compared,
      score: matched / compared,
    };
    // Unshifted alignment wins ties; shifted alignments must be strictly better.
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.meanDistance < best.meanDistance)
    ) {
      best = candidate;
    }
  }

  if (!best) {
    return { conclusive: false, score: 0, comparedFrames: 0, matchedFrames: 0, meanDistance: null, shift: 0 };
  }
  return { ...best, conclusive: best.comparedFrames >= minFrames };
}

/**
 * Whether `candidateDuration` is close enough to `duration` to be worth an expensive comparison.
 */
export function durationsCompatible(duration, candidateDuration, { toleranceSec = 2, tolerancePct = 0.05 } = {}) {
  if (!Number.isFinite(duration) || !Number.isFinite(candidateDuration)) return true; // unknown → can't exclude
  const allowed = Math.max(toleranceSec, duration * tolerancePct);
  return Math.abs(duration - candidateDuration) <= allowed;
}

export function durationWindow(duration, { toleranceSec = 2, tolerancePct = 0.05 } = {}) {
  const allowed = Math.max(toleranceSec, duration * tolerancePct);
  return { min: Math.max(0, duration - allowed), max: duration + allowed };
}
