// Renders overlay.html to video for CapCut.
// Usage: NODE_PATH=$(npm root -g) node render.cjs
//   out/lex-vitals-greenscreen.mp4  -> CapCut phone: Overlay, then Remove background > Chroma key
//   out/lex-vitals-transparent.mov  -> CapCut desktop / Premiere / DaVinci (has real transparency)
//   out/lex-vitals-black-screen.mp4 -> CapCut phone: Overlay, then Blend > Screen (smooth edges, no keying)
//   out/lex-vitals-transparent.webm -> small transparent file to try in CapCut phone (keeps soft shadow)
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function frames(page, dir, keyable) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  await page.evaluate((k) => document.body.classList.toggle('keyable', k), keyable);
  const { TOTAL, FPS } = await page.evaluate(() => ({ TOTAL: OVERLAY.TOTAL, FPS: OVERLAY.FPS }));
  for (let f = 0; f < Math.round(TOTAL * FPS); f++) {
    await page.evaluate((t) => OVERLAY.render(t), f / FPS);
    await page.screenshot({ path: path.join(dir, String(f).padStart(5, '0') + '.png'), omitBackground: true });
  }
  return FPS;
}

(async () => {
  const dir = __dirname, out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.join(dir, 'overlay.html'));
  await page.evaluate(() => document.fonts.ready);

  const soft = path.join(dir, 'frames-soft');
  let fps = await frames(page, soft, false);
  execSync(`ffmpeg -loglevel error -y -framerate ${fps} -i "${soft}/%05d.png" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "${out}/lex-vitals-transparent.mov"`);

  execSync(`ffmpeg -loglevel error -y -framerate ${fps} -i "${soft}/%05d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 2M -auto-alt-ref 0 "${out}/lex-vitals-transparent.webm"`);

  const hard = path.join(dir, 'frames-hard');
  fps = await frames(page, hard, true);
  execSync(`ffmpeg -loglevel error -y -f lavfi -i color=c=0x00ff00:s=1080x1920:r=${fps} -framerate ${fps} -i "${hard}/%05d.png" -filter_complex "[0][1]overlay=shortest=1,format=yuv420p" -c:v libx264 -crf 16 -movflags +faststart "${out}/lex-vitals-greenscreen.mp4"`);

  execSync(`ffmpeg -loglevel error -y -f lavfi -i color=c=black:s=1080x1920:r=${fps} -framerate ${fps} -i "${hard}/%05d.png" -filter_complex "[0][1]overlay=shortest=1,format=yuv420p" -c:v libx264 -crf 14 -movflags +faststart "${out}/lex-vitals-black-screen.mp4"`);

  await browser.close();
  fs.rmSync(soft, { recursive: true, force: true });
  fs.rmSync(hard, { recursive: true, force: true });
})();
