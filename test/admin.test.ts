import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-admin-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = "production";
delete process.env.HOST;
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.ALLOWED_EMAILS = "owner@example.com, friend@example.com";
process.env.ADMIN_EMAILS = "Owner@example.com";
const auth = await import("../src/auth.ts");

test("only the accounts in ADMIN_EMAILS are admins", () => {
  assert.deepEqual(auth.adminEmails, ["owner@example.com"]);
  assert.equal(auth.gateEnabled, true);
  assert.equal(auth.isAdmin({ headers: {} } as any), false, "no session, no admin");
  assert.equal(auth.isAdmin({ headers: { cookie: "pawcut_session=forged.token" } } as any), false);
});
