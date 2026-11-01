import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The public landing page: what signed-out visitors see at "/". The hero phone tells the story:
 * a camera roll (styled like the iPhone Photos app), one clip gets picked, it grows into a
 * viral-style video, and it's posted. Photos are free Unsplash images loaded by the visitor's
 * browser; each sits on a soft color so a missing image never shows as broken.
 */


/** Line icons (Lucide-style, 24px grid, stroke = currentColor). No emoji on the page. */
const ICONS: Record<string, string> = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  sparkle: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  share: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  album: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v8l3-2 3 2V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  inbox: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
const ico = (name: string, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const U = (id: string, w: number, h: number) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=60`;
/** Unsplash photos for a believable camera roll: people, travel, food, dogs. [id, fallback color] */
const PHOTOS: [string, string][] = [
  ["1494790108377-be9c29b29330", "#e8c9b5"], // portrait, smiling
  ["1436491865332-7a61a109cc05", "#9fc4e8"], // plane wing above clouds
  ["1495474472287-4d71bcdd2085", "#c8a888"], // coffee
  ["1507525428034-b723cf961d3e", "#8fd0e0"], // beach
  ["1529156069898-49953e39b3ac", "#d8c0a0"], // friends
  ["1587300003388-59208cc962cb", "#e6c79a"], // puppy (the clip that gets picked)
  ["1504674900247-0877df9cc836", "#d9a77f"], // food
  ["1501785888041-af3ef285b470", "#8fb3a8"], // lake and mountains
  ["1500648767791-00dcc994a43e", "#c9b19b"], // portrait
  ["1517849845537-4d257902454a", "#d6c1a6"], // dog
  ["1519689680058-324335c77eba", "#ead9cf"], // baby
  ["1469474968028-56623f02e42e", "#9bb88a"], // landscape
  ["1438761681033-6461ffad8d80", "#d9b8a8"], // portrait
  ["1543466835-00a7907e9de1", "#c7b7a0"], // dog
  ["1476514525535-07fb3b4ae5f1", "#8fb8c8"], // lake trip
  ["1517248135467-4c7edcad34c4", "#b89880"], // restaurant
  ["1544005313-94ddf0286df2", "#d4b4a4"], // portrait
  ["1530281700549-e82e7bf110d6", "#c9b49a"], // dog
  ["1583337130417-3346a1be7dee", "#d2bfa4"], // dog
  ["1507525428034-b723cf961d3e", "#8fd0e0"],
  ["1495474472287-4d71bcdd2085", "#c8a888"],
  ["1436491865332-7a61a109cc05", "#9fc4e8"],
  ["1529156069898-49953e39b3ac", "#d8c0a0"],
  ["1501785888041-af3ef285b470", "#8fb3a8"],
];
/**
 * Your own images win over the stock ones: drop files named roll-01.jpg … roll-24.jpg into
 * public/landing/ (e.g. one consistent set of AI images of the same person) and they're used
 * for the camera roll, the stories and the grid, in that order.
 */
const LOCAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "landing");
const local = (i: number) => {
  const name = `roll-${String(i + 1).padStart(2, "0")}.jpg`;
  return fs.existsSync(path.join(LOCAL_DIR, name)) ? `/landing/${name}` : null;
};
const photoUrl = (i: number, w: number, h: number) => local(i) ?? U(PHOTOS[i][0], w, h);
const photoBg = (i: number, w = 240) => `url(${photoUrl(i, w, w)}) center/cover, ${PHOTOS[i][1]}`;

/** The logo, a winking face: the tab icon (fills its square) and the mark next to the name. */
export const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%20100%20100%22%3E%3Crect%20width=%22100%22%20height=%22100%22%20rx=%2226%22%20fill=%22%23F5A300%22/%3E%3Cellipse%20cx=%2236%22%20cy=%2240%22%20rx=%226.5%22%20ry=%228%22%20fill=%22%232B1A00%22/%3E%3Cpath%20d=%22M57%2041Q64%2034%2071%2041%22%20fill=%22none%22%20stroke=%22%232B1A00%22%20stroke-width=%227%22%20stroke-linecap=%22round%22/%3E%3Cpath%20d=%22M30%2058Q50%2078%2070%2058%22%20fill=%22none%22%20stroke=%22%232B1A00%22%20stroke-width=%228.5%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E";
export const LOGO_MARK = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%226%206%2088%2088%22%3E%3Crect%20x=%226%22%20y=%226%22%20width=%2288%22%20height=%2288%22%20rx=%2232%22%20fill=%22%23F5A300%22/%3E%3Cellipse%20cx=%2236%22%20cy=%2240%22%20rx=%226.5%22%20ry=%228%22%20fill=%22%232B1A00%22/%3E%3Cpath%20d=%22M57%2041Q64%2034%2071%2041%22%20fill=%22none%22%20stroke=%22%232B1A00%22%20stroke-width=%227%22%20stroke-linecap=%22round%22/%3E%3Cpath%20d=%22M30%2058Q50%2078%2070%2058%22%20fill=%22none%22%20stroke=%22%232B1A00%22%20stroke-width=%228.5%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E";

/**
 * The hero shows real videos made with Rollcut, each in a phone with its view count. Until the real
 * ones are added, each is a template: a photo with its text, marked "Example". To use a real video,
 * drop hero-1.mp4 … hero-3.mp4 into public/landing/ and fill in its views.
 */
const HERO_VIDEOS = [
  { photo: 9, lines: ["POV: the energy shift", "at the gate"], views: "" },
  { photo: 5, lines: ["he heard the word 'walk'", "from three rooms away"], views: "" },
  { photo: 1, lines: ["first class behavior,", "economy ticket"], views: "" },
];
/** The proof line under the videos: the account and its real numbers (empty shows a placeholder). */
const PROOF = { handle: "@lexintheair", views: "", days: 30 };
/** Before / after: a raw clip from the camera roll (its photo) and the post made from it. */
const BEFORE_AFTER = { photo: 13, lines: ["the audacity", "of this dog"] };
const heroVideo = (i: number) => {
  const name = `hero-${i + 1}.mp4`;
  return fs.existsSync(path.join(LOCAL_DIR, name)) ? `/landing/${name}` : null;
};

export function landingHtml(opts: { signInUrl: string; google: boolean }): string {
  const g = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
  const cta = (cls = "") =>
    `<a class="btn ${cls}" href="${opts.signInUrl}">${opts.google ? `${g}Sign in with Google` : "Sign in"}</a>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#fff8f4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1b1206" media="(prefers-color-scheme: dark)">
<title>Rollcut · your camera roll, turned into TikToks</title>
<meta name="description" content="Rollcut turns the videos already on your phone into ready-to-post TikToks, with text based on videos that got millions of views. You just swipe.">
<meta property="og:title" content="Rollcut · your camera roll, turned into TikToks">
<meta property="og:description" content="Ready-to-post videos from your camera roll, every day. You just swipe.">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Google+Sans+Flex:opsz,wght,ROND@6..144,400..900,100&display=swap" rel="stylesheet">
<style>
:root{--ink:#0b0b0f;--paper:#fafafa;--muted:#8b8b98;--accent:#fe2c55;--accent2:#ff8a3d;--cyan:#25f4ee;--yellow:#ffe41a;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;background:var(--ink);color:#fff;font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px;position:relative}

/* ---- Nav ---- */
nav{display:flex;justify-content:space-between;align-items:center;padding:14px 0;position:relative;z-index:3}
.logo{font-weight:900;font-size:22px;letter-spacing:-.03em;text-decoration:none;display:flex;align-items:center;gap:8px}
.logo i{width:26px;height:26px;border-radius:8px;background:conic-gradient(from 210deg,var(--accent),var(--accent2),var(--yellow),var(--cyan),var(--accent));display:inline-block}
.signin{font-weight:600;font-size:15px;text-decoration:none;padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.18)}
.signin:hover{background:rgba(255,255,255,.08)}

/* ---- Hero ---- */
.hero{position:relative;padding:0 0 90px}
.hero-in{margin-top:28px}
.glow{position:absolute;inset:-200px -20% auto;height:900px;pointer-events:none;z-index:0;
  background:radial-gradient(40% 40% at 25% 35%,rgba(254,44,85,.35),transparent 70%),radial-gradient(35% 35% at 75% 30%,rgba(255,138,61,.28),transparent 70%),radial-gradient(30% 30% at 60% 70%,rgba(37,244,238,.14),transparent 70%);
  filter:blur(20px);animation:drift 14s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate3d(3%,4%,0) scale(1.08)}}
.grid{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:.25;
  background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);
  background-size:56px 56px;mask-image:radial-gradient(70% 60% at 50% 30%,#000,transparent)}
.hero-in{position:relative;z-index:2;display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);margin-bottom:22px}
.pill b{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.2)}
h1{font-size:clamp(44px,7.4vw,92px);line-height:.95;letter-spacing:-.05em;margin:0 0 22px;font-weight:900}
.rot{display:inline-block;position:relative;vertical-align:bottom}
.rot .word{display:inline-block;transition:transform .45s cubic-bezier(.2,.7,.2,1),opacity .45s ease}
.rot .word.out{transform:translateY(-40%);opacity:0}
.rot .word.in{transform:translateY(40%);opacity:0;transition:none}
.grad{background:linear-gradient(92deg,var(--accent) 0%,var(--accent2) 45%,var(--yellow) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:clamp(17px,2.1vw,21px);color:#c4c4cf;margin:0 0 32px;max-width:31em}
.ctas{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:10px;padding:16px 24px;border-radius:16px;font-weight:700;text-decoration:none;font-size:16px;
  background:#fff;color:var(--ink);box-shadow:0 10px 40px rgba(254,44,85,.35);transition:transform .15s ease,box-shadow .15s ease}
.btn:hover{transform:translateY(-2px);box-shadow:0 14px 50px rgba(254,44,85,.5)}
.note{font-size:14px;color:var(--muted)}

/* ---- Icons ---- */
.ico{width:1em;height:1em;vertical-align:-.15em;flex:none}
.ico.fill{fill:currentColor}
.step .ic .ico{width:26px;height:26px;color:var(--accent)}
.arrow .ico{width:44px;height:44px;stroke-width:2.6}
.ui .ico{width:26px;height:26px;stroke-width:3}
.rail i .ico{width:26px;height:26px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.ios-tabs .ico{width:6cqw;height:6cqw}
.tile u .ico{width:3.6cqw;height:3.6cqw;color:#fff;filter:drop-shadow(0 0 2px rgba(0,0,0,.5))}
.chip .ico.ok{width:16px;height:16px;color:#16a34a;stroke-width:3}
.tag .ico{width:14px;height:14px;stroke-width:2.6}

/* ---- Light sections ---- */
.light{background:var(--paper);color:var(--ink)}
section.block{padding:100px 0}
.eyebrow{font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px}
h2{font-size:clamp(32px,4.6vw,56px);line-height:1.02;letter-spacing:-.04em;margin:0 0 18px;font-weight:900}
.sub{font-size:19px;color:#5e5e6a;max-width:36em;margin:0}

.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:52px}
.step{position:relative;background:#fff;border:1px solid #e8e8ee;border-radius:26px;padding:30px 26px 28px;overflow:hidden;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 20px 50px rgba(0,0,0,.05)}
.step .big{font-size:110px;font-weight:900;line-height:.8;letter-spacing:-.06em;position:absolute;right:16px;top:14px;color:#f1f1f5}
.step .ic{position:relative;width:52px;height:52px;border-radius:16px;display:grid;place-items:center;font-size:26px;margin-bottom:20px;
  background:linear-gradient(135deg,#fff0f3,#fff4e8)}
.step h3{position:relative;margin:0 0 8px;font-size:22px;letter-spacing:-.02em}
.step p{position:relative;margin:0;color:#5e5e6a}

/* camera roll -> posts */
.flow{display:grid;grid-template-columns:1fr auto 1fr;gap:28px;align-items:center;margin-top:52px}
.roll{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:14px;border-radius:26px;background:#fff;border:1px solid #e8e8ee}
.roll i{aspect-ratio:1;border-radius:8px;background:var(--c);opacity:.9}
.roll i.pick{outline:3px solid var(--accent);outline-offset:-3px;opacity:1}
.arrow{font-size:44px;color:var(--accent);font-weight:900}
.posts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.post{aspect-ratio:9/16;border-radius:16px;background:var(--c);position:relative;overflow:hidden;box-shadow:0 14px 30px rgba(0,0,0,.15)}
.post b{position:absolute;top:10%;left:6%;right:6%;text-align:center;font-size:11px;line-height:1.15;color:var(--yellow);-webkit-text-stroke:.5px #000;font-weight:900}
.post span{position:absolute;bottom:6px;left:6px;font-size:10px;font-weight:700;color:#fff;background:#16a34a;padding:2px 7px;border-radius:999px}
.flowcap{display:flex;justify-content:space-between;margin-top:14px;font-size:14px;color:#6b6b76;font-weight:600}

/* features */
.feats{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-top:52px}
.feat{border-radius:26px;padding:30px;background:var(--ink);color:#fff;position:relative;overflow:hidden}
.feat:nth-child(2){background:linear-gradient(135deg,#fe2c55,#ff8a3d)}
.feat:nth-child(3){background:#fff;color:var(--ink);border:1px solid #e8e8ee}
.feat:nth-child(4){background:linear-gradient(135deg,#0f2a2a,#15514f)}
.feat h3{margin:0 0 8px;font-size:24px;letter-spacing:-.02em}
.feat p{margin:0;opacity:.8}
.feat .demo{margin-top:22px;display:flex;flex-wrap:wrap;gap:8px}
.tag{font-size:13px;font-weight:700;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.14)}
.feat:nth-child(3) .tag{background:#f3f3f6}
.tag small{opacity:.7;font-weight:600}

/* final CTA */
.final{position:relative;text-align:center;padding:120px 0;overflow:hidden}
.final h2{font-size:clamp(36px,6vw,76px)}
.final p{color:#c4c4cf;font-size:19px;margin:0 0 34px}
.final .ctas{justify-content:center}
footer{padding:28px 0 40px;color:var(--muted);font-size:14px;display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.08)}

/* scroll reveal */
.r{opacity:0;transform:translateY(24px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}
.r.in{opacity:1;transform:none}
.r.d1{transition-delay:.08s}.r.d2{transition-delay:.16s}.r.d3{transition-delay:.24s}

@media (max-width:900px){
  .hero-in{grid-template-columns:1fr;text-align:center;gap:70px}
  .lead{margin-left:auto;margin-right:auto}
  .ctas{justify-content:center}
  .ctas.stack{align-items:center}
  .pill{margin-left:auto;margin-right:auto}
  .c1{left:-14%;top:4%}.c2{right:-14%}.c3{left:4%;bottom:-8%}
  .steps,.feats{grid-template-columns:1fr}
  .flow{grid-template-columns:1fr;justify-items:center}
  .arrow{transform:rotate(90deg)}
  .flow > div:not(.arrow){width:100%;max-width:420px}
  section.block{padding:72px 0}
}
@media (max-width:480px){
  .chip{font-size:12px;padding:8px 11px}
  .c1{left:-6%}.c2{right:-8%}.c3{left:-6%}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none !important;transition:none !important}
  .r{opacity:1;transform:none}
}

/* ---- Hero: the promise, then real videos made with Rollcut, each with its views ---- */
.rc{position:relative;padding:0 0 64px;background:var(--md-surface,#fff8f4);color:var(--md-on-surface,#231a0d)}
.rc-top{text-align:center;padding:10px 0 0}
.rc-top h1{margin:0 auto;font-size:clamp(36px,5.4vw,68px);line-height:1.02;letter-spacing:-.035em;font-weight:800;max-width:13em}
.rc-top h1 .y{color:var(--md-primary,#825500)}
.rc-top p{margin:14px auto 22px;font-size:clamp(16px,1.7vw,20px);line-height:1.45;color:var(--md-on-surface-variant,#534432);max-width:30em}
.rc-top .note{display:block;margin-top:10px}
.rc-vids{display:flex;justify-content:center;align-items:center;gap:22px;margin:40px auto 0;padding:0 20px}
.rc-vid{position:relative;flex:none;width:min(230px,28vw);aspect-ratio:9/16;border-radius:26px;overflow:hidden;background:#111;box-shadow:0 24px 60px rgba(60,30,0,.22);border:6px solid #111}
.rc-vid:nth-child(2){width:min(270px,33vw);z-index:2}
.rc-vid img,.rc-vid video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.rc-vid .ov{position:absolute;left:0;right:0;top:14%;display:flex;justify-content:center;padding:0 10px}
.rc-vid .ov b{background:#F5C400;color:#111;font-size:clamp(11px,1.1vw,14px);line-height:1.2;font-weight:800;padding:6px 9px;border-radius:7px;text-align:center}
.rc-vid .views{position:absolute;left:10px;bottom:10px;display:inline-flex;align-items:center;gap:5px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;font-weight:800;padding:6px 10px;border-radius:999px}
.rc-vid .views .ico{width:12px;height:12px;fill:#fff;stroke:none}
.rc-vid .ex{background:#fff;color:#111}
.rc-proof{text-align:center;margin:26px 20px 0;font-size:16px;font-weight:600;color:var(--md-on-surface-variant,#534432)}
.rc-proof b{color:var(--md-on-surface,#231a0d)}
.rc-proof .ph{background:var(--md-primary-container,#ffddb4);color:var(--md-on-primary-container,#633f00);padding:1px 8px;border-radius:6px}
/* before / after */
.ba{display:flex;justify-content:center;align-items:center;gap:28px;margin-top:36px}
.ba figure{margin:0;display:grid;gap:10px;justify-items:center}
.ba figcaption{font-weight:700;font-size:15px;color:var(--md-on-surface-variant)}
.ba .raw,.ba .done{width:min(220px,38vw);aspect-ratio:9/16;border-radius:22px;overflow:hidden;position:relative;background:#111}
.ba .raw img,.ba .done img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.ba .raw img{filter:saturate(.8) brightness(.95)}
.ba .raw em{position:absolute;right:8px;bottom:8px;color:#fff;font-style:normal;font-weight:700;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.ba .done{border:6px solid #111}
.ba .done .ov{position:absolute;left:0;right:0;top:14%;display:flex;justify-content:center;padding:0 10px}
.ba .done .ov b{background:#F5C400;color:#111;font-size:13px;line-height:1.2;font-weight:800;padding:6px 9px;border-radius:7px;text-align:center}
.ba .to .ico{width:40px;height:40px;color:var(--md-primary)}
@media (max-width:700px){
  .rc-vids{gap:10px;margin-top:30px;padding:0 8px}
  .rc-vid{width:27vw;border-width:4px;border-radius:18px}
  .rc-vid:nth-child(2){width:38vw}
  .rc-vid .views{font-size:10px;padding:4px 7px;left:6px;bottom:6px}
  .rc-vid .ov b{font-size:9px;padding:4px 6px}
  .rc-vid:nth-child(2) .ov b{font-size:11px}
  .ba{gap:12px}
  .ba .to .ico{width:26px;height:26px}
}

/* ---- Material 3 Expressive, the same tokens as the app: one amber seed, light and dark following the phone.
   Primary for the one main action, colourful containers for emphasis, big rounded shapes, cookie and sunny marks. ---- */
:root{--md-primary:#825500;--md-on-primary:#ffffff;--md-primary-container:#ffddb4;--md-on-primary-container:#633f00;--md-secondary:#725b2e;--md-on-secondary:#ffffff;--md-secondary-container:#fedea6;--md-on-secondary-container:#584419;--md-tertiary:#6f5d1b;--md-on-tertiary:#ffffff;--md-tertiary-container:#fbe191;--md-on-tertiary-container:#564502;--md-error:#ba1a1a;--md-on-error:#ffffff;--md-error-container:#ffdad6;--md-on-error-container:#93000a;--md-surface:#fff8f4;--md-surface-dim:#ead7c2;--md-surface-bright:#fff8f4;--md-surface-container-lowest:#ffffff;--md-surface-container-low:#fff1e4;--md-surface-container:#feebd6;--md-surface-container-high:#f8e5d0;--md-surface-container-highest:#f3dfcb;--md-on-surface:#231a0d;--md-on-surface-variant:#534432;--md-outline:#86745f;--md-outline-variant:#d8c3ab;--md-inverse-surface:#3a2f21;--md-inverse-on-surface:#ffeedc;--md-inverse-primary:#ffb952;--md-scrim:#000000;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--md-primary:#ffb952;--md-on-primary:#452b00;--md-primary-container:#633f00;--md-on-primary-container:#ffddb4;--md-secondary:#e0c38c;--md-on-secondary:#3f2d04;--md-secondary-container:#584419;--md-on-secondary-container:#fedea6;--md-tertiary:#dec578;--md-on-tertiary:#3c2f00;--md-tertiary-container:#564502;--md-on-tertiary-container:#fbe191;--md-error:#ffb4ab;--md-on-error:#690005;--md-error-container:#93000a;--md-on-error-container:#ffdad6;--md-surface:#1b1206;--md-surface-dim:#1b1206;--md-surface-bright:#433729;--md-surface-container-lowest:#150d03;--md-surface-container-low:#231a0d;--md-surface-container:#281e11;--md-surface-container-high:#33281b;--md-surface-container-highest:#3e3325;--md-on-surface:#f3dfcb;--md-on-surface-variant:#d8c3ab;--md-outline:#a08e78;--md-outline-variant:#534432;--md-inverse-surface:#f3dfcb;--md-inverse-on-surface:#3a2f21;--md-inverse-primary:#825500;--md-scrim:#000000;color-scheme:dark}}
:root{--cookie:polygon(100.0% 50.0%,99.2% 53.2%,97.1% 56.2%,94.4% 58.8%,91.7% 61.2%,89.8% 63.5%,89.1% 66.2%,89.3% 69.4%,89.8% 73.0%,90.1% 76.8%,89.4% 80.3%,87.5% 82.9%,84.5% 84.5%,80.8% 85.2%,77.1% 85.3%,73.7% 85.5%,71.0% 86.4%,68.9% 88.3%,67.0% 91.1%,65.0% 94.3%,62.6% 97.2%,59.7% 99.0%,56.5% 99.3%,53.2% 98.1%,50.0% 96.0%,47.1% 93.7%,44.5% 91.9%,41.8% 91.3%,38.8% 91.7%,35.5% 92.8%,31.8% 93.9%,28.2% 94.2%,25.0% 93.3%,22.6% 91.0%,21.1% 87.7%,20.2% 84.0%,19.5% 80.5%,18.4% 77.7%,16.4% 75.8%,13.6% 74.3%,10.2% 73.0%,6.8% 71.3%,4.1% 69.0%,2.7% 66.0%,2.8% 62.6%,4.1% 59.1%,5.9% 55.8%,7.4% 52.8%,8.0% 50.0%,7.4% 47.2%,5.9% 44.2%,4.1% 40.9%,2.8% 37.4%,2.7% 34.0%,4.1% 31.0%,6.8% 28.7%,10.2% 27.0%,13.6% 25.7%,16.4% 24.2%,18.4% 22.3%,19.5% 19.5%,20.2% 16.0%,21.1% 12.3%,22.6% 9.0%,25.0% 6.7%,28.2% 5.8%,31.8% 6.1%,35.5% 7.2%,38.8% 8.3%,41.8% 8.7%,44.5% 8.1%,47.1% 6.3%,50.0% 4.0%,53.2% 1.9%,56.5% 0.7%,59.7% 1.0%,62.6% 2.8%,65.0% 5.7%,67.0% 8.9%,68.9% 11.7%,71.0% 13.6%,73.7% 14.5%,77.1% 14.7%,80.8% 14.8%,84.5% 15.5%,87.5% 17.1%,89.4% 19.7%,90.1% 23.2%,89.8% 27.0%,89.3% 30.6%,89.1% 33.8%,89.8% 36.5%,91.7% 38.8%,94.4% 41.2%,97.1% 43.8%,99.2% 46.8%);--sunny:polygon(100.0% 50.0%,99.5% 53.2%,98.1% 56.3%,96.1% 59.2%,93.9% 61.8%,92.0% 64.3%,90.7% 66.8%,89.8% 69.6%,89.4% 72.8%,89.1% 76.1%,88.5% 79.5%,87.3% 82.7%,85.4% 85.4%,82.7% 87.3%,79.5% 88.5%,76.1% 89.1%,72.8% 89.4%,69.6% 89.8%,66.8% 90.7%,64.3% 92.0%,61.8% 93.9%,59.2% 96.1%,56.3% 98.1%,53.2% 99.5%,50.0% 100.0%,46.8% 99.5%,43.7% 98.1%,40.8% 96.1%,38.2% 93.9%,35.7% 92.0%,33.2% 90.7%,30.4% 89.8%,27.3% 89.4%,23.9% 89.1%,20.5% 88.5%,17.3% 87.3%,14.6% 85.4%,12.7% 82.7%,11.5% 79.5%,10.9% 76.1%,10.6% 72.8%,10.2% 69.6%,9.3% 66.8%,8.0% 64.3%,6.1% 61.8%,3.9% 59.2%,1.9% 56.3%,0.5% 53.2%,0.0% 50.0%,0.5% 46.8%,1.9% 43.7%,3.9% 40.8%,6.1% 38.2%,8.0% 35.7%,9.3% 33.2%,10.2% 30.4%,10.6% 27.3%,10.9% 23.9%,11.5% 20.5%,12.7% 17.3%,14.6% 14.6%,17.3% 12.7%,20.5% 11.5%,23.9% 10.9%,27.2% 10.6%,30.4% 10.2%,33.2% 9.3%,35.7% 8.0%,38.2% 6.1%,40.8% 3.9%,43.7% 1.9%,46.8% 0.5%,50.0% 0.0%,53.2% 0.5%,56.3% 1.9%,59.2% 3.9%,61.8% 6.1%,64.3% 8.0%,66.8% 9.3%,69.6% 10.2%,72.8% 10.6%,76.1% 10.9%,79.5% 11.5%,82.7% 12.7%,85.4% 14.6%,87.3% 17.3%,88.5% 20.5%,89.1% 23.9%,89.4% 27.2%,89.8% 30.4%,90.7% 33.2%,92.0% 35.7%,93.9% 38.2%,96.1% 40.8%,98.1% 43.7%,99.5% 46.8%);--spring:cubic-bezier(.34,1.4,.64,1);
  --ink:var(--md-on-surface);--paper:var(--md-surface);--muted:var(--md-on-surface-variant);--accent:var(--md-primary)}
body{background:var(--md-surface);color:var(--md-on-surface);font-family:"Google Sans Flex","Google Sans",Figtree,Roboto,system-ui,sans-serif;font-variation-settings:"ROND" 100}
.logo{font-weight:800;letter-spacing:-.02em}
.logo i{border-radius:0;clip-path:none;background:url("${LOGO_MARK}") center/contain no-repeat}
.signin{border:0;background:var(--md-secondary-container);color:var(--md-on-secondary-container);font-weight:700;transition:border-radius .25s var(--spring)}
.signin:hover{background:var(--md-secondary-container);filter:brightness(.96)}
.signin:active{border-radius:12px}
.glow,.grid{display:none}
/* decorative shapes behind the hero phone */
.hero{overflow:hidden}
.hero .wrap::before,.hero .wrap::after{content:"";position:absolute;z-index:0;pointer-events:none}
.hero .wrap::before{width:520px;height:520px;right:-120px;top:40px;clip-path:var(--sunny);background:var(--md-primary-container);animation:spin 60s linear infinite}
.hero .wrap::after{width:200px;height:200px;right:330px;top:470px;clip-path:var(--cookie);background:var(--md-tertiary-container);animation:spin 40s linear infinite reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.pill{background:var(--md-tertiary-container);color:var(--md-on-tertiary-container);border:0;font-weight:700}
.pill b{background:var(--md-tertiary);box-shadow:none}
h1{font-weight:800;letter-spacing:-.035em;color:var(--md-on-surface)}
h2{font-weight:800;letter-spacing:-.03em}
.grad{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--md-primary)}
.lead,.final p,.sub,.note{color:var(--md-on-surface-variant)}
.btn{background:var(--md-primary);color:var(--md-on-primary);border-radius:999px;padding:18px 28px;font-weight:700;font-size:17px;box-shadow:none;transition:border-radius .25s var(--spring),filter .15s}
.btn:hover{transform:none;box-shadow:none;filter:brightness(1.08)}
.btn:active{border-radius:16px}
.btn svg{background:#fff;border-radius:50%;padding:2px;width:22px;height:22px}
.chip{background:var(--md-surface-container-highest);color:var(--md-on-surface);border:0;border-radius:20px;box-shadow:0 6px 20px rgba(0,0,0,.12)}
.chip small{color:var(--md-on-surface-variant)}
.chip .ico,.chip .ico.ok{color:var(--md-primary)}
.phone{box-shadow:0 0 0 1.5px var(--md-outline-variant),0 30px 70px rgba(0,0,0,.25) !important}
.light{background:var(--md-surface);color:var(--md-on-surface)}
.eyebrow{color:var(--md-primary);font-weight:700;letter-spacing:0;text-transform:none;font-size:16px}
/* how it works: one container colour per step */
.step{border:0;border-radius:32px;box-shadow:none;background:var(--md-primary-container);color:var(--md-on-primary-container)}
.step:nth-child(2){background:var(--md-secondary-container);color:var(--md-on-secondary-container)}
.step:nth-child(3){background:var(--md-tertiary-container);color:var(--md-on-tertiary-container)}
.step .big{color:currentColor;opacity:.12}
.step .ic{width:60px;height:60px;border-radius:0;clip-path:var(--cookie);background:var(--md-primary);transition:transform .4s var(--spring)}
.step:nth-child(2) .ic{clip-path:var(--sunny);background:var(--md-secondary)}
.step:nth-child(3) .ic{background:var(--md-tertiary)}
.step:hover .ic{transform:rotate(30deg) scale(1.06)}
.step .ic .ico{color:var(--md-on-primary)}
.step p{color:inherit;opacity:.85}
/* roll to posts */
.roll{background:var(--md-surface-container);border:0;border-radius:32px;gap:4px}
.roll i{border-radius:6px}
.roll i.pick{outline:4px solid var(--md-primary);outline-offset:-4px;border-radius:14px}
.arrow{color:var(--md-primary)}
.post{border-radius:20px;box-shadow:none}
.post span{background:var(--md-primary);color:var(--md-on-primary)}
.flowcap{color:var(--md-on-surface-variant)}
/* why it works: bold, colourful cards */
.feat{border:0;border-radius:32px;background:var(--md-primary);color:var(--md-on-primary)}
.feat:nth-child(2){background:var(--md-tertiary-container);color:var(--md-on-tertiary-container)}
.feat:nth-child(3){background:var(--md-secondary-container);color:var(--md-on-secondary-container);border:0}
.feat:nth-child(4){background:var(--md-inverse-surface);color:var(--md-inverse-on-surface)}
.feat p{color:inherit;opacity:.85}
.tag{background:color-mix(in srgb,currentColor 14%,transparent);color:inherit;font-weight:700;display:inline-flex;align-items:center;gap:6px}
.feat:nth-child(2) .tag,.feat:nth-child(3) .tag{background:color-mix(in srgb,currentColor 12%,transparent)}
.tag .ico{width:14px;height:14px}
.tag .ico.fill{fill:currentColor;stroke:none}
/* final call: a big primary container panel */
.final{margin:0 20px 40px;border-radius:48px;background:var(--md-primary-container);color:var(--md-on-primary-container)}
.final h2,.final .grad{color:var(--md-on-primary-container)}
.final p{color:var(--md-on-primary-container);opacity:.85}
.final::before,.final::after{content:"";position:absolute;pointer-events:none;background:var(--md-primary);opacity:.18}
.final::before{width:260px;height:260px;left:-70px;top:-70px;clip-path:var(--sunny)}
.final::after{width:180px;height:180px;right:-40px;bottom:-50px;clip-path:var(--cookie)}
footer{border-top:1px solid var(--md-outline-variant);color:var(--md-on-surface-variant)}
@media (max-width:900px){
  .hero .wrap::before{width:420px;height:420px;right:50%;margin-right:-210px;top:auto;bottom:-40px}
  .hero .wrap::after{display:none}
  .final{margin:0 12px 24px;border-radius:36px}
}
@media (prefers-reduced-motion:reduce){.hero .wrap::before,.hero .wrap::after{animation:none}}
</style></head><body>

<header class="rc" id="rc">
  <div class="wrap">
    <nav><a class="logo" href="/"><i></i>Rollcut</a><a class="signin" href="${opts.signInUrl}">Sign in</a></nav>
    <div class="rc-top">
      <h1>Your camera roll, turned into <span class="y">TikToks.</span></h1>
      <p>Rollcut picks the best moments from the videos on your phone and makes them ready to post, every day.</p>
      <div class="ctas" style="justify-content:center">${cta()}</div>
      <span class="note">Invite-only beta</span>
    </div>
  </div>
  <div class="rc-vids">
    ${HERO_VIDEOS.map((v, i) => {
      const video = heroVideo(i);
      const poster = photoUrl(v.photo, 540, 960);
      return `<div class="rc-vid">${video ? `<video src="${video}" poster="${poster}" autoplay muted loop playsinline></video>` : `<img src="${poster}" alt="" style="background:${PHOTOS[v.photo][1]}"><div class="ov"><b>${v.lines.join("<br>")}</b></div>`}<span class="views${v.views ? "" : " ex"}">${v.views ? `${ico("play", "fill")} ${v.views} views` : "Example"}</span></div>`;
    }).join("")}
  </div>
  <p class="rc-proof">Made from <b>${PROOF.handle}</b>'s camera roll: ${PROOF.views ? `<b>${PROOF.views} views</b>` : `<span class="ph">X views</span>`} in ${PROOF.days} days</p>
</header>



<div class="light">
  <section class="block"><div class="wrap" style="text-align:center">
    <p class="eyebrow r">Before and after</p>
    <h2 class="r d1">A clip you forgot. A post people watch.</h2>
    <div class="ba r d2">
      <figure><div class="raw"><img src="${photoUrl(BEFORE_AFTER.photo, 440, 780)}" alt="" style="background:${PHOTOS[BEFORE_AFTER.photo][1]}"><em>0:47</em></div><figcaption>In your camera roll</figcaption></figure>
      <span class="to">${ico("arrow")}</span>
      <figure><div class="done"><img src="${photoUrl(BEFORE_AFTER.photo, 440, 780)}" alt="" style="background:${PHOTOS[BEFORE_AFTER.photo][1]}"><div class="ov"><b>${BEFORE_AFTER.lines.join("<br>")}</b></div></div><figcaption>Made by Rollcut</figcaption></figure>
    </div>
  </div></section>

  <section class="block"><div class="wrap">
    <p class="eyebrow r">How it works</p>
    <h2 class="r d1">Three steps. Then it runs itself.</h2>
    <p class="sub r d2">No editing app, no scrolling for ideas, no guessing which caption will land.</p>
    <div class="steps">
      <div class="step r"><div class="big">1</div><div class="ic">${ico("camera")}</div><h3>Pick from Google Photos</h3><p>Choose the videos you love. Rollcut only sees the ones you pick, and finds the best moment in each.</p></div>
      <div class="step r d1"><div class="big">2</div><div class="ic">${ico("sparkle")}</div><h3>Videos made for you</h3><p>Each clip is trimmed, gets text adapted from TikToks that already went viral, and three hashtags sized to get seen.</p></div>
      <div class="step r d2"><div class="big">3</div><div class="ic">${ico("send")}</div><h3>Keep or skip</h3><p>Every morning a few are ready. Keep the ones you'd post and save them, with the caption ready to paste. Every answer makes the next round better.</p></div>
    </div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="wrap">
    <p class="eyebrow r">From roll to For You</p>
    <h2 class="r d1">Thousands of clips in. Only the good ones out.</h2>
    <div class="flow">
      <div class="r">
        <div class="roll">${Array.from({ length: 16 }, (_, i) => `<i style="--c:${photoBg(i, 160)}" class="${[2, 5, 13].includes(i) ? "pick" : ""}"></i>`).join("")}</div>
        <div class="flowcap"><span>Your camera roll</span><span>3 picked</span></div>
      </div>
      <div class="arrow r d1">${ico("arrow")}</div>
      <div class="r d2">
        <div class="posts">
          ${[[2, "POV: the energy shift at the gate"], [5, "me: quick flight / him:"], [13, "first class behavior, economy ticket"]]
            .map(([i, t]) => `<div class="post" style="--c:url(${photoUrl(i as number, 300, 534)}) center/cover, ${PHOTOS[i as number][1]}"><b>${t}</b><span>Posted</span></div>`).join("")}
        </div>
        <div class="flowcap"><span>Ready to post</span><span>with captions + hashtags</span></div>
      </div>
    </div>
  </div></section>

  <section class="block" style="padding-top:0"><div class="wrap">
    <p class="eyebrow r">Why it works</p>
    <h2 class="r d1">Built on what already performs.</h2>
    <div class="feats">
      <div class="feat r"><h3>Proven text, not guesses</h3><p>It searches TikTok for videos like yours, reads the text on the most-viewed ones and adapts it to your clip.</p>
        <div class="demo"><span class="tag">${ico("play", "fill")} 2.1M views</span><span class="tag">${ico("play", "fill")} 1.7M views</span><span class="tag">${ico("play", "fill")} 940K views</span></div></div>
      <div class="feat r d1"><h3>Hashtags that get seen</h3><p>One big, one mid-size, one niche: the mix that gets you discovered instead of buried.</p>
        <div class="demo"><span class="tag">#travelwithdog <small>2.4M</small></span><span class="tag">#flyingwithdog <small>240K</small></span><span class="tag">#dogatairport <small>11K</small></span></div></div>
      <div class="feat r"><h3>Learns your taste</h3><p>Every swipe tells it what you like. Rejected because of the text, the clip or the cut? The next round adjusts.</p>
        <div class="demo"><span class="tag">${ico("check")} Posted</span><span class="tag">${ico("x")} The text</span><span class="tag">${ico("x")} The clip</span></div></div>
      <div class="feat r d1"><h3>Your look, every time</h3><p>Your font, your colors, your text size. Every video looks like you made it in CapCut, minus the hour.</p>
        <div class="demo"><span class="tag" style="background:#f5c400;color:#111">Yellow box</span><span class="tag">Outline</span><span class="tag">Bold caps</span></div></div>
    </div>
  </div></section>
</div>

<section class="final">
  <div class="glow" style="top:-100px"></div>
  <div class="wrap" style="position:relative;z-index:2">
    <h2 class="r">Stop scrolling your camera roll.<br><span class="grad">Start posting it.</span></h2>
    <p class="r d1">Built by a creator, for creators with more footage than time.</p>
    <div class="ctas r d2">${cta()}</div>
  </div>
</section>

<div class="wrap"><footer><span>© ${new Date().getFullYear()} Rollcut</span><span>Invite-only beta</span></footer></div>

<script>
  // Reveal sections as they scroll into view.
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll(".r").forEach((el) => io.observe(el));
</script>
</body></html>`;
}
