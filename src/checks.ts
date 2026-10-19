import type { VideoPlan } from "./types.ts";

/**
 * The basics every video must meet before it's rendered: rules that can be checked without
 * watching it. A plan that breaks one goes back to the director with the exact problems; the
 * editor's review after the render is the second check, not the first.
 */
const words = (s: string) => s.replace(/\s+\/\s+/g, " ").trim().split(/\s+/).filter(Boolean).length;
const lengthOf = (s: { start: number; end: number; speed?: number }) => (s.end - s.start) / (s.speed ?? 1);

/** Hook phrasings that narrow the audience or talk about who asks. */
const NARROW = /\b(your dog|dog owners?|pet parents?|pet owners?|if you have a dog|fur ?babies?)\b/i;
const WHO_ASKS = /\b(you (always|all|keep) ask|people (always )?ask|everyone asks|#?1 question|number one question|most asked|in (our|my) dms)\b/i;

export function basicChecks(plan: VideoPlan): string[] {
  const problems: string[] = [];
  const hook = (plan.overlays?.[0]?.text ?? plan.hook ?? "").trim();
  const edu = plan.format === "tips";
  // The headline: short, plain, for everyone.
  if (edu && words(hook) > 8) problems.push(`The headline "${hook}" is ${words(hook)} words: at most 8.`);
  if (!edu && words(hook) > 9) problems.push(`The opening text "${hook}" is ${words(hook)} words: at most 9 (two lines).`);
  // Fun / inspirational: a second line (the punchline) under the headline, short.
  if (!edu)
    for (const o of (plan.overlays ?? []).slice(1))
      if (o.y === undefined && o.at !== "caption" && words(o.text) > 5) problems.push(`The line "${o.text}" is ${words(o.text)} words: at most 5 (one line).`);
  if (edu && /\s\/\s/.test(hook)) problems.push(`The headline "${hook}" has a line break: one line of thought, no " / ".`);
  if (edu && /^[^:?]{2,24}:\s/.test(hook)) problems.push(`The headline "${hook}" is label-style ("X: …"): ask or say it plainly.`);
  if (/["“”]/.test(hook)) problems.push(`The headline "${hook}" quotes someone: say it directly.`);
  if (edu && NARROW.test(hook)) problems.push(`The headline "${hook}" speaks only to dog owners: make it for anyone curious.`);
  if (WHO_ASKS.test(hook)) problems.push(`The headline "${hook}" talks about who asks: just ask or answer it.`);
  if (edu && /^pov\b/i.test(hook)) problems.push(`The headline "${hook}" starts with POV: not for a lesson.`);
  // Points: short enough to read at a glance.
  for (const o of (plan.overlays ?? []).slice(1)) {
    if (o.y !== undefined && /^\s*\d{1,2}[.):]\s/.test(o.text) && words(o.text) > 8) problems.push(`The point "${o.text}" is ${words(o.text) - 1} words: at most 7.`);
  }
  // Pacing: the first cut early, no shot that drags.
  const segs = plan.segments;
  if (segs.length) {
    const first = lengthOf(segs[0]);
    if (segs.length > 1 && first > 4) problems.push(`The first shot runs ${first.toFixed(1)}s: cut by 3s so the opening moves.`);
    const longest = Math.max(...segs.map(lengthOf));
    const limit = edu ? 6 : 8;
    if (longest > limit && segs.length > 1) problems.push(`A shot runs ${longest.toFixed(1)}s: no shot longer than ${limit}s.`);
  }
  return problems;
}
