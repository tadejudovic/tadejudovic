import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = path.join(os.tmpdir(), `lexstudio-match-${process.pid}-${Date.now()}`);
const { store } = await import("../src/store.ts");
const { applyProfilePosts, captionSimilarity } = await import("../src/postMatch.ts");

const caption = (s: string) => s;
const video = (id: string, postCaption: string, hook: string) =>
  store.addRender({ id, createdAt: new Date(Date.now() - 86400_000).toISOString(), reviewedAt: new Date(Date.now() - 86400_000).toISOString(), plan: { hook, postCaption, segments: [] } as any, options: {} as any, status: "done", progress: 1, review: "approved" });

test("descriptions match despite small edits, hashtags and emoji", () => {
  const ours = "12 hours in economy and Lex has already tried every sleeping position known to dogs. First the carrier, then the pad, then my feet.";
  const posted = "12 hours in economy and Lex already tried every sleeping position known to dogs 😅 first the carrier, then my feet! #travelwithdog @airline";
  assert.ok(captionSimilarity(ours, posted) >= 0.7);
  assert.ok(captionSimilarity(ours, "Sunset walk in Lisbon with the best boy, he loved the tiles") < 0.3);
});

test("new profile posts are linked to the right videos and known posts get fresh numbers", () => {
  video("sleep", caption("12 hours in economy and Lex has already tried every sleeping position known to dogs. First the carrier, then the pad."), "me trying every sleeping position");
  video("security", caption("Security with a dog is its own sport. Lex walked through like a pro while I juggled the carrier, shoes and laptop."), "pov: security with a dog");
  const posts = [
    { url: "https://www.tiktok.com/@lex.poodle/video/1", text: "Security with a dog is its own sport 😂 Lex walked through like a pro while I juggled shoes and laptop #flyingwithdog", postedAt: new Date().toISOString(), stats: { views: 5000 } },
    { url: "https://www.tiktok.com/@lex.poodle/video/2", text: "Totally unrelated beach day 🌊", postedAt: new Date().toISOString(), stats: { views: 900 } },
  ];
  assert.deepEqual(applyProfilePosts("tiktok", posts), { matched: 1, refreshed: 0 });
  assert.equal(store.render("security")!.posts![0].url, posts[0].url);
  assert.equal(store.render("sleep")!.posts, undefined);
  // Next read: the linked post's numbers are refreshed.
  const again = applyProfilePosts("tiktok", [{ ...posts[0], stats: { views: 12000 } }]);
  assert.deepEqual(again, { matched: 0, refreshed: 1 });
  assert.equal(store.render("security")!.posts![0].stats!.views, 12000);
});
