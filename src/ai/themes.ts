import { config } from "../config.ts";
import { allScenes, store } from "../store.ts";
import { structured } from "./director.ts";

/**
 * Clips sorted as "other" before a theme existed for them get another look: from what the AI already
 * wrote about each (summary, tags, the creator's note), text only, many clips per call, small model.
 * The creator's own choices are never changed.
 */
export async function resortOther(): Promise<number> {
  if (!config.claude.enabled) return 0;
  const themes = allScenes();
  const todo = store
    .clips()
    .filter((c) => c.status === "ready" && c.ai?.summary && c.sceneSetBy !== "creator" && (!c.scene || !themes.includes(c.scene)));
  let moved = 0;
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const r = await structured<{ clips: { n: number; theme: string }[] }>({
      system: "You sort short travel videos of a dog into themes, from a description of each.",
      content: [
        {
          type: "text",
          text:
            `Themes: ${themes.map((t) => `"${t}"`).join(", ")}, or "other" if none fits.\n\n` +
            batch
              .map((c, n) => `${n + 1}. ${c.ai!.summary}${c.ai?.tags?.length ? ` [${c.ai.tags.join(", ")}]` : ""}${c.note ? ` Creator's note: ${c.note}` : ""}`)
              .join("\n") +
            `\n\nGive each clip's theme.`,
        },
      ],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["clips"],
        properties: {
          clips: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["n", "theme"],
              properties: { n: { type: "integer" }, theme: { type: "string", enum: [...themes, "other"] } },
            },
          },
        },
      },
      effort: "low",
      model: config.claude.fastModel,
    });
    for (const { n, theme } of r.clips) {
      const c = batch[n - 1];
      if (c && theme !== "other" && theme !== c.scene) {
        store.updateClip(c.id, { scene: theme, sceneSetBy: "ai" });
        moved++;
      }
    }
  }
  if (moved) console.log(`[themes] sorted ${moved} clip(s) from "other" into themes`);
  return moved;
}

/**
 * Themes suggested from the creator's own footage (not a fixed list): what keeps coming up in the
 * clips that don't fit a theme yet, named the way a creator would. Text only, small model; cached.
 */
let suggested: { at: number; themes: { name: string; why: string }[] } | null = null;
export async function suggestThemes(fresh = false): Promise<{ name: string; why: string }[]> {
  if (!config.claude.enabled) return [];
  if (!fresh && suggested && Date.now() - suggested.at < 12 * 3600_000) return suggested.themes;
  const have = allScenes();
  const pool = store
    .clips()
    .filter((c) => c.status === "ready" && c.ai?.summary)
    .sort((a, b) => Number(!have.includes(b.scene ?? "")) - Number(!have.includes(a.scene ?? "")))
    .slice(0, 150);
  if (pool.length < 10) return [];
  const r = await structured<{ themes: { name: string; why: string }[] }>({
    system: "You help a creator organise their travel footage into themes for short videos.",
    content: [
      {
        type: "text",
        text:
          `Clips from a creator's camera roll (what's in each):\n` +
          pool.map((c) => `- ${c.ai!.summary}${c.place ? ` (${c.place})` : ""}`).join("\n") +
          `\n\nThemes they already have: ${have.map((t) => `"${t}"`).join(", ")}.\n` +
          `Suggest up to 6 NEW themes that several of these clips share and that would make good videos (a kind of ` +
          `place, activity or moment, e.g. "mountains", "train rides", "markets", "sunsets"). Short lowercase names, ` +
          `not places' names, not overlapping the existing ones. For each, a few words on what it covers.`,
      },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["themes"],
      properties: {
        themes: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["name", "why"], properties: { name: { type: "string" }, why: { type: "string" } } },
        },
      },
    },
    effort: "low",
    model: config.claude.fastModel,
  });
  const themes = r.themes
    .map((t) => ({ name: t.name.trim().toLowerCase().slice(0, 40), why: t.why.trim().slice(0, 120) }))
    .filter((t) => t.name && !have.includes(t.name))
    .slice(0, 6);
  suggested = { at: Date.now(), themes };
  return themes;
}
