const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
(async () => {
  const dir = path.join(__dirname, 'frames'); fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + path.join(__dirname, 'overlay.html'));
  await p.evaluate(() => document.body.classList.add('preview'));
  const fps = 15, total = await p.evaluate(() => OVERLAY.TOTAL);
  for (let f = 0; f < total * fps; f++) {
    await p.evaluate(t => OVERLAY.render(t), f / fps);
    await p.screenshot({ path: path.join(dir, String(f).padStart(5,'0') + '.png'), clip: { x: 0, y: 150, width: 720, height: 720 } });
  }
  await b.close();
})();
