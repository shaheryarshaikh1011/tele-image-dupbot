import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { compareFrameSequences, durationsCompatible } from '../src/detection/compare.js';
import { extractVideo } from '../src/detection/detector.js';
import { fingerprintVideo, samplePositions } from '../src/detection/ffmpeg.js';
import { hammingDistance, phash } from '../src/detection/phash.js';
import { hasFfmpeg, makeTestVideos } from './helpers/videos.js';

describe('phash / hamming', () => {
  // 2-D texture (a pure 1-D gradient has near-zero DCT terms and is a poor fixture)
  const gradient = Uint8Array.from({ length: 1024 }, (_, i) => {
    const x = i % 32;
    const y = Math.floor(i / 32);
    return Math.round(127 + 60 * Math.sin(x / 4) + 60 * Math.cos(y / 5));
  });
  const noisy = Uint8Array.from(gradient, (v, i) => Math.min(255, Math.max(0, v + ((i * 7) % 7) - 3)));
  const inverted = Uint8Array.from(gradient, (v) => 255 - v);

  test('produces 64-bit hex hashes and is stable', () => {
    assert.match(phash(gradient), /^[0-9a-f]{16}$/);
    assert.equal(phash(gradient), phash(Uint8Array.from(gradient)));
  });

  test('is robust to small pixel noise but separates different images', () => {
    assert.ok(hammingDistance(phash(gradient), phash(noisy)) <= 4);
    assert.ok(hammingDistance(phash(gradient), phash(inverted)) >= 20);
  });

  test('hamming distance', () => {
    assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
    assert.equal(hammingDistance('00000000000000f0', '0000000000000000'), 4);
  });

  test('rejects wrong frame sizes', () => {
    assert.throws(() => phash(new Uint8Array(10)));
  });
});

describe('compareFrameSequences', () => {
  const a = ['0000000000000000', 'ffffffffffffffff', '00000000ffffffff', 'ffffffff00000000', '0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'];

  test('identical sequences score 1 and are conclusive', () => {
    const r = compareFrameSequences(a, a);
    assert.equal(r.score, 1);
    assert.equal(r.shift, 0);
    assert.ok(r.conclusive);
  });

  test('frame order matters: shuffled frames do not match', () => {
    const shuffled = [a[3], a[5], a[0], a[4], a[1], a[2]];
    const r = compareFrameSequences(a, shuffled, { maxShift: 0 });
    assert.ok(r.score < 0.5, `score ${r.score}`);
  });

  test('small shift is tolerated', () => {
    const shifted = ['1111111111111111', ...a.slice(0, 5)];
    const r = compareFrameSequences(a, shifted, { maxShift: 1 });
    assert.equal(r.shift, 1);
    assert.equal(r.score, 1);
  });

  test('null (low-information) frames are skipped; too few comparable frames is inconclusive', () => {
    const sparse = [a[0], null, null, null, null, a[5]];
    const r = compareFrameSequences(a, sparse, { maxShift: 0 });
    assert.equal(r.comparedFrames, 2);
    assert.equal(r.conclusive, false);
    const none = compareFrameSequences([null, null], [null, null]);
    assert.equal(none.conclusive, false);
    assert.equal(none.score, 0);
  });

  test('durationsCompatible', () => {
    assert.ok(durationsCompatible(60, 61));
    assert.ok(durationsCompatible(100, 104.5)); // 5% of 100
    assert.ok(!durationsCompatible(60, 70));
    assert.ok(durationsCompatible(null, 70)); // unknown cannot exclude
  });

  test('samplePositions are centred and ordered', () => {
    assert.deepEqual(samplePositions(10, 4), [1.25, 3.75, 6.25, 8.75]);
  });
});

describe('extractVideo', () => {
  test('native video', () => {
    const v = extractVideo({ video: { file_id: 'f', file_unique_id: 'u', duration: 5, width: 1, height: 2, file_size: 3 } });
    assert.equal(v.kind, 'video');
    assert.equal(v.duration, 5);
  });
  test('video sent as a file', () => {
    assert.equal(extractVideo({ document: { file_id: 'f', file_unique_id: 'u', mime_type: 'video/webm' } }).kind, 'document');
  });
  test('ignores other media (video-only MVP)', () => {
    assert.equal(extractVideo({ document: { file_id: 'f', file_unique_id: 'u', mime_type: 'application/pdf' } }), null);
    assert.equal(extractVideo({ photo: [{ file_id: 'p' }] }), null);
    assert.equal(extractVideo({ animation: { file_id: 'a' } }), null);
    assert.equal(extractVideo({ text: 'hi' }), null);
  });
});

describe('fingerprintVideo with real FFmpeg', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, () => {
  let v;
  const fp = {};
  before(async () => {
    v = makeTestVideos();
    for (const name of ['original', 'resized', 'brighter', 'mpeg4', 'different', 'pattern', 'black']) {
      // eslint-disable-next-line no-await-in-loop
      fp[name] = await fingerprintVideo(v[name], { samples: 10 });
    }
  });

  test('reads duration and dimensions', () => {
    assert.ok(Math.abs(fp.original.duration - 6) < 0.2);
    assert.equal(fp.original.width, 320);
    assert.equal(fp.resized.width, 160);
    assert.equal(fp.original.frames.length, 10);
    assert.equal(fp.original.informativeFrames, 10);
  });

  for (const copy of ['resized', 'brighter', 'mpeg4']) {
    test(`re-encoded copy (${copy}) matches the original`, () => {
      const r = compareFrameSequences(fp.original.frames, fp[copy].frames);
      assert.ok(r.conclusive);
      // Must clear the default ("balanced") threshold; lossy transcodes may fall below "strict".
      assert.ok(r.score >= 0.75, `score ${r.score}, mean distance ${r.meanDistance}`);
    });
  }

  for (const other of ['different', 'pattern']) {
    test(`unrelated video (${other}) does not match`, () => {
      const r = compareFrameSequences(fp.original.frames, fp[other].frames);
      assert.ok(r.score <= 0.2, `score ${r.score}, mean distance ${r.meanDistance}`);
    });
  }

  test('black video has no informative frames', () => {
    assert.equal(fp.black.informativeFrames, 0);
    assert.equal(compareFrameSequences(fp.black.frames, fp.black.frames).conclusive, false);
  });

  test('non-video input fails cleanly', async () => {
    await assert.rejects(fingerprintVideo(v.garbage, { samples: 4 }));
  });
});
