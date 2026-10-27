// Renders overlay.html to transparent PNG frames, then encodes video with ffmpeg.
// Usage: NODE_PATH=$(npm root -g) node render.cjs
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
  const dir = __dirname;
  const frames = path.join(dir, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.join(dir, 'overlay.html'));
  await page.evaluate(() => document.fonts.ready);
  const { TOTAL, FPS } = await page.evaluate(() => ({ TOTAL: OVERLAY.TOTAL, FPS: OVERLAY.FPS }));

  const n = Math.round(TOTAL * FPS);
  for (let f = 0; f < n; f++) {
    await page.evaluate((t) => OVERLAY.render(t), f / FPS);
    await page.screenshot({ path: path.join(frames, String(f).padStart(5, '0') + '.png'), omitBackground: true });
  }
  await browser.close();

  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const src = `-framerate ${FPS} -i "${frames}/%05d.png"`;
  // transparent ProRes 4444 (Premiere, Final Cut, DaVinci, CapCut desktop)
  execSync(`ffmpeg -y ${src} -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "${out}/lex-vitals-transparent.mov"`, { stdio: 'inherit' });
  // green screen MP4 (CapCut mobile: Overlay > Chroma key)
  execSync(`ffmpeg -y -f lavfi -i color=c=0x00ff00:s=1080x1920:r=${FPS} ${src} -filter_complex "[0][1]overlay=shortest=1,format=yuv420p" -c:v libx264 -crf 16 "${out}/lex-vitals-greenscreen.mp4"`, { stdio: 'inherit' });
  execSync(`ffmpeg -y -ss 10 -i "${out}/lex-vitals-greenscreen.mp4" -frames:v 1 "${out}/preview-takeoff.png"`, { stdio: 'inherit' });
})();
