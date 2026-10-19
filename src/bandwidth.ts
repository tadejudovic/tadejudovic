import type { Request, Response, NextFunction } from "express";
import { store } from "./store.ts";
import { localDate } from "./dailyLimit.ts";

/**
 * A cap on what the app sends out per calendar month, so the host's included bandwidth (Render: 5 GB)
 * is never exceeded: at PLAY_CAP, videos stop playing in the app (stills instead); at HARD_CAP,
 * downloads and shares stop too. Counted from the bytes of every response; resets on the 1st.
 * BANDWIDTH_GB raises the allowance on a bigger plan.
 */
const GB = 1e9;
const included = () => (Number(process.env.BANDWIDTH_GB) || 5) * GB;
export const playCap = () => included() * 0.9;
export const hardCap = () => included() * 0.98;

const month = () => localDate(new Date()).slice(0, 7);
let pending = 0;
let lastSave = Date.now();

export function bytesThisMonth(): number {
  const b = store.settings().bandwidth;
  return (b?.month === month() ? b.bytes : 0) + pending;
}

export function flushBandwidth() {
  if (!pending) return;
  const m = month();
  const b = store.settings().bandwidth;
  store.updateSettings({ bandwidth: { month: m, bytes: (b?.month === m ? b.bytes : 0) + pending } });
  pending = 0;
  lastSave = Date.now();
}

function count(n: number) {
  pending += n;
  if (Date.now() - lastSave > 30_000) flushBandwidth();
}

/** Counts the body bytes of every response. */
export function countResponses(_req: Request, res: Response, next: NextFunction) {
  const write = res.write.bind(res) as (...a: any[]) => boolean;
  const end = res.end.bind(res) as (...a: any[]) => Response;
  const size = (chunk: unknown, enc?: unknown) =>
    chunk == null || typeof chunk === "function" ? 0 : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk), typeof enc === "string" ? (enc as BufferEncoding) : "utf8");
  (res as any).write = (chunk: unknown, ...rest: unknown[]) => {
    count(size(chunk, rest[0]));
    return write(chunk, ...rest);
  };
  (res as any).end = (chunk?: unknown, ...rest: unknown[]) => {
    count(size(chunk, rest[0]));
    return end(chunk, ...rest);
  };
  next();
}

export const playbackPaused = () => bytesThisMonth() >= playCap();
export const mediaStopped = () => bytesThisMonth() >= hardCap();

export function bandwidthStatus() {
  const used = bytesThisMonth();
  return {
    usedGb: Math.round((used / GB) * 100) / 100,
    includedGb: included() / GB,
    playCapGb: Math.round((playCap() / GB) * 100) / 100,
    paused: used >= playCap(),
    stopped: used >= hardCap(),
  };
}

/** Before this counter existed, part of the month was already used (from the host's own numbers). */
export function seedBandwidth(monthKey: string, bytes: number) {
  if (month() !== monthKey) return;
  const b = store.settings().bandwidth;
  if (b?.month === monthKey && b.bytes >= bytes) return;
  store.updateSettings({ bandwidth: { month: monthKey, bytes } });
}
