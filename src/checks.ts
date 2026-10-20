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

/** Places people name on screen; checked against where the clip was really filmed. */
const PLACES: [RegExp, string][] = [
  [/\b(nyc|new york|manhattan|brooklyn)\b/i, "New York"],
  [/\b(la|los angeles|hollywood)\b/, "Los Angeles"],
  [/\b(miami|florida|fort lauderdale)\b/i, "Florida"],
  [/\b(toronto)\b/i, "Toronto"],
  [/\b(vancouver)\b/i, "Vancouver"],
  [/\b(paris)\b/i, "Paris"],
  [/\b(london)\b/i, "London"],
  [/\b(rome)\b/i, "Rome"],
  [/\b(barcelona|madrid)\b/i, "Spain"],
  [/\b(lisbon|porto)\b/i, "Portugal"],
  [/\b(amsterdam)\b/i, "Amsterdam"],
  [/\b(berlin)\b/i, "Berlin"],
  [/\b(tokyo|kyoto|osaka)\b/i, "Japan"],
  [/\b(bali)\b/i, "Bali"],
  [/\b(dubai)\b/i, "Dubai"],
  [/\b(sydney|melbourne)\b/i, "Australia"],
  [/\b(mexico city|cancun|tulum)\b/i, "Mexico"],
];

export function basicChecks(plan: VideoPlan, place?: string): string[] {
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
  // Plain words a stranger reads in a second: no airport codes, no odd capitals.
  for (const o of plan.overlays ?? [{ text: hook } as { text: string }]) {
    const codes = (o.text.match(/\b[A-Z]{3}\b/g) ?? []).filter((w) => !/^(POV|DIY|USA|USD|EUR|GPS|TSA|ESA|DOT|FAQ|CTA|ONE|TWO|DOG|AND|THE|FOR)$/.test(w));
    if (codes.length) problems.push(`"${o.text}" uses airport codes or abbreviations (${codes.join(", ")}): write the city or place.`);
    const midCaps = o.text
      .replace(/^\s*(\d{1,2}[.):]|[A-Z']+:)\s*/, "")
      .split(/(?<=[.?!:])\s+/)
      .flatMap((sentence) => sentence.split(/\s+/).slice(1))
      .filter((w) => /^[A-Z][a-z]{3,}$/.test(w) && !/^(Lex|Lufthansa|Delta|United|Southwest|Japan|Europe|Brazil|Portugal|Lisbon|Tokyo|Toronto|Paris|London|Mexico|Canada|America|Christmas|Sunday|Monday|Friday|Saturday)$/.test(w));
    if (midCaps.length >= 1 && o === (plan.overlays ?? [])[0]) problems.push(`"${o.text}" has odd capitals (${midCaps.join(", ")}): sentence case, capitals only for names.`);
  }
  // A place on screen must be where the clip was filmed (not one copied from someone else's caption).
  for (const o of plan.overlays ?? []) {
    for (const [re, name] of PLACES) {
      const m = re.exec(o.text);
      if (!m) continue;
      const here = (place ?? "").toLowerCase();
      if (!here || !(here.includes(m[0].toLowerCase()) || here.includes(name.toLowerCase())))
        problems.push(`"${o.text}" names ${m[0]}, but this clip was ${place ? `filmed in ${place}` : "filmed somewhere unknown"}: name only where it really is, or no place.`);
    }
  }
  // The correcting side of a pair states the truth; "check" / "it varies" is advice, not a fact.
  for (const o of plan.overlays ?? [])
    if (/^\s*(fact|truth|reality|instead)\s*[:–-]/i.test(o.text) && /\b(check|varies|vary|depends|it depends|research)\b/i.test(o.text))
      problems.push(`"${o.text}" doesn't state the truth, it gives advice: say what's actually true or what to do instead, concretely.`);
  // The lesson takes the shape it was given (a list stays a list, a myth video has its MYTH / FACT pairs).
  const pts = (plan.overlays ?? []).filter((o) => o.y !== undefined && !/flywith|link in bio/i.test(o.text));
  const want: Record<string, RegExp> = {
    list: /^\s*\d{1,2}[.):]\s/,
    myth: /^\s*(myth|fact)\s*[:–-]/i,
    mistake: /^\s*(mistake|instead)\s*[:–-]/i,
    dodont: /^\s*(don['’]?t|do)\s*[:–-]/i,
  };
  const shape = plan.eduFormat && want[plan.eduFormat];
  if (edu && shape && pts.length && !pts.every((o) => shape.test(o.text)))
    problems.push(`This video's structure is "${plan.eduFormat}": every point starts with its label (${String(shape).slice(5, 40)}…).`);
  // Points: short enough to read at a glance.
  for (const o of (plan.overlays ?? []).slice(1)) {
    const label = /^\s*(\d{1,2}[.):]|(myth|fact|truth|reality|mistake|instead|don['’]?t|do|answer|tip)\s*[:–-])\s+/i.exec(o.text);
    if (o.y !== undefined && label && words(o.text.slice(label[0].length)) > 7)
      problems.push(`The point "${o.text}" is ${words(o.text.slice(label[0].length))} words after its label: at most 7.`);
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
