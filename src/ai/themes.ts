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
