/**
 * The public landing page: what signed-out visitors see at "/". The hero phone tells the story:
 * a camera roll (styled like the iPhone Photos app), one clip gets picked, it grows into a
 * viral-style video, and it's posted. Photos are free Unsplash images loaded by the visitor's
 * browser; each sits on a soft color so a missing image never shows as broken.
 */

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
 * The hero rotates through three stories. Each picks a different photo from the roll and gives
 * it text that fits that photo. (View and post counts are illustrative.)
 */
const STORIES = [
  { tile: 5, lines: ["he heard the word", "'walk' from three", "rooms away"], tags: ["dogsoftiktok", "puppylove", "goldenretriever"], views: "3.4M", tag: "puppylove", posts: "2.8M", likes: 48 },
  { tile: 10, lines: ["POV: she just", "discovered her", "own feet"], tags: ["babiesoftiktok", "babytok", "momlife"], views: "2.7M", tag: "babytok", posts: "1.9M", likes: 61 },
  { tile: 3, lines: ["the beach day", "that fixed my", "whole week"], tags: ["beachday", "summervibes", "oceanlover"], views: "1.6M", tag: "beachday", posts: "3.1M", likes: 27 },
  { tile: 1, lines: ["POV: you finally", "booked the trip", "you kept talking about"], tags: ["vacation", "windowseat", "wanderlust"], views: "2.1M", tag: "windowseat", posts: "1.2M", likes: 39 },
];
const photoBg = (i: number, w = 240) => `url(${U(PHOTOS[i][0], w, w)}) center/cover, ${PHOTOS[i][1]}`;

export function landingHtml(opts: { signInUrl: string; google: boolean }): string {
  const first = STORIES[0];
  const heroBg = (tile: number) => `url(${U(PHOTOS[tile][0], 720, 1520)}) center/cover, ${PHOTOS[tile][1]}`;
  const storiesJson = JSON.stringify(STORIES.map((st) => ({ ...st, bg: heroBg(st.tile), r: Math.floor(st.tile / 4), c: st.tile % 4 })));
  const g = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
  const cta = (cls = "") =>
    `<a class="btn ${cls}" href="${opts.signInUrl}">${opts.google ? `${g}Sign in with Google` : "Sign in"}</a>`;

  // 24 tiles, 4 per row; some are videos (duration badge), some favorites (heart).
  const durations: Record<number, string> = { 1: "0:24", 5: "0:17", 7: "1:02", 10: "0:09", 14: "0:31", 17: "0:12", 20: "0:45" };
  const favorites = new Set([3, 12, 22]);
  const tiles = PHOTOS.map((_, i) => ({ i, r: Math.floor(i / 4), c: i % 4, d: durations[i], fav: favorites.has(i) }));
  const captions = [
    "POV: the energy shift at the gate",
    "nobody: / my dog at 6am:",
    "tell me you have a poodle without telling me",
    "first class behavior, economy ticket",
    "the audacity of this dog",
    "me: it's a quick flight / him:",
    "rating his airport behavior: 11/10",
    "things that just make sense: a poodle on a plane",
  ];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollcut · your camera roll, turned into TikToks</title>
<meta name="description" content="Rollcut turns the videos already on your phone into ready-to-post TikToks, with text based on videos that got millions of views. You just swipe.">
<meta property="og:title" content="Rollcut · your camera roll, turned into TikToks">
<meta property="og:description" content="Ready-to-post videos from your camera roll, every day. You just swipe.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎞️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--ink:#0b0b0f;--paper:#fafafa;--muted:#8b8b98;--accent:#fe2c55;--accent2:#ff8a3d;--cyan:#25f4ee;--yellow:#ffe41a;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;background:var(--ink);color:#fff;font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px;position:relative}

/* ---- Nav ---- */
nav{display:flex;justify-content:space-between;align-items:center;padding:20px 0;position:relative;z-index:3}
.logo{font-weight:900;font-size:22px;letter-spacing:-.03em;text-decoration:none;display:flex;align-items:center;gap:8px}
.logo i{width:26px;height:26px;border-radius:8px;background:conic-gradient(from 210deg,var(--accent),var(--accent2),var(--yellow),var(--cyan),var(--accent));display:inline-block}
.signin{font-weight:600;font-size:15px;text-decoration:none;padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.18)}
.signin:hover{background:rgba(255,255,255,.08)}

/* ---- Hero ---- */
.hero{position:relative;padding:40px 0 90px}
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

/* ---- Demo phone: swipes on its own ---- */
.stage{position:relative;justify-self:center;width:min(310px,80vw)}
.phone{position:relative;aspect-ratio:9/19;border-radius:46px;background:#000;padding:11px;
  box-shadow:0 0 0 1.5px rgba(255,255,255,.14),0 40px 90px rgba(0,0,0,.6),0 0 120px rgba(254,44,85,.25);transform:rotate(-3deg)}
.screen{position:relative;height:100%;border-radius:36px;overflow:hidden;background:#111}
.stamp{position:absolute;top:40%;padding:4px 12px;border:4px solid;border-radius:10px;font-weight:900;font-size:30px;letter-spacing:.06em;background:rgba(255,255,255,.9);opacity:0}
.stamp.yes{left:12%;color:#16a34a;transform:rotate(-14deg)}
@keyframes bob{50%{transform:translateY(-8px) rotate(-3deg)}}
.ui{position:absolute;bottom:6%;left:0;right:0;display:flex;justify-content:center;gap:28px;z-index:5}
.ui span{width:60px;height:60px;border-radius:50%;display:grid;place-items:center;font-size:26px;font-weight:900;box-shadow:0 8px 20px rgba(0,0,0,.35)}
.ui .n{background:#fff;color:#dc2626;border:3px solid #dc2626}
.ui .y{background:#16a34a;color:#fff}
.chip{position:absolute;z-index:6;display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:13px;font-weight:600;color:var(--ink);
  background:#fff;padding:10px 14px;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.45);animation:float 6s ease-in-out infinite}
.chip small{color:#6b6b76;font-weight:500}
.c1{top:9%;left:-34%}
.c2{top:47%;right:-36%;animation-delay:-2s}
.c3{bottom:-9%;left:8%;animation-delay:-4s}
@keyframes float{50%{transform:translateY(-10px)}}

/* ---- Hero story: camera roll -> one clip is picked -> it becomes a viral-style video -> posted ---- */
.story{--T:12s;background:#fff;container-type:size}
.stage{--pr:0;--pc:1}
.roll-ui{position:absolute;inset:0;background:#fff;animation:rollUi var(--T) infinite;font-family:-apple-system,"SF Pro Text",Inter,system-ui,sans-serif}
/* iPhone Photos look: status bar, big "Recents", edge-to-edge square grid with hairline gaps */
.ios-status{position:absolute;top:0;left:0;right:0;height:7cqh;display:flex;justify-content:space-between;align-items:center;padding:0 9cqw 0 11cqw;color:#000;font-size:4.6cqw}
.ios-icons{display:flex;align-items:flex-end;gap:1.2cqw}
.ios-icons i{width:1cqw;background:#000;border-radius:.4cqw}
.ios-icons i:nth-child(1){height:1.6cqw}.ios-icons i:nth-child(2){height:2.4cqw}.ios-icons i:nth-child(3){height:3.2cqw}
.ios-icons em{width:7cqw;height:3.4cqw;border:.5cqw solid #000;border-radius:1cqw;margin-left:1.5cqw;background:linear-gradient(90deg,#000 70%,transparent 70%) content-box;padding:.4cqw}
.roll-head{position:absolute;top:7.5cqh;left:4cqw;right:4cqw;display:flex;justify-content:space-between;align-items:center;color:#000}
.roll-head b{font-size:9cqw;font-weight:800;letter-spacing:-.03em}
.roll-head span{font-size:4.2cqw;font-weight:600;color:#000;background:rgba(0,0,0,.07);padding:1.2cqw 3.6cqw;border-radius:99px}
.tile{position:absolute;width:24.625cqw;height:24.625cqw;left:calc(var(--c) * 25.125cqw);top:calc(16cqh + var(--r) * 25.125cqw)}
.tile em{position:absolute;right:1.6cqw;bottom:1cqw;font-style:normal;font-size:3.3cqw;font-weight:600;color:#fff;text-shadow:0 0 3px rgba(0,0,0,.6)}
.tile u{position:absolute;left:1.6cqw;bottom:.8cqw;text-decoration:none;font-size:3.6cqw;color:#fff;text-shadow:0 0 3px rgba(0,0,0,.6)}
.roll-count{position:absolute;left:0;right:0;bottom:12.5cqh;text-align:center;font-size:3.6cqw;font-weight:600;color:#8e8e93;background:linear-gradient(transparent,#fff 45%);padding-top:6cqh}
.ios-tabs{position:absolute;left:0;right:0;bottom:0;height:11cqh;display:flex;justify-content:space-around;align-items:flex-start;padding-top:2cqh;
  background:rgba(249,249,249,.94);border-top:.3cqw solid rgba(0,0,0,.12);color:#8e8e93;font-size:5.4cqw}
.ios-tabs span{display:grid;justify-items:center;gap:.4cqh;line-height:1}
.ios-tabs small{font-size:2.6cqw;font-weight:600}
.ios-tabs .on{color:#007aff}
/* the AI's highlight scanning the roll, then locking onto the picked clip */
.ring{position:absolute;width:24.625cqw;height:24.625cqw;border:1.2cqw solid var(--accent);box-shadow:0 0 0 1.4cqw rgba(254,44,85,.25);z-index:2;
  left:0;top:16cqh;animation:scan var(--T) infinite}
@keyframes scan{
  0%,4%{opacity:0;left:0;top:16cqh}
  6%{opacity:1;left:0;top:16cqh}
  12%{opacity:1;left:75.375cqw;top:16cqh}
  18%{opacity:1;left:50.25cqw;top:calc(16cqh + 50.25cqw)}
  24%,30%{opacity:1;left:calc(var(--pc) * 25.125cqw);top:calc(16cqh + var(--pr) * 25.125cqw);transform:scale(1)}
  27%{opacity:1;transform:scale(1.08)}
  32%,100%{opacity:0;left:calc(var(--pc) * 25.125cqw);top:calc(16cqh + var(--pr) * 25.125cqw)}}
@keyframes rollUi{0%,30%{opacity:1}38%,97%{opacity:0}100%{opacity:1}}
/* the picked tile grows into the full video */
.clip{--from:inset(calc(16cqh + var(--pr) * 25.125cqw) calc(75.375cqw - var(--pc) * 25.125cqw) calc(84cqh - var(--pr) * 25.125cqw - 24.625cqw) calc(var(--pc) * 25.125cqw));position:absolute;inset:0;display:grid;place-items:center;
  clip-path:var(--from);opacity:0;animation:grow var(--T) infinite}
@keyframes grow{
  0%,30%{opacity:0;clip-path:var(--from);transform:none}
  31%{opacity:1}
  40%{clip-path:inset(0 0 0 0 round 36px)}
  84%{opacity:1;transform:none;clip-path:inset(0 0 0 0 round 36px)}
  95%{opacity:1;clip-path:inset(0 0 0 0 round 36px)}
  100%{opacity:0;transform:none;clip-path:inset(0 0 0 0 round 36px)}}
.clip .emo{font-size:120px;filter:drop-shadow(0 16px 24px rgba(0,0,0,.4));animation:bob 2.4s ease-in-out infinite}
.ov{position:absolute;top:12%;left:7%;right:7%;display:grid;justify-items:center;text-align:center;color:var(--yellow);font-weight:900;font-size:21px;line-height:1.18;
  -webkit-text-stroke:1.2px #1a1400;paint-order:stroke fill;text-shadow:3px 3px 0 rgba(0,0,0,.35)}
.ov span{opacity:0;animation:line var(--T) infinite}
.ov .l1{--a:43%}.ov .l2{animation-name:line2}.ov .l3{animation-name:line3}
@keyframes line{0%,43%{opacity:0;transform:translateY(8px) scale(.96)}46%,95%{opacity:1;transform:none}100%{opacity:0}}
@keyframes line2{0%,48%{opacity:0;transform:translateY(8px) scale(.96)}51%,95%{opacity:1;transform:none}100%{opacity:0}}
@keyframes line3{0%,53%{opacity:0;transform:translateY(8px) scale(.96)}56%,95%{opacity:1;transform:none}100%{opacity:0}}
.tags{position:absolute;bottom:20%;left:6%;right:6%;display:flex;flex-wrap:wrap;justify-content:center;gap:5px;opacity:0;animation:tags var(--T) infinite}
.tags span{font-size:11px;font-weight:700;color:#fff;background:rgba(0,0,0,.45);padding:4px 8px;border-radius:999px}
@keyframes tags{0%,60%{opacity:0;transform:translateY(10px)}64%,78%{opacity:1;transform:none}81%,100%{opacity:0}}
.clip .ui{opacity:0;animation:uiIn var(--T) infinite}
@keyframes uiIn{0%,58%{opacity:0}62%,78%{opacity:1}81%,100%{opacity:0}}
.clip .ui .y{animation:press var(--T) infinite}
@keyframes press{0%,70%{transform:none}72%{transform:scale(.86)}74%,100%{transform:none}}
.clip .stamp.yes{animation:stampPost var(--T) infinite}
@keyframes stampPost{0%,72%{opacity:0;transform:rotate(-14deg) scale(1.4)}74%,79%{opacity:1;transform:rotate(-14deg) scale(1)}81%,100%{opacity:0}}
/* the posted video in a neutral social feed: rail of actions, likes counting up, handle + caption */
@property --likes{syntax:"<integer>";inherits:false;initial-value:0}
.feed{position:absolute;inset:0;opacity:0;animation:feedIn var(--T) infinite;pointer-events:none;color:#fff;font-family:-apple-system,Inter,system-ui,sans-serif}
@keyframes feedIn{0%,80%{opacity:0}84%,95%{opacity:1}100%{opacity:0}}
.feed::before{content:"";position:absolute;inset:0;background:linear-gradient(transparent 55%,rgba(0,0,0,.55))}
.feed-top{position:absolute;top:5%;left:0;right:0;display:flex;justify-content:center;gap:16px;font-size:13px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.feed-top span{opacity:.65}.feed-top b{border-bottom:2px solid #fff;padding-bottom:3px}
.rail{position:absolute;right:4%;bottom:16%;display:grid;gap:14px;justify-items:center;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.rail i{font-style:normal;font-size:26px;line-height:1;display:block}
.rail .h i{color:#fe2c55;animation:heart var(--T) infinite}
@keyframes heart{0%,84%{transform:scale(.6)}87%{transform:scale(1.35)}90%,100%{transform:scale(1)}}
.rail .h b{--likes:0;counter-reset:likes var(--likes);animation:likes var(--T) infinite}
.rail .h b::after{content:counter(likes) "K"}
@keyframes likes{0%,82%{--likes:0}95%,100%{--likes:var(--max,48)}}
.who{position:absolute;left:5%;right:22%;bottom:7%;text-align:left;font-size:12px;line-height:1.35;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.who b{display:block;font-size:13px;margin-bottom:2px}
.cap{position:absolute;left:50%;bottom:16%;z-index:3;transform:translateX(-50%);white-space:nowrap;font-size:12px;font-weight:700;color:#fff;background:rgba(17,17,20,.85);
  padding:7px 12px;border-radius:999px;opacity:0;animation:capIn var(--T) infinite}
@keyframes capIn{0%,8%{opacity:0}11%,30%{opacity:1}33%,100%{opacity:0}}
/* the floating proof chips appear when their moment happens */
.stage .chip{animation:float 6s ease-in-out infinite,chip1 var(--T,12s) infinite;opacity:0}
.stage .c2{animation:float 6s ease-in-out infinite -2s,chip2 12s infinite}
.stage .c3{animation:float 6s ease-in-out infinite -4s,chip3 12s infinite}
@keyframes chip1{0%,45%{opacity:0}49%,90%{opacity:1}94%,100%{opacity:0}}
@keyframes chip2{0%,61%{opacity:0}65%,90%{opacity:1}94%,100%{opacity:0}}
@keyframes chip3{0%,73%{opacity:0}76%,96%{opacity:1}99%,100%{opacity:0}}
.ctas.stack{flex-direction:column;align-items:flex-start;gap:10px}

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
  .roll-ui{opacity:0}.clip{opacity:1;clip-path:none}.ov span,.tags,.clip .ui,.stage .chip{opacity:1}
  .r{opacity:1;transform:none}
}
</style></head><body>

<header class="hero">
  <div class="glow"></div><div class="grid"></div>
  <div class="wrap">
    <nav><a class="logo" href="/"><i></i>Rollcut</a><a class="signin" href="${opts.signInUrl}">Sign in</a></nav>
    <div class="hero-in">
      <div>
        <div class="pill r"><b></b>Now in beta</div>
        <h1 class="r d1">Your camera roll, turned into <span class="rot" aria-live="polite"><span class="grad word">TikToks.</span></span></h1>
        <p class="lead r d2">For everyone who films everything and posts nothing, but dreams of being a creator.</p>
        <div class="ctas stack r d3">${cta()}<span class="note">Invite-only for now.</span></div>
      </div>
      <div class="stage r d2" aria-hidden="true">
        <div class="phone"><div class="screen story">
          <div class="roll-ui">
            <div class="ios-status"><b>9:41</b><span class="ios-icons"><i></i><i></i><i></i><em></em></span></div>
            <div class="roll-head"><b>Recents</b><span>Select</span></div>
            ${tiles.map((t) => `<i class="tile" style="--r:${t.r};--c:${t.c};background:${photoBg(t.i)}">${t.d ? `<em>${t.d}</em>` : ""}${t.fav ? `<u>♥</u>` : ""}</i>`).join("")}
            <i class="ring"></i>
            <div class="roll-count">1,284 Photos, 312 Videos</div>
            <div class="ios-tabs"><span class="on">▦<small>Library</small></span><span>❤︎<small>For You</small></span><span>▢<small>Albums</small></span><span>⌕<small>Search</small></span></div>
          </div>
          <div class="clip" style="background:${heroBg(first.tile)}">
            <div class="ov">${first.lines.map((l, i) => `<span class="l${i + 1}">${l}</span>`).join("")}</div>
            <div class="tags">${first.tags.map((t) => `<span>#${t}</span>`).join("")}</div>
            <span class="stamp yes">POST</span>
            <div class="feed">
              <div class="feed-top"><span>Following</span><b>For You</b></div>
              <div class="rail"><span class="h"><i>♥</i><b></b></span><span><i>💬</i>1,204</span><span><i>↗</i>3.9K</span></div>
              <div class="who"><b>@you · just now</b><span class="feed-cap">${first.lines.join(" ")} ✨</span></div>
            </div>
            <div class="ui"><span class="n">✕</span><span class="y">✓</span></div>
          </div>
          <div class="cap">Picking the best moment…</div>
        </div></div>
        <div class="chip c1">🔥 <span>Text from a <span class="v">${first.views}</span>-view TikTok</span></div>
        <div class="chip c2"><span>#<span class="t">${first.tag}</span></span> <small><span class="p">${first.posts}</span> posts</small></div>
        <div class="chip c3">✓ Posted · caption and hashtags included</div>
      </div>
    </div>
  </div>
</header>



<div class="light">
  <section class="block"><div class="wrap">
    <p class="eyebrow r">How it works</p>
    <h2 class="r d1">Three steps. Then it runs itself.</h2>
    <p class="sub r d2">No editing app, no scrolling for ideas, no guessing which caption will land.</p>
    <div class="steps">
      <div class="step r"><div class="big">1</div><div class="ic">📸</div><h3>Connect your album</h3><p>Share a Google Photos album, or let it fill itself with every video of your pet. New footage is picked up automatically.</p></div>
      <div class="step r d1"><div class="big">2</div><div class="ic">✨</div><h3>Videos made for you</h3><p>Each clip is trimmed, gets text adapted from TikToks that already went viral, and three hashtags sized to get seen.</p></div>
      <div class="step r d2"><div class="big">3</div><div class="ic">👉</div><h3>Swipe to post</h3><p>Right opens TikTok or Instagram with the caption ready to paste. Left skips it. Every swipe makes the next round better.</p></div>
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
      <div class="arrow r d1">→</div>
      <div class="r d2">
        <div class="posts">
          ${[[2, "POV: the energy shift at the gate"], [5, "me: quick flight / him:"], [13, "first class behavior, economy ticket"]]
            .map(([i, t]) => `<div class="post" style="--c:url(${U(PHOTOS[i as number][0], 300, 534)}) center/cover, ${PHOTOS[i as number][1]}"><b>${t}</b><span>Posted</span></div>`).join("")}
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
        <div class="demo"><span class="tag">🔥 2.1M views</span><span class="tag">🔥 1.7M views</span><span class="tag">🔥 940K views</span></div></div>
      <div class="feat r d1"><h3>Hashtags that get seen</h3><p>One big, one mid-size, one niche: the mix that gets you discovered instead of buried.</p>
        <div class="demo"><span class="tag">#travelwithdog <small>2.4M</small></span><span class="tag">#flyingwithdog <small>240K</small></span><span class="tag">#dogatairport <small>11K</small></span></div></div>
      <div class="feat r"><h3>Learns your taste</h3><p>Every swipe tells it what you like. Rejected because of the text, the clip or the cut? The next round adjusts.</p>
        <div class="demo"><span class="tag">✓ Posted</span><span class="tag">✕ The text</span><span class="tag">✕ The clip</span></div></div>
      <div class="feat r d1"><h3>Your look, every time</h3><p>Your font, your colors, your text size. Every video looks like you made it in CapCut, minus the hour.</p>
        <div class="demo"><span class="tag" style="color:#ffe41a">Yellow</span><span class="tag">Outline</span><span class="tag">Box</span></div></div>
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
  // The platform word in the headline: TikToks, Reels, Shorts, posts.
  (() => {
    const el = document.querySelector(".rot .word");
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const words = ["TikToks.", "Reels.", "Shorts.", "posts."];
    let i = 0;
    setInterval(() => {
      el.classList.add("out");
      setTimeout(() => {
        i = (i + 1) % words.length;
        el.textContent = words[i];
        el.classList.remove("out");
        el.classList.add("in");
        el.offsetWidth; // restart from below
        el.classList.remove("in");
      }, 450);
    }, 2400);
  })();
  // Rotate the hero story each loop: new photo, its own text, hashtags and numbers.
  (() => {
    const stories = ${storiesJson};
    const stage = document.querySelector(".stage");
    const clip = stage && stage.querySelector(".clip");
    if (!clip) return;
    stories.forEach((st) => { const m = /url\(([^)]+)\)/.exec(st.bg); if (m) new Image().src = m[1]; });
    let i = 0;
    const show = (st) => {
      stage.style.setProperty("--pr", st.r);
      stage.style.setProperty("--pc", st.c);
      clip.style.background = st.bg;
      clip.querySelectorAll(".ov span").forEach((el, k) => (el.textContent = st.lines[k] || ""));
      clip.querySelectorAll(".tags span").forEach((el, k) => (el.textContent = "#" + (st.tags[k] || "")));
      stage.querySelector(".c1 .v").textContent = st.views;
      stage.querySelector(".c2 .t").textContent = st.tag;
      stage.querySelector(".c2 .p").textContent = st.posts;
      stage.querySelector(".rail .h b").style.setProperty("--max", st.likes);
      stage.querySelector(".feed-cap").textContent = st.lines.join(" ") + " ✨";
    };
    show(stories[0]);
    clip.addEventListener("animationiteration", (e) => {
      if (e.animationName !== "grow") return;
      i = (i + 1) % stories.length;
      show(stories[i]);
    });
  })();
  // Reveal sections as they scroll into view.
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll(".r").forEach((el) => io.observe(el));
</script>
</body></html>`;
}
