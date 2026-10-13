import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";

/**
 * Password gate for running PawCut on the public internet.
 *
 * Set APP_PASSWORD and every page, API call and media file requires a signed
 * session cookie, which /login issues after the right password. Without
 * APP_PASSWORD the gate is off (fine for localhost only; the server refuses to
 * listen publicly without it).
 */

const COOKIE = "pawcut_session";
const SESSION_DAYS = 30;
const password = process.env.APP_PASSWORD ?? "";
export const gateEnabled = password.length > 0;

/** Secret for signing sessions: SESSION_SECRET, or one generated once and kept in the data dir. */
function sessionSecret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  const file = path.join(config.dataDir, ".session-secret");
  try {
    return fs.readFileSync(file);
  } catch {
    const secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const secret = gateEnabled ? sessionSecret() : Buffer.alloc(0);

// Changing APP_PASSWORD signs everyone out.
const passwordTag = crypto.createHash("sha256").update(password).digest("hex").slice(0, 16);

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueToken(): string {
  const payload = `${Date.now() + SESSION_DAYS * 86400_000}.${passwordTag}`;
  return `${payload}.${sign(payload)}`;
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return false;
  const [expires, tag] = payload.split(".");
  return tag === passwordTag && Number(expires) > Date.now();
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

function passwordMatches(attempt: string): boolean {
  const a = crypto.createHash("sha256").update(attempt).digest();
  const b = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple per-IP throttle: 10 failed attempts per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
function throttled(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.count >= 10 && f.until > Date.now();
}
function recordFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else f.count++;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!gateEnabled) return next();
  if (req.path === "/login" || req.path === "/logout") return next();
  if (validToken(readCookie(req, COOKIE))) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return res.status(401).json({ error: "Signed out" });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

const safeNext = (n: unknown) => (typeof n === "string" && /^\/(?!\/)/.test(n) ? n : "/");

export function loginPage(req: Request, res: Response) {
  if (!gateEnabled) return res.redirect("/");
  const error = req.query.error === "1" ? "Wrong password." : req.query.error === "wait" ? "Too many attempts — try again in 15 minutes." : "";
  const next = safeNext(req.query.next);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PawCut · sign in</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1b18;--muted:#6d6a64;--line:#e6e3dd;--accent:#fe2c55;--err:#c62f2f}
@media (prefers-color-scheme:dark){:root{--bg:#111012;--panel:#1b1a1d;--ink:#f1efea;--muted:#a19d96;--line:#2d2b30;--err:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px 24px;width:100%;max-width:340px;display:grid;gap:12px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--muted);font-size:13px}.err{color:var(--err)}
input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px;background:var(--accent);color:#fff;cursor:pointer}
</style></head><body>
<form method="post" action="/login">
<h1>🐾 PawCut</h1><p>Private studio. Enter the password to continue.</p>
${error ? `<p class="err">${error}</p>` : ""}
<input type="password" name="password" autocomplete="current-password" placeholder="Password" autofocus required>
<input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
<button type="submit">Sign in</button>
</form></body></html>`);
}

export function login(req: Request, res: Response) {
  if (!gateEnabled) return res.redirect("/");
  const ip = req.ip ?? "unknown";
  if (throttled(ip)) return res.redirect("/login?error=wait");
  const next = safeNext(req.body?.next);
  if (!passwordMatches(String(req.body?.password ?? ""))) {
    recordFailure(ip);
    return res.redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  failures.delete(ip);
  res.cookie(COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400_000,
    path: "/",
  });
  res.redirect(next);
}

export function logout(_req: Request, res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
  res.redirect("/login");
}
