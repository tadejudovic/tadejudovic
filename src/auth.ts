import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { FAVICON, landingHtml } from "./landing.ts";

/**
 * Sign-in gate: Google sign-in is the only way in. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and
 * ALLOWED_EMAILS (comma-separated); only those Google accounts get in. There is no password.
 *
 * Every page, API call and media file needs a signed session cookie. On a public address without
 * Google sign-in set up, the app stays locked (nobody gets in). The gate is off only when the server
 * listens on this computer alone (local development).
 */

const COOKIE = "pawcut_session";
const SESSION_DAYS = 30;
export const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
  .split(/[\s,;]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes("@"));
export const googleLogin = Boolean(config.google.clientId && config.google.clientSecret && allowedEmails.length);
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
/** Where the server listens: all interfaces when hosted (or HOST says so), this computer only in development. */
export const listenHost = process.env.HOST ?? (process.env.NODE_ENV === "production" || process.env.RENDER || googleLogin ? "0.0.0.0" : "127.0.0.1");
export const gateEnabled = !LOOPBACK.includes(listenHost);
/** Public, but Google sign-in isn't set up: nobody can get in until it is. */
export const lockedOut = gateEnabled && !googleLogin;

/** Secret for signing sessions: SESSION_SECRET, or one generated once and kept in the data dir. */
function sessionSecret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  const file = path.join(config.dataDir, ".session-secret");
  try {
    return fs.readFileSync(file);
  } catch {
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const secret = googleLogin ? sessionSecret() : Buffer.alloc(0);

// Sessions from the old password login carry a different tag, so they no longer open anything.
const sessionTag = crypto.createHash("sha256").update("google").digest("hex").slice(0, 16);

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A session for `who`: the Google email. */
function issueToken(who: string): string {
  const payload = `${Date.now() + SESSION_DAYS * 86400_000}.${sessionTag}.${Buffer.from(who).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

/** The signed-in Google account, or null if the cookie isn't a valid session. */
function sessionOf(token: string | undefined): string | null {
  if (!token || !googleLogin) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  const [expires, tag, who64] = payload.split(".");
  if (tag !== sessionTag || !(Number(expires) > Date.now())) return null;
  const who = who64 ? Buffer.from(who64, "base64url").toString() : "";
  // Removing someone from ALLOWED_EMAILS locks them out right away, even with a live session.
  if (!allowedEmails.includes(who)) return null;
  return who;
}

/**
 * Admins (ADMIN_EMAILS, comma-separated) see and change everything: Labs, research, partners,
 * spending, diagnostics. Everyone else signed in gets the app as it rolls out. Without ADMIN_EMAILS,
 * everyone allowed in is an admin (as before), and on this computer alone there's no gate at all.
 */
export const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(/[\s,;]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes("@"));
export function isAdmin(req: Request): boolean {
  if (!gateEnabled || !adminEmails.length) return true;
  const who = signedInAs(req);
  return !!who && adminEmails.includes(who);
}

/** Email of whoever is signed in (for the app's "signed in as"). */
export function signedInAs(req: Request): string | undefined {
  const who = sessionOf(readCookie(req, COOKIE));
  return who ?? undefined;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!gateEnabled) return next();
  if (["/login", "/logout", "/login/google", "/login/google/callback", "/landing"].includes(req.path)) return next();
  // Images for the public landing page (files in public/landing/ only).
  if (/^\/landing\/[\w-]+\.(jpe?g|png|webp)$/.test(req.path)) return next();
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
    denied: `${typeof req.query.email === "string" ? req.query.email.slice(0, 120) : "That account"} doesn't have access to Rollcut.`,
    google: "Google sign-in didn't work. Try again.",
  };
  const error = errors[String(req.query.error ?? "")] ?? "";
  const next = safeNext(req.query.next);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollcut · sign in</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght,ROND@6..144,400..900,100&display=swap" rel="stylesheet">
<link rel="icon" href="${FAVICON}">
<style>
/* Material 3 Expressive, the app's amber tokens, light and dark following the phone */
:root{--md-primary:#825500;--md-on-primary:#ffffff;--md-tertiary-container:#fbe191;--md-error:#ba1a1a;--md-surface:#fff8f4;--md-surface-container-high:#f8e5d0;--md-on-surface:#231a0d;--md-on-surface-variant:#534432;--md-outline-variant:#d8c3ab;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--md-primary:#ffb952;--md-on-primary:#452b00;--md-tertiary-container:#564502;--md-error:#ffb4ab;--md-surface:#1b1206;--md-surface-container-high:#33281b;--md-on-surface:#f3dfcb;--md-on-surface-variant:#d8c3ab;--md-outline-variant:#534432;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--md-surface);color:var(--md-on-surface);font:15px/1.5 "Google Sans Flex","Google Sans",Roboto,system-ui,sans-serif;font-variation-settings:"ROND" 100;padding:16px;overflow:hidden}
body::before{content:"";position:fixed;width:520px;height:520px;right:-160px;top:-160px;border-radius:42%;background:var(--md-tertiary-container);pointer-events:none}
form{position:relative;background:var(--md-surface-container-high);border-radius:32px;padding:32px 28px;width:100%;max-width:360px;display:grid;gap:14px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:20px;letter-spacing:-.02em}
.brand i{width:26px;height:26px;border-radius:50%;background:var(--md-primary)}
h1{margin:6px 0 0;font-size:30px;font-weight:800;letter-spacing:-.02em}
p{margin:0;color:var(--md-on-surface-variant);font-size:14px}.err{color:var(--md-error)}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:15px;background:var(--md-primary);color:var(--md-on-primary);cursor:pointer;transition:border-radius .25s cubic-bezier(.34,1.4,.64,1)}
button:active{border-radius:14px}
button.google{display:flex;align-items:center;justify-content:center;gap:10px}
button.google svg{background:#fff;border-radius:50%;padding:2px;width:22px;height:22px}
a.back{color:var(--md-on-surface-variant);font-size:13px;text-decoration:none;text-align:center}
</style></head><body>
${
  googleLogin
    ? `<form method="get" action="/login/google">
<div class="brand"><i></i>Rollcut</div><h1>Welcome back</h1><p>Sign in with your Google account. Only invited accounts can get in.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit" class="google"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</button>
<a class="back" href="/">Back to Rollcut</a>
</form>`
    : `<form onsubmit="return false">
<div class="brand"><i></i>Rollcut</div><h1>Locked</h1><p>Sign-in isn't set up yet, so nobody can get in. The owner needs to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ALLOWED_EMAILS on the server.</p>
<a class="back" href="/">Back to Rollcut</a>
</form>`
}</body></html>`);
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
