import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'ignore' });

let cached = null;

/**
 * Generate a small labelled set of test videos (once per process):
 *  original  – synthetic moving test pattern
 *  resized   – original downscaled + heavily recompressed (should match)
 *  brighter  – original with brightness/contrast change (should match)
 *  mpeg4     – original transcoded to a different codec/container (should match)
 *  different – unrelated content, same duration (must not match)
 *  pattern   – a different but similar-looking synthetic test pattern (must not match)
 *  black     – a black video (no usable information)
 */
export function makeTestVideos() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupbot-videos-'));
  const p = (name) => path.join(dir, name);
  const dur = '6';
  ff(['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=15:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('original.mp4')]);
  ff(['-i', p('original.mp4'), '-vf', 'scale=160:120', '-c:v', 'libx264', '-crf', '38', p('resized.mp4')]);
  ff(['-i', p('original.mp4'), '-vf', 'eq=brightness=0.07:contrast=1.15', '-c:v', 'libx264', '-crf', '30', p('brighter.mp4')]);
  ff(['-i', p('original.mp4'), '-c:v', 'mpeg4', '-q:v', '10', p('mpeg4.avi')]);
  ff(['-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=15', '-t', dur, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('different.mp4')]);
  ff(['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('pattern.mp4')]);
  ff(['-f', 'lavfi', '-i', `color=c=black:size=320x240:rate=15:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p('black.mp4')]);
  fs.writeFileSync(p('not-a-video.mp4'), 'this is not a video');
  cached = {
    dir,
    original: p('original.mp4'),
    resized: p('resized.mp4'),
    brighter: p('brighter.mp4'),
    mpeg4: p('mpeg4.avi'),
    different: p('different.mp4'),
    pattern: p('pattern.mp4'),
    black: p('black.mp4'),
    garbage: p('not-a-video.mp4'),
  };
  return cached;
}
