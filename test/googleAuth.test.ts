import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-auth-${process.pid}`);
process.env.GOOGLE_CLIENT_ID = "client-123";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.ALLOWED_EMAILS = "Owner@Example.com, salah@example.com";
process.env.APP_PASSWORD = "old-password";
const auth = await import("../src/auth.ts");

/** Minimal stand-ins for Express's req/res. */
function fakeReq(path: string, query: Record<string, string> = {}, cookie = "") {
  return { path, originalUrl: path, query, headers: { cookie }, protocol: "https", secure: true, ip: "1.2.3.4", get: () => "studio.example.com" } as any;
}
function fakeRes() {
  const r: any = { cookies: {} as Record<string, string>, redirected: "", statusCode: 200 };
  r.cookie = (k: string, v: string) => (r.cookies[k] = v);
  r.clearCookie = () => {};
  r.redirect = (u: string) => (r.redirected = u);
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = () => r;
  return r;
}
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

async function signIn(email: string) {
  const start = fakeRes();
  auth.googleStart(fakeReq("/login/google", { next: "/#ready" }), start);
  assert.match(start.redirected, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(start.redirected, /redirect_uri=https%3A%2F%2Fstudio\.example\.com%2Flogin%2Fgoogle%2Fcallback/);
  const stateCookie = start.cookies.rollcut_oauth;
  const state = stateCookie.split(".")[0];
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ id_token: idToken({ iss: "https://accounts.google.com", aud: "client-123", email, email_verified: true }) }))) as any;
  const res = fakeRes();
  try {
    await auth.googleCallback(fakeReq("/login/google/callback", { state, code: "abc" }, `rollcut_oauth=${stateCookie}`), res);
  } finally {
    globalThis.fetch = real;
  }
  return res;
}

test("Google sign-in replaces the password and only lets allowed accounts in", async () => {
  assert.equal(auth.googleLogin, true);
  assert.equal(auth.gateEnabled, true);

  const ok = await signIn("owner@example.com");
  assert.equal(ok.redirected, "/#ready");
  const session = ok.cookies.pawcut_session;
  assert.ok(session);
  // The session opens the app and knows who it is.
  let passed = false;
  auth.requireAuth(fakeReq("/api/status", {}, `pawcut_session=${session}`), fakeRes(), () => (passed = true));
  assert.equal(passed, true);
  assert.equal(auth.signedInAs(fakeReq("/", {}, `pawcut_session=${session}`)), "owner@example.com");

  const stranger = await signIn("someone@else.com");
  assert.match(stranger.redirected, /^\/login\?error=denied/);
  assert.equal(stranger.cookies.pawcut_session, undefined);

  // No session: API calls are refused.
  const res = fakeRes();
  passed = false;
  auth.requireAuth(fakeReq("/api/status"), res, () => (passed = true));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);

  // The old password no longer works once Google sign-in is on.
  const pw = fakeRes();
  auth.login({ ...fakeReq("/login"), body: { password: "old-password" } }, pw);
  assert.equal(pw.cookies.pawcut_session, undefined);
});

test("a forged state is rejected", async () => {
  const res = fakeRes();
  await auth.googleCallback(fakeReq("/login/google/callback", { state: "forged", code: "abc" }, "rollcut_oauth=real.Lw"), res);
  assert.equal(res.redirected, "/login?error=google");
});
