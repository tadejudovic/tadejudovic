import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { store } from "../store.ts";
import { frameBuffer } from "../media/ffmpeg.ts";
import { structured } from "./director.ts";
import type { Clip, Partner } from "../types.ts";

/** How many recent clips are shown to the AI (one frame each) when looking for a partner's product. */
const CANDIDATES = 16;

/**
 * Look at one frame of each recent clip and pick the one with the best angle on the partner's
 * product or place. Unused footage goes first; already-edited, duplicate and rejected clips are skipped.
 */
export async function findClipFor(partner: Partner, note?: string): Promise<{ clip: Clip; reason: string }> {
  const time = (c: Clip) => Date.parse(c.capturedAt ?? c.importedAt) || 0;
  const pool = store
    .clips()
    .filter((c) => c.status === "ready" && c.kind === "video" && c.height >= c.width && !c.disliked && !c.edited && !c.duplicateOf)
    .sort((a, b) => (a.uses > 0 ? 1 : 0) - (b.uses > 0 ? 1 : 0) || time(b) - time(a))
    .slice(0, CANDIDATES);
  if (!pool.length) throw new Error("No clips to choose from yet. Add an album or wait for imports.");

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const shown: Clip[] = [];
  for (const c of pool) {
    const jpg = await frameBuffer(c.file, Math.max(0, c.duration / 2), 320).catch(() => null);
    if (!jpg) continue;
    shown.push(c);
    content.push({ type: "text", text: `Clip ${shown.length}${c.scene ? ` (${c.scene})` : ""}${c.ai?.summary ? `: ${c.ai.summary}` : ""}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } });
  }
  if (!shown.length) throw new Error("Couldn't read any clips to choose from.");
  content.push({
    type: "text",
    text:
      `Brand partner: ${partner.name}. What it is and what to highlight: ${partner.about || "(not given)"}` +
      (note ? `\nThe creator's note: ${note}` : "") +
      `\n\nWhich clip gives the best angle for a collab video with this brand: the product or place clearly visible ` +
      `(or the moment it's about), the pet looking good, footage that's sharp enough to post?`,
  });
  const out = await structured<{ clip: number; reason: string }>({
    system: "You pick footage for brand collaborations on a pet travel account. Be concrete about what you see.",
    content,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["clip", "reason"],
      properties: {
        clip: { type: "integer", description: "The clip's number" },
        reason: { type: "string", description: "One short sentence: what makes it the best angle" },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  const clip = shown[out.clip - 1] ?? shown[0];
  return { clip, reason: out.reason };
}
