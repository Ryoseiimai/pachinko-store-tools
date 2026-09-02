const { chromium } = require('/Users/ryoseiworld/dev/tmp-orca-trial-2039775250133709047/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: '/Users/ryoseiworld/dev/2026-09-02-pachinko-store-tools/marketing/videos_raw/hall3d', size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();
  page.on('console', m => console.log('PAGE:', m.text()));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto('http://localhost:8793/hall3d.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // pick mid320 template
  await page.evaluate(() => document.querySelector('[data-template="mid320"]').click());
  await page.waitForTimeout(1500);

  // run 1 day
  await page.evaluate(() => document.getElementById('btnRun').click());
  await page.waitForTimeout(2500);

  // show heatmap on the editor canvas
  await page.evaluate(() => document.getElementById('editorCanvas').scrollIntoView({behavior:'smooth', block:'center'}));
  await page.waitForTimeout(1500);

  // switch to first-person mode
  await page.evaluate(() => document.getElementById('btnModeFP').click());
  await page.waitForTimeout(1200);

  // focus the 3d viewer and walk forward
  await page.click('#view3dContainer');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);

  // tour around the hall
  await page.evaluate(() => document.getElementById('btnTour').click());
  await page.waitForTimeout(4500);

  await context.close();
  await browser.close();
  console.log('done hall3d');
})();
