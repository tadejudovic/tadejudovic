import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { TEMPLATES } from "../templates.ts";
import type { Clip, Moment, Segment, TemplateId, VideoPlan } from "../types.ts";

/**
 * The "AI director": Claude watches sampled frames of each clip once (cached on
 * the clip), then plans videos from that text catalog — so planning a day's
 * worth of videos is a cheap text-only call.
 */

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

// Server-side fallback: if a request is declined, the API re-runs it on
// Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

async function structured<T>(params: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
}): Promise<T> {
  const stream = anthropic().beta.messages.stream({
    ...FALLBACK,
    model: config.claude.model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: params.effort, format: { type: "json_schema", schema: params.schema } },
    system: params.system,
    messages: [{ role: "user", content: params.content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new Error(`Claude declined this request (${msg.stop_details?.category ?? "unspecified"}).`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's response was cut off (max_tokens).");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text) as T;
}

const MOMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end", "score", "description", "tags"],
  properties: {
    start: { type: "number" },
    end: { type: "number" },
    score: { type: "number", description: "0..1 — how likely this moment is to stop a scroll" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
};

const TAG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tags", "moments"],
  properties: {
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    moments: { type: "array", items: MOMENT_SCHEMA },
  },
};

/** Look at a clip and describe its best moments. */
export async function tagClip(clip: Clip, petName: string): Promise<NonNullable<Clip["ai"]>> {
  const frames = Math.max(2, Math.min(16, Math.ceil(clip.duration / 1.5)));
  const times = Array.from({ length: frames }, (_, i) =>
    Math.round(((clip.duration * (i + 0.5)) / frames) * 10) / 10,
  );
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const t of times) {
    const jpg = await frameBuffer(clip.file, t);
    content.push({ type: "text", text: `Frame at t=${t}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  const energy = (clip.energy ?? [])
    .map((v, i) => `${(i * 0.5).toFixed(1)}s:${v.toFixed(2)}`)
    .join(" ");
  content.push({
    type: "text",
    text:
      `Clip "${clip.filename}", ${clip.duration.toFixed(1)}s long, has audio: ${clip.hasAudio}.\n` +
      `Motion+loudness energy per 0.5s (0..1): ${energy || "n/a"}\n\n` +
      `The pet in this footage is called ${petName}. Identify the moments (1.5–8s each, inside 0..${clip.duration.toFixed(1)}s) ` +
      `that would work in a short-form pet video, best first. Use the energy curve to place cut points on action and ` +
      `audio peaks (barks, reactions). Tags should be short and reusable across clips (e.g. zoomies, sleepy, ` +
      `side-eye, tricks, outdoors, bath, food, toy, cuddle, dramatic, puppy).`,
  });
  const result = await structured<NonNullable<Clip["ai"]>>({
    system:
      "You are a short-form video editor who specializes in viral pet content on TikTok, Reels and Shorts. " +
      "You judge footage by whether it stops the scroll in the first second: surprise, comedic timing, " +
      "expressive faces, sound, and relatable pet behavior. Be honest — static or blurry footage gets a low score.",
    content,
    schema: TAG_SCHEMA,
    effort: "low",
  });
  result.moments = result.moments
    .map((m) => clampMoment(m, clip.duration))
    .filter((m): m is Moment => m !== null)
    .sort((a, b) => b.score - a.score);
  return result;
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["videos"],
  properties: {
    videos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "segments", "postCaption", "hashtags"],
        properties: {
          title: { type: "string", description: "Internal name for the video" },
          hook: { type: "string", description: "On-screen hook shown in the first ~2.5s. Max ~8 words, no emoji." },
          segments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["clipId", "start", "end", "caption", "speed"],
              properties: {
                clipId: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
                caption: { type: "string", description: "On-screen text for this segment, or empty string. No emoji." },
                speed: { type: "number", description: "1 for normal, 0.5 for slow-mo payoff, up to 1.5" },
              },
            },
          },
          postCaption: { type: "string", description: "TikTok caption to post with, may include emoji" },
          hashtags: { type: "array", items: { type: "string" }, description: "Without the # sign" },
        },
      },
    },
  },
};

export async function planVideos(opts: {
  template: TemplateId;
  targetSeconds: number;
  count: number;
  brief?: string;
  clips: Clip[];
  petName: string;
  handle?: string;
}): Promise<VideoPlan[]> {
  const def = TEMPLATES[opts.template];
  const byId = new Map(opts.clips.map((c) => [c.id, c]));
  const catalog = opts.clips.map((c) => ({
    clipId: c.id,
    duration: c.duration,
    capturedAt: c.capturedAt ?? null,
    kind: c.kind,
    orientation: c.height >= c.width ? "portrait" : "landscape",
    timesAlreadyUsed: c.uses,
    summary: c.ai?.summary ?? null,
    tags: c.ai?.tags ?? [],
    moments: (c.ai?.moments ?? c.moments ?? []).slice(0, 6),
  }));
  const prompt =
    `Plan ${opts.count} distinct short-form videos of ${opts.petName}` +
    (opts.handle ? ` for the account ${opts.handle}` : "") +
    `.\n\nFormat: ${def.name}\n${def.playbook.replaceAll("{pet}", opts.petName)}\n\n` +
    `Each video must total ${opts.targetSeconds}s (±1s), computed as the sum of (end-start)/speed. ` +
    `Segments must use clipIds from the library and stay within each clip's duration; prefer the listed moments. ` +
    `Make the ${opts.count} videos clearly different from each other (different clips, angles and hooks), and favor ` +
    `clips with a low timesAlreadyUsed so the account doesn't repeat itself.` +
    (opts.brief ? `\n\nCreator's direction: ${opts.brief}` : "") +
    `\n\nLibrary:\n${JSON.stringify(catalog)}`;

  const result = await structured<{ videos: Omit<VideoPlan, "template" | "plannedBy">[] }>({
    system:
      "You are the head of content for a fast-growing pet creator. You know what makes short-form pet videos " +
      "perform: a hook in the first second, cut on action, captions that are relatable and funny without being " +
      "cringe, and endings that loop. Write in a natural creator voice. Hashtags: a mix of 3–6 broad and niche tags.",
    content: [{ type: "text", text: prompt }],
    schema: PLAN_SCHEMA,
    effort: "medium",
  });

  return result.videos.map((v) => ({
    ...v,
    template: opts.template,
    plannedBy: "claude" as const,
    hashtags: v.hashtags.map((h) => h.replace(/^#/, "")),
    segments: v.segments
      .map((s) => validateSegment(s, byId))
      .filter((s): s is Segment => s !== null),
  })).filter((v) => v.segments.length > 0);
}

function clampMoment(m: Moment, duration: number): Moment | null {
  const start = Math.max(0, Math.min(m.start, duration));
  const end = Math.max(0, Math.min(m.end, duration));
  if (end - start < 0.5) return null;
  return { ...m, start, end, score: Math.max(0, Math.min(1, m.score)) };
}

function validateSegment(s: Segment, clips: Map<string, Clip>): Segment | null {
  const clip = clips.get(s.clipId);
  if (!clip) return null;
  const start = Math.max(0, Math.min(s.start, clip.duration - 0.5));
  const end = Math.max(start + 0.5, Math.min(s.end, clip.duration));
  const speed = Math.max(0.5, Math.min(1.5, s.speed || 1));
  return { clipId: s.clipId, start, end, caption: s.caption || undefined, speed };
}
