/**
 * Perceptual hashing for single video frames.
 *
 * Frames are delivered by FFmpeg already downscaled to 32x32 8-bit grayscale. We compute a
 * classic DCT-based pHash: 2D DCT-II, keep the 8x8 lowest-frequency block, and set each bit
 * by comparing a coefficient against the block median (DC term excluded from the median).
 * This is robust to re-encoding, resizing, mild colour/brightness changes and compression.
 */

export const FRAME_SIZE = 32;
const HASH_SIZE = 8;

// Precomputed DCT basis: COS[u][x] = cos(((2x + 1) * u * PI) / (2N))
const COS = Array.from({ length: HASH_SIZE }, (_, u) =>
  Float64Array.from({ length: FRAME_SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * FRAME_SIZE))),
);

/** Standard deviation of pixel values; very flat frames (black/white/fades) carry no identity. */
export function frameStdDev(pixels) {
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    sum += pixels[i];
    sumSq += pixels[i] * pixels[i];
  }
  const mean = sum / pixels.length;
  return Math.sqrt(Math.max(0, sumSq / pixels.length - mean * mean));
}

/**
 * @param {Uint8Array | Buffer} pixels 32*32 grayscale pixels, row-major
 * @returns {string} 16 hex chars (64 bits)
 */
export function phash(pixels) {
  if (pixels.length !== FRAME_SIZE * FRAME_SIZE) {
    throw new Error(`phash expects ${FRAME_SIZE * FRAME_SIZE} pixels, got ${pixels.length}`);
  }
  // Separable DCT restricted to the first 8 frequencies in each dimension.
  const rows = new Float64Array(FRAME_SIZE * HASH_SIZE); // [y][u]
  for (let y = 0; y < FRAME_SIZE; y += 1) {
    const rowOffset = y * FRAME_SIZE;
    for (let u = 0; u < HASH_SIZE; u += 1) {
      const basis = COS[u];
      let acc = 0;
      for (let x = 0; x < FRAME_SIZE; x += 1) acc += pixels[rowOffset + x] * basis[x];
      rows[y * HASH_SIZE + u] = acc;
    }
  }
  const coeffs = new Float64Array(HASH_SIZE * HASH_SIZE); // [v][u]
  for (let v = 0; v < HASH_SIZE; v += 1) {
    const basis = COS[v];
    for (let u = 0; u < HASH_SIZE; u += 1) {
      let acc = 0;
      for (let y = 0; y < FRAME_SIZE; y += 1) acc += rows[y * HASH_SIZE + u] * basis[y];
      coeffs[v * HASH_SIZE + u] = acc;
    }
  }

  const acs = Array.from(coeffs.subarray(1)).sort((a, b) => a - b);
  const median = (acs[(acs.length - 1) >> 1] + acs[acs.length >> 1]) / 2;

  let hash = 0n;
  for (let i = 0; i < coeffs.length; i += 1) {
    hash = (hash << 1n) | (coeffs[i] > median ? 1n : 0n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Hamming distance between two 64-bit hex hashes. */
export function hammingDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}
