const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + path.join(__dirname, 'overlay.html'));
  await p.evaluate(() => { document.body.classList.add('preview'); OVERLAY.render(12); });
  await p.screenshot({ path: path.join(__dirname, 'mock-takeoff.png') });
  await p.evaluate(() => OVERLAY.render(2));
  await p.screenshot({ path: path.join(__dirname, 'mock-checkin.png') });
  await b.close();
})();
