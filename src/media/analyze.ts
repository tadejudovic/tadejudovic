import { run } from "./ffmpeg.ts";
import type { Moment } from "../types.ts";

/** Resolution of the energy curve, in seconds per bin. */
export const BIN = 0.5;
const MOTION_FPS = 4;
const SAMPLE_RATE = 8000;

/**
 * Score every half second of a clip by how much is happening on screen (frame
 * difference) and how loud it is (barks, zoomies, people laughing). Cheap,
 * deterministic, and runs on any machine with ffmpeg.
 */
export async function energyCurve(file: string, duration: number, hasAudio: boolean): Promise<number[]> {
  const bins = Math.max(1, Math.ceil(duration / BIN));
  const [motion, audio] = await Promise.all([
    motionCurve(file, bins),
    hasAudio ? audioCurve(file, bins) : Promise.resolve(new Array(bins).fill(0)),
  ]);
  const curve = motion.map((m, i) => 0.65 * m + 0.35 * (audio[i] ?? 0));
  return smooth(curve).map((v) => round(v));
}

async function motionCurve(file: string, bins: number): Promise<number[]> {
  const W = 48;
  const H = 48;
  const { stdout } = await run("ffmpeg", [
    "-v", "error",
    "-i", file,
    "-an",
    "-vf", `fps=${MOTION_FPS},scale=${W}:${H},format=gray`,
    "-f", "rawvideo",
    "pipe:1",
  ]);
  const frameSize = W * H;
  const frames = Math.floor(stdout.length / frameSize);
  const sums = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  for (let f = 1; f < frames; f++) {
    let diff = 0;
    const a = (f - 1) * frameSize;
    const b = f * frameSize;
    for (let p = 0; p < frameSize; p++) diff += Math.abs(stdout[b + p] - stdout[a + p]);
    const mean = diff / frameSize / 255;
    const bin = Math.min(bins - 1, Math.floor(f / MOTION_FPS / BIN));
    sums[bin] += mean;
    counts[bin]++;
  }
  // ~0.12 mean abs difference is already a lot of motion at this scale.
  return sums.map((s, i) => clamp01((counts[i] ? s / counts[i] : 0) / 0.12));
}

async function audioCurve(file: string, bins: number): Promise<number[]> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error",
    "-i", file,
    "-vn",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ]);
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const perBin = SAMPLE_RATE * BIN;
  const out: number[] = [];
  for (let i = 0; i < bins; i++) {
    let sq = 0;
    let n = 0;
    const end = Math.min(samples.length, (i + 1) * perBin);
    for (let s = i * perBin; s < end; s++) {
      const v = samples[s] / 32768;
      sq += v * v;
      n++;
    }
    const rms = n ? Math.sqrt(sq / n) : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    // Map -50 dBFS (quiet room) .. -10 dBFS (bark at close range) to 0..1.
    out.push(clamp01((db + 50) / 40));
  }
  return out;
}

/**
 * Pick the strongest non-overlapping windows of the energy curve.
 * Returns moments sorted by score, best first.
 */
export function findMoments(curve: number[], duration: number, windowSec = 3, max = 6): Moment[] {
  if (duration <= windowSec + 0.5) {
    return [{ start: 0, end: round(duration), score: round(mean(curve)) }];
  }
  const w = Math.max(1, Math.round(windowSec / BIN));
  // Skip the first/last few bins: phone footage usually shakes as recording starts/stops.
  const margin = Math.min(1, Math.floor((curve.length - w) / 2));
  const candidates: { i: number; score: number }[] = [];
  for (let i = margin; i + w <= curve.length - margin; i++) {
    const slice = curve.slice(i, i + w);
    // Reward peaks (a bark, a jump) as well as sustained action.
    candidates.push({ i, score: 0.7 * mean(slice) + 0.3 * Math.max(...slice) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: { i: number; score: number }[] = [];
  for (const c of candidates) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p.i - c.i) >= w)) picked.push(c);
  }
  return picked.map((p) => ({
    start: round(p.i * BIN),
    end: round(Math.min(duration, (p.i + w) * BIN)),
    score: round(p.score),
  }));
}

function smooth(xs: number[]): number[] {
  return xs.map((_, i) => {
    const win = xs.slice(Math.max(0, i - 1), i + 2);
    return mean(win);
  });
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 100) / 100;
