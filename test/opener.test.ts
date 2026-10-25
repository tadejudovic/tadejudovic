import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-opener-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { openerExisting, strongFootage } = await import("../src/generate.ts");

const clip = (id: string, scene: string, summary: string) =>
  store.addClip({ id, source: "upload", filename: "x.mp4", file: "/x", kind: "video", importedAt: "2026-10-01T00:00:00Z", capturedAt: "2026-10-01T10:00:00Z", duration: 8, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready", scene, ai: { summary, tags: [], moments: [{ start: 3, end: 5, score: 0.9, description: "", tags: [] }] } } as any);

test("an educational video waiting in Review gets the strongest opening, same text", () => {
  clip("walk", "airport terminal", "Lex walked on a leash through the terminal");
  clip("vet", "veterinary clinic", "Lex on the exam table");
  clip("bag", "airport terminal", "Lex peeks out of the backpack while walking to the gate");
  assert.equal(strongFootage(store.clip("walk")!), false);
  assert.equal(strongFootage(store.clip("bag")!), true);
  const overlays = [{ text: "How do dogs get into another country?", start: 0, end: 20 }, { text: "1. Microchip first", start: 2.5, end: 6, y: 0.4 }];
  store.addRender({ id: "v1", createdAt: new Date().toISOString(), status: "done", progress: 1, review: "pending", options: {} as any, editor: { verdict: "remake" } as any,
    plan: { format: "tips", overlays, hook: overlays[0].text, segments: [{ clipId: "walk", start: 28.5, end: 31, speed: 1 }, { clipId: "vet", start: 0, end: 4, speed: 1 }] } } as any);
  assert.equal(openerExisting(), 1);
  const fresh = store.renders().find((r: any) => r.plan.format === "tips")!;
  assert.notEqual(fresh.id, "v1");
  assert.equal(fresh.plan.segments[0].clipId, "bag");
  assert.equal(fresh.plan.segments[0].end - fresh.plan.segments[0].start, 2.5);
  assert.equal(fresh.plan.segments[1].clipId, "vet");
  assert.deepEqual(fresh.plan.overlays, overlays);
  assert.equal((fresh as any).editor?.verdict, "remake");
});

test("clips without Lex in them are kept out of points, montages and openings", async () => {
  const { hasLex, trimTo } = { ...(await import("../src/generate.ts")), ...(await import("../src/ai/director.ts")) } as any;
  const c = (summary: string) => ({ ai: { summary } }) as any;
  assert.equal(hasLex(c("Handheld footage slowly panning over a printed Copa Airlines form; no pet visible, low payoff.")), false);
  assert.equal(hasLex(c("Man in a t-shirt by the terminal window. No pet is visible; the clip is static.")), false);
  assert.equal(hasLex(c("Lex peeks out of a dark soft carrier on the check-in conveyor.")), true);
  assert.equal(hasLex(c("Lex sits calmly; no barks or big reactions.")), true);
  const cut = trimTo([{ clipId: "a", start: 0, end: 10, speed: 1 }, { clipId: "b", start: 0, end: 8, speed: 1 }], 13);
  assert.deepEqual(cut.map((s: any) => [s.clipId, s.start, s.end]), [["a", 0, 10], ["b", 0, 3]]);
});

test("footage of the creator and Lex together is recognised", async () => {
  const { together } = await import("../src/generate.ts");
  const c = (summary: string) => ({ ai: { summary } }) as any;
  assert.equal(together(c("Selfie-style clip in a terminal with a bearded man in a cap and Lex nuzzling the camera.")), true);
  assert.equal(together(c("A man in an orange puffer jacket holds and cuddles Lex in a lounge.")), true);
  assert.equal(together(c("Lex eats jerky treats from a hand at the gate.")), false);
  assert.equal(together(c("Man in a t-shirt by the window. No pet is visible.")), false);
});
