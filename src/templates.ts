import type { TemplateId } from "./types.ts";

export interface TemplateDef {
  id: TemplateId;
  name: string;
  description: string;
  /** Typical segment length in seconds. */
  segmentSeconds: [number, number];
  /** Guidance for the AI director about how this format works on TikTok. */
  playbook: string;
}

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  quick_cuts: {
    id: "quick_cuts",
    name: "Quick-cut montage",
    description: "6–12 punchy cuts of the highest-energy moments with a bold hook on top.",
    segmentSeconds: [1.2, 2.2],
    playbook:
      "Fast montage. Open on the single most surprising/funny frame in the first second — no slow intro. " +
      "Cut on action. Keep every segment 1.2–2.2s. One strong hook line on screen for the first ~2.5s; " +
      "optional 1–3 word captions on later cuts. End on a moment that loops cleanly back into the first cut.",
  },
  single_moment: {
    id: "single_moment",
    name: "One perfect moment",
    description: "One continuous funny/cute moment, uncut, with a hook caption. Built to loop.",
    segmentSeconds: [8, 20],
    playbook:
      "One continuous moment with a clear setup and payoff (e.g. 'wait for it'). Start as close to the action as " +
      "possible — the payoff should land before the viewer can scroll away, ideally by second 3–6. Hook text sets up " +
      "the expectation. Pick a window whose last frame flows into the first so it loops.",
  },
  pov_story: {
    id: "pov_story",
    name: "POV / caption story",
    description: "3–5 beats, each with a caption line that tells a mini story in the pet's voice.",
    segmentSeconds: [2.5, 5],
    playbook:
      "Relatable mini-story told through on-screen text, often in the pet's inner voice or as 'POV:'. " +
      "3–5 beats of 2.5–5s. Each beat gets ONE short caption (max ~8 words) that escalates the joke. " +
      "The footage illustrates the captions; the last beat is the punchline.",
  },
  then_vs_now: {
    id: "then_vs_now",
    name: "Then vs now",
    description: "Oldest footage vs newest footage — the 'puppy vs now' glow-up.",
    segmentSeconds: [2.5, 5],
    playbook:
      "Emotional/glow-up format. First half uses the OLDEST footage (puppy era), second half the NEWEST. " +
      "Label beats with short captions like 'THEN' / 'NOW' or the year. Hook like '{pet} then vs now'. " +
      "Pick visually comparable shots when possible (same pose, same place).",
  },
};

/** Hooks that work well for pet content; {pet} is replaced with the pet's name. */
export const HOOK_BANK: Record<TemplateId, string[]> = {
  quick_cuts: [
    "{pet} has absolutely no chill",
    "Rate {pet}'s energy 1–10",
    "A day in the life of {pet}",
    "Tell me you have a dog without telling me",
    "{pet} speedrunning chaos",
    "Things {pet} did today:",
  ],
  single_moment: [
    "Wait for it...",
    "{pet} was NOT prepared for this",
    "I can't believe I caught this on camera",
    "Watch {pet}'s face",
    "The way {pet} reacted",
  ],
  pov_story: [
    "POV: you're {pet}",
    "{pet}'s inner monologue:",
    "How {pet} sees the world",
    "{pet} explaining the whole day",
  ],
  then_vs_now: ["{pet} then vs now", "From tiny puppy to this", "Nobody warned me {pet} would grow"],
};

export const POV_LINES = [
  "Me pretending I didn't hear 'bath time'",
  "Did someone say walk??",
  "Acting innocent after the crime",
  "The zoomies have chosen violence",
  "Waiting for a treat like",
  "When you finally get the toy",
  "Me after 5 minutes alone",
  "Ok but what if I just... lay here",
];

export const DEFAULT_HASHTAGS = ["dogsoftiktok", "dog", "puppy", "funnydog", "fyp"];
