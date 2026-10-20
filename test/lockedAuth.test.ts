import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-locked-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = "production";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.HOST;
process.env.APP_PASSWORD = "would-have-worked-before";
const auth = await import("../src/auth.ts");

test("hosted without Google sign-in, the app is locked: no password, no way in", () => {
  assert.equal(auth.gateEnabled, true);
  assert.equal(auth.lockedOut, true);
  const res: any = { statusCode: 200, status: (c: number) => ((res.statusCode = c), res), json: () => res };
  let passed = false;
  auth.requireAuth({ path: "/api/status", method: "GET", headers: {} } as any, res, () => (passed = true));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});
