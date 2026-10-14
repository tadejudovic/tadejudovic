/**
 * The public landing page: what signed-out visitors see at "/". One screen that says what
 * Rollcut does, how it works in three steps, and how to get in (it's invite-only).
 */
export function landingHtml(opts: { signInUrl: string; google: boolean }): string {
  const cta = opts.google
    ? `<a class="btn primary" href="${opts.signInUrl}"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#fff" d="M43.6 20.5H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</a>`
    : `<a class="btn primary" href="${opts.signInUrl}">Sign in</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollcut · your camera roll, turned into TikToks</title>
<meta name="description" content="Rollcut turns the videos already on your phone into ready-to-post TikToks with captions that are proven to work. You just swipe.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎞️</text></svg>">
<style>
:root{--bg:#fafafa;--ink:#111114;--muted:#6b6b76;--line:#e7e7ec;--accent:#fe2c55;--yellow:#ffe41a;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
nav{display:flex;justify-content:space-between;align-items:center;padding:18px 0}
.logo{font-weight:800;font-size:20px;letter-spacing:-.02em;text-decoration:none}
.logo span{color:var(--accent)}
.link{font-weight:600;font-size:15px;text-decoration:none;color:var(--muted)}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center;padding:40px 0 64px}
h1{font-size:clamp(38px,6vw,64px);line-height:1.02;letter-spacing:-.035em;margin:0 0 18px;font-weight:850}
h1 em{font-style:normal;color:var(--accent)}
.lead{font-size:clamp(17px,2vw,20px);color:var(--muted);margin:0 0 28px;max-width:30em}
.ctas{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:10px;padding:14px 22px;border-radius:14px;font-weight:700;text-decoration:none;font-size:16px}
.btn.primary{background:var(--ink);color:#fff}
.btn.primary:hover{background:#2a2a30}
.note{font-size:14px;color:var(--muted)}
.phone{justify-self:center;width:min(300px,78vw);aspect-ratio:9/19;border-radius:42px;background:#111;padding:10px;box-shadow:0 30px 60px rgba(0,0,0,.18)}
.screen{position:relative;height:100%;border-radius:33px;overflow:hidden;background:radial-gradient(120% 90% at 30% 20%,#ffcf9e 0,#e98f5d 35%,#7a4b3a 70%,#2d1f1c 100%)}
.screen .text{position:absolute;top:16%;left:8%;right:8%;text-align:center;color:var(--yellow);font-weight:900;font-size:22px;line-height:1.15;
  -webkit-text-stroke:1px #1a1400;text-shadow:3px 3px 0 rgba(0,0,0,.45)}
.screen .dog{position:absolute;left:50%;bottom:28%;transform:translateX(-50%);font-size:110px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.35))}
.screen .btns{position:absolute;bottom:7%;left:0;right:0;display:flex;justify-content:center;gap:26px}
.screen .b{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;font-size:26px;font-weight:900}
.screen .no{background:#fff;color:#dc2626;border:2.5px solid #dc2626}
.screen .yes{background:#16a34a;color:#fff}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:8px 0 64px}
.step{background:#fff;border:1px solid var(--line);border-radius:20px;padding:24px}
.num{width:34px;height:34px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:800;margin-bottom:14px}
.step h3{margin:0 0 6px;font-size:19px;letter-spacing:-.01em}
.step p{margin:0;color:var(--muted);font-size:15px}
.band{background:var(--ink);color:#fff;border-radius:28px;padding:44px 32px;text-align:center;margin-bottom:56px}
.band h2{font-size:clamp(26px,4vw,38px);letter-spacing:-.02em;margin:0 0 10px}
.band p{color:#b9b9c3;margin:0 0 24px}
.band .btn.primary{background:#fff;color:var(--ink)}
.band .btn.primary svg path{fill:var(--ink)}
footer{padding:0 0 40px;color:var(--muted);font-size:14px;text-align:center}
@media (max-width:820px){
  .hero{grid-template-columns:1fr;gap:36px;padding:20px 0 48px;text-align:center}
  .lead{margin-left:auto;margin-right:auto}
  .ctas{justify-content:center}
  .steps{grid-template-columns:1fr}
}
</style></head><body>
<div class="wrap">
  <nav><a class="logo" href="/">Roll<span>cut</span></a><a class="link" href="${opts.signInUrl}">Sign in</a></nav>

  <section class="hero">
    <div>
      <h1>Your camera roll, turned into <em>TikToks</em>.</h1>
      <p class="lead">Rollcut picks your best clips, adds captions that already went viral, and hands you ready-to-post videos every day. You just swipe.</p>
      <div class="ctas">${cta}<span class="note">Invite-only for now.</span></div>
    </div>
    <div class="phone" aria-hidden="true"><div class="screen">
      <div class="text">POV: the energy shift when we pull into the airport</div>
      <div class="dog">🐩</div>
      <div class="btns"><div class="b no">✕</div><div class="b yes">✓</div></div>
    </div></div>
  </section>

  <section class="steps">
    <div class="step"><div class="num">1</div><h3>Connect your album</h3><p>Share a Google Photos album. New videos you add are picked up automatically.</p></div>
    <div class="step"><div class="num">2</div><h3>Get videos made for you</h3><p>Each clip gets text based on TikToks with millions of views, plus hashtags sized to get seen.</p></div>
    <div class="step"><div class="num">3</div><h3>Swipe to post</h3><p>Right posts it to TikTok or Instagram, left skips it. Every swipe makes the next videos better.</p></div>
  </section>

  <section class="band">
    <h2>Stop scrolling your camera roll. Start posting it.</h2>
    <p>Built by a creator, for creators with more footage than time.</p>
    ${cta}
  </section>

  <footer>© ${new Date().getFullYear()} Rollcut</footer>
</div>
</body></html>`;
}
