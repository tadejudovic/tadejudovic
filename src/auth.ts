import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { landingHtml } from "./landing.ts";

/**
 * Sign-in gate for running Rollcut on the public internet.
 *
 * Google sign-in (preferred): set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
 * ALLOWED_EMAILS (comma-separated). Only those Google accounts get in, and the
 * password login is switched off.
 *
 * Password (fallback): set APP_PASSWORD.
 *
 * Either way every page, API call and media file needs a signed session cookie.
 * Without either the gate is off (fine for localhost only; the server refuses to
 * listen publicly without it).
 */

const COOKIE = "pawcut_session";
const SESSION_DAYS = 30;
const password = process.env.APP_PASSWORD ?? "";
export const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
  .split(/[\s,;]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes("@"));
export const googleLogin = Boolean(config.google.clientId && config.google.clientSecret && allowedEmails.length);
const passwordLogin = !googleLogin && password.length > 0;
export const gateEnabled = googleLogin || passwordLogin;

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

// Changing APP_PASSWORD (or switching to Google sign-in) signs everyone out.
const passwordTag = crypto.createHash("sha256").update(googleLogin ? "google" : password).digest("hex").slice(0, 16);

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A session for `who`: the Google email, or "-" for a password login. */
function issueToken(who = "-"): string {
  const payload = `${Date.now() + SESSION_DAYS * 86400_000}.${passwordTag}.${Buffer.from(who).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

/** The signed-in person ("-" for a password session), or null if the cookie isn't a valid session. */
function sessionOf(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  const [expires, tag, who64] = payload.split(".");
  if (tag !== passwordTag || !(Number(expires) > Date.now())) return null;
  const who = who64 ? Buffer.from(who64, "base64url").toString() : "-";
  // Removing someone from ALLOWED_EMAILS locks them out right away, even with a live session.
  if (googleLogin && !allowedEmails.includes(who)) return null;
  return who;
}

/** Email of whoever is signed in (for the app's "signed in as"). */
export function signedInAs(req: Request): string | undefined {
  const who = sessionOf(readCookie(req, COOKIE));
  return who && who !== "-" ? who : undefined;
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
  if (["/login", "/logout", "/login/google", "/login/google/callback", "/landing"].includes(req.path)) return next();
  if (sessionOf(readCookie(req, COOKIE))) return next();
  // Signed-out visitors to the home page get the public landing page.
  if (req.path === "/" && req.method === "GET") return sendLanding(res);
  if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return res.status(401).json({ error: "Signed out" });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

const safeNext = (n: unknown) => (typeof n === "string" && /^\/(?!\/)/.test(n) ? n : "/");

export function loginPage(req: Request, res: Response) {
  if (!gateEnabled) return res.redirect("/");
  const errors: Record<string, string> = {
    "1": "Wrong password.",
    wait: "Too many attempts — try again in 15 minutes.",
    denied: `${typeof req.query.email === "string" ? req.query.email.slice(0, 120) : "That account"} doesn't have access to Rollcut.`,
    google: "Google sign-in didn't work. Try again.",
  };
  const error = errors[String(req.query.error ?? "")] ?? "";
  const next = safeNext(req.query.next);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollcut · sign in</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f7f7f8;--panel:#fff;--ink:#18181b;--muted:#71717a;--line:#e9e9ec;--accent:#fe2c55;--err:#dc2626;color-scheme:light}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px 26px;box-shadow:0 1px 2px rgba(0,0,0,.04);width:100%;max-width:340px;display:grid;gap:12px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--muted);font-size:13px}.err{color:var(--err)}
input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px;background:var(--accent);color:#fff;cursor:pointer}
button.google{display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;color:var(--ink);border:1px solid #d4d4d8;padding:11px}
</style></head><body>
${
  googleLogin
    ? `<form method="get" action="/login/google">
<h1>Rollcut</h1><p>Sign in with your Google account. Only invited accounts can get in.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit" class="google"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</button>
</form>`
    : `<form method="post" action="/login">
<h1>Rollcut</h1><p>Enter the password to continue.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<input type="password" name="password" autocomplete="current-password" placeholder="Password" autofocus required>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Sign in</button>
</form>`
}</body></html>`);
}

export function login(req: Request, res: Response) {
  if (!passwordLogin) return res.redirect("/login");
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

export function sendLanding(res: Response) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(landingHtml({ signInUrl: googleLogin ? "/login/google" : "/login", google: googleLogin }));
}

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- Google sign-in ------------------------------------------------------------

const STATE_COOKIE = "rollcut_oauth";
/** The address Google sends people back to: the one they're actually using (studio.… or the onrender.com one). */
const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;
const callbackUrl = (req: Request) => `${origin(req)}/login/google/callback`;

export function googleStart(req: Request, res: Response) {
  if (!googleLogin) return res.redirect("/login");
  const state = crypto.randomBytes(16).toString("base64url");
  const next = safeNext(req.query.next);
  res.cookie(STATE_COOKIE, `${state}.${Buffer.from(next).toString("base64url")}`, {
    httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 10 * 60_000, path: "/",
  });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: callbackUrl(req),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

export async function googleCallback(req: Request, res: Response) {
  if (!googleLogin) return res.redirect("/login");
  const [state, next64] = (readCookie(req, STATE_COOKIE) ?? "").split(".");
  res.clearCookie(STATE_COOKIE, { path: "/" });
  const next = safeNext(next64 ? Buffer.from(next64, "base64url").toString() : "/");
  if (!state || req.query.state !== state || typeof req.query.code !== "string") return res.redirect("/login?error=google");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: callbackUrl(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    // The ID token came straight from Google's token endpoint over TLS, so its claims can be read directly.
    const claims = JSON.parse(Buffer.from(String(id_token).split(".")[1] ?? "", "base64url").toString());
    const email = String(claims.email ?? "").toLowerCase();
    const okIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (!okIssuer || claims.aud !== config.google.clientId || !claims.email_verified || !email) throw new Error("bad token");
    if (!allowedEmails.includes(email)) {
      console.warn(`[auth] refused Google sign-in from ${email}`);
      return res.redirect(`/login?error=denied&email=${encodeURIComponent(email)}`);
    }
    res.cookie(COOKIE, issueToken(email), {
      httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_DAYS * 86400_000, path: "/",
    });
    console.log(`[auth] ${email} signed in`);
    res.redirect(next);
  } catch (err) {
    console.warn("[auth] Google sign-in failed:", (err as Error).message);
    res.redirect("/login?error=google");
  }
}
