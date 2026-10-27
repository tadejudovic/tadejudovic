import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-onb-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { luhn, startTrial, saveTopics, onboardingState } = await import("../src/onboarding.ts");

test("the test-mode trial checks the card and never keeps its number", () => {
  assert.equal(luhn("4242424242424242"), true);
  assert.equal(luhn("4242424242424241"), false);
  assert.throws(() => startTrial({ number: "4242 4242 4242 4241", exp: "12/29", cvc: "123" }), /doesn't look right/);
  assert.throws(() => startTrial({ number: "4242 4242 4242 4242", exp: "01/20", cvc: "123" }), /expired/);
  const b = startTrial({ number: "4242 4242 4242 4242", exp: "12/29", cvc: "123" });
  assert.deepEqual(b.card, { brand: "Visa", last4: "4242" });
  assert.equal(b.test, true);
  assert.equal(Math.round((Date.parse(b.trialEndsAt) - Date.parse(b.startedAt)) / 86400_000), 7);
  store.flush();
  const db = fs.readdirSync(process.env.DATA_DIR!).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(process.env.DATA_DIR!, f), "utf8")).join("");
  assert.ok(!db.includes("4242424242424242") && !db.includes("4242 4242 4242 4242"), "the card number is never written");
  assert.equal(onboardingState().billing?.card.last4, "4242");
});

test("who the text speaks to follows the chosen topics", () => {
  saveTopics([{ title: "Flying with a dog", audience: "niche" }]);
  assert.equal(store.settings().captionAudience, "pets");
  saveTopics([{ title: "Flying with a dog", audience: "niche" }, { title: "Travel", audience: "everyone" }]);
  assert.equal(store.settings().captionAudience, "mix");
  saveTopics([{ title: "Travel", audience: "everyone" }]);
  assert.equal(store.settings().captionAudience, "everyone");
  assert.deepEqual(onboardingState().topics, [{ title: "Travel", audience: "everyone" }]);
});
