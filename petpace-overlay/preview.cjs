const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
(async () => {
  const dir = path.join(__dirname, 'frames'); fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + path.join(__dirname, 'overlay.html'));
  await p.evaluate(() => {
    document.body.classList.add('preview');
    const tc = document.createElement('div'); tc.id = 'tc';
    tc.style.cssText = 'position:absolute;right:60px;top:560px;font:700 64px Inter,sans-serif;color:#fff';
    document.body.appendChild(tc);
  });
  const fps = 15, total = await p.evaluate(() => OVERLAY.TOTAL);
  for (let f = 0; f < total * fps; f++) {
    await p.evaluate(t => { OVERLAY.render(t); document.getElementById('tc').textContent = '0:' + String(Math.floor(t)).padStart(2,'0'); }, f / fps);
    await p.screenshot({ path: path.join(dir, String(f).padStart(5,'0') + '.png'), clip: { x: 0, y: 480, width: 1080, height: 720 } });
  }
  await b.close();
})();
