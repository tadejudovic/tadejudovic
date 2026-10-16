import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const dir = path.join(os.tmpdir(), `lexstudio-voice-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = dir;
const { store } = await import("../src/store.ts");
const { config } = await import("../src/config.ts");
const { saveLineRecording, renderDraft } = await import("../src/generate.ts");
const { planFromDraft, captionChunks } = await import("../src/ai/story.ts");
const { renderVideo } = await import("../src/media/render.ts");
const { probe } = await import("../src/media/ffmpeg.ts");

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.tmpDir, { recursive: true });
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args]);
const clipFile = (name: string, src: string) => {
  const f = path.join(config.mediaDir, `${name}.mp4`);
  ff("-f", "lavfi", "-i", `${src}=size=1080x1920:rate=30:duration=6`, "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f);
  return store.addClip({ id: name, source: "upload", filename: `${name}.mp4`, file: f, kind: "video", importedAt: "2026-10-01T00:00:00Z", duration: 6, width: 1080, height: 1920, hasAudio: true, uses: 0, status: "ready" } as any);
};

test("captions follow the words in short chunks across the line", () => {
  const c = captionChunks("Stress at the airport? Zero. He's more relaxed than me.", 2, 4);
  assert.equal(c.length, 2);
  assert.equal(c[0].start, 2);
  assert.ok(Math.abs(c[c.length - 1].end - 6) < 1e-9);
  assert.ok(c.every((o) => o.at === "caption"));
});

test("a recorded voiceover story: lines timed to the recordings, voice mixed over the clips", async () => {
  clipFile("airport", "testsrc2");
  clipFile("plane", "smptebars");
  store.saveDraft({
    id: "d1", createdAt: new Date().toISOString(), mode: "script", source: "script", title: "Are dogs afraid of flying?",
    lines: [
      { text: "Are dogs afraid of flying?", clipId: "airport", start: 0, end: 3 },
      { text: "Take-off is the worst bit.", clipId: "plane", start: 1, end: 4 },
    ],
    postCaption: "desc", hashtags: ["a", "b", "c"],
  });
  // Two recordings with silence before and after the words (as when tapping record).
  for (const [i, secs] of [[0, 2], [1, 3]] as const) {
    const raw = path.join(config.tmpDir, `rec${i}.wav`);
    ff("-f", "lavfi", "-i", `sine=frequency=700:duration=${secs}`, "-af", "adelay=800|800,apad=pad_dur=0.8", raw);
    await saveLineRecording("d1", i, raw);
  }
  const d = store.draft("d1")!;
  assert.ok(Math.abs(d.lines[0].audioSeconds! - 2) < 0.4, `trimmed to the words: ${d.lines[0].audioSeconds}`);
  assert.ok(Math.abs(d.lines[1].audioSeconds! - 3) < 0.4);

  const plan = planFromDraft(d, true);
  assert.equal(plan.voiceover!.length, 2);
  const firstLen = (plan.segments[0].end - plan.segments[0].start) / (plan.segments[0].speed ?? 1);
  assert.ok(Math.abs(firstLen - (d.lines[0].audioSeconds! + 0.25)) < 0.01);
  assert.ok(Math.abs(plan.voiceover![1].start - (firstLen + 0.1)) < 0.01);

  const r = await renderVideo("v1", plan, new Map(store.clips().map((c) => [c.id, c])), { keepOriginalAudio: true, textStyle: "yellow", textSize: "medium", fontId: "montserrat" } as any, () => {});
  const info = await probe(r.file);
  assert.ok(info.hasAudio);
  assert.ok(Math.abs(r.duration - plan.segments.reduce((n, s) => n + (s.end - s.start) / (s.speed ?? 1), 0)) < 0.3);
});

test("a line without footage stops the render and says which", () => {
  store.saveDraft({ id: "d2", createdAt: new Date().toISOString(), mode: "talk", source: "x", title: "t", lines: [{ text: "PetPace app screen", missing: "the PetPace app" }], postCaption: "", hashtags: [] });
  assert.throws(() => renderDraft("d2", false), /no clip yet/);
});

test("shot directions in a talk track are read and never spoken", async () => {
  const { parseShots, stripShots } = await import("../src/ai/story.ts");
  const { marked, shots } = parseShots("[lying at the gate] He's calmer than me. /security-check He walks alone, 24/7 @petpace https://x.co/a");
  assert.deepEqual(shots, ["lying at the gate", "security check"]);
  assert.match(marked, /\{SHOT: lying at the gate\} He's calmer than me\. \{SHOT: security check\} He walks alone, 24\/7 @petpace https:\/\/x\.co\/a/);
  assert.equal(stripShots("{SHOT: gate} He's calm [gate] now /plane"), "He's calm now");
  // A whole line after a slash is a shot for the words that follow.
  const one = parseShots("I'm flying my dog 42,000 kilometres around the world.\n\n/ Lex inside airplane \nHonestly, things don't always go to plan.");
  assert.deepEqual(one.shots, ["Lex inside airplane"]);
  assert.equal(one.marked, "I'm flying my dog 42,000 kilometres around the world.\n\n{SHOT: Lex inside airplane}\nHonestly, things don't always go to plan.");
});

test("cloned voice: made from samples, then reads the lines that weren't recorded", async () => {
  const { createVoice, speakDraft } = await import("../src/generate.ts");
  config.elevenlabs.key = "test-key";
  const calls: { url: string; method: string; body?: string }[] = [];
  const tts = path.join(config.tmpDir, "tts-src.mp3");
  ff("-f", "lavfi", "-i", "sine=frequency=500:duration=1.5", "-c:a", "libmp3lame", tts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
    if (String(url).endsWith("/voices/add")) return new Response(JSON.stringify({ voice_id: "v1" }));
    if (String(url).includes("/text-to-speech/v1")) return new Response(fs.readFileSync(tts));
    return new Response("{}");
  }) as typeof fetch;
  try {
    const short = path.join(config.tmpDir, "short.wav");
    ff("-f", "lavfi", "-i", "sine=frequency=200:duration=10", short);
    await assert.rejects(createVoice([short]), /at least 30 seconds/);
    const sample = path.join(config.tmpDir, "sample.wav");
    ff("-f", "lavfi", "-i", "sine=frequency=200:duration=40", sample);
    assert.equal((await createVoice([sample])).sampleSeconds, 40);
    assert.equal(store.settings().voice?.id, "v1");
    assert.equal(fs.existsSync(sample), false); // uploads are cleaned up

    store.saveDraft({
      id: "d3", createdAt: new Date().toISOString(), mode: "talk", source: "x", title: "t",
      lines: [{ text: "Hello there.", clipId: "airport", start: 0, end: 3 }, { text: "Second line.", clipId: "plane", start: 0, end: 3 }],
      postCaption: "", hashtags: [],
    });
    const raw = path.join(config.tmpDir, "mine.wav");
    ff("-f", "lavfi", "-i", "sine=frequency=700:duration=2", raw);
    await saveLineRecording("d3", 0, raw);
    const d = await speakDraft("d3");
    assert.equal(d.lines[0].audioBy, "me"); // the creator's own recording is kept
    assert.equal(d.lines[1].audioBy, "clone");
    assert.ok(Math.abs(d.lines[1].audioSeconds! - 1.5) < 0.3);
    const tCalls = calls.filter((c) => c.url.includes("/text-to-speech/"));
    assert.equal(tCalls.length, 1);
    assert.equal(JSON.parse(tCalls[0].body!).text, "Second line.");
  } finally {
    globalThis.fetch = realFetch;
    config.elevenlabs.key = "";
  }
});
