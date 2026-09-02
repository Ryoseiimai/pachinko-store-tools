const { chromium } = require('/Users/ryoseiworld/dev/tmp-orca-trial-2039775250133709047/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: '/Users/ryoseiworld/dev/2026-09-02-pachinko-store-tools/marketing/videos_raw/raiten', size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();
  await page.goto('http://localhost:8793/raiten.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.selectOption('#inLocation', 'road');
  await page.waitForTimeout(2000);
  await page.selectOption('#inDow', '5');
  await page.waitForTimeout(2000);
  await page.click('[data-ev="newmachine"]');
  await page.waitForTimeout(2200);
  await page.click('#btnShuffle');
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.getElementById('sourceList').scrollIntoView({behavior:'smooth', block:'center'}));
  await page.waitForTimeout(1000);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(1500);
  await context.close();
  await browser.close();
  console.log('done raiten');
})();
