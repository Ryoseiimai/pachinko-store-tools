const { chromium } = require('/Users/ryoseiworld/dev/tmp-orca-trial-2039775250133709047/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: '/Users/ryoseiworld/dev/2026-09-02-pachinko-store-tools/marketing/videos_raw/keiei', size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();
  await page.goto('http://localhost:8793/keiei.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Drag the utilRate slider gradually
  const util = page.locator('#utilRate');
  const box = await util.boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
  await page.mouse.down();
  for (const frac of [0.2, 0.35, 0.5, 0.65, 0.8, 0.9]) {
    await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(180);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);

  // Raise fixed rent value
  await page.fill('#fixRent', '2500000');
  await page.locator('#fixRent').dispatchEvent('input');
  await page.locator('#fixRent').dispatchEvent('change');
  await page.waitForTimeout(1500);

  // Show sensitivity table
  await page.evaluate(() => document.getElementById('sensBody').scrollIntoView({behavior:'smooth', block:'center'}));
  await page.waitForTimeout(1500);

  // Show scenario comparison
  await page.evaluate(() => document.getElementById('scenarioBox').scrollIntoView({behavior:'smooth', block:'center'}));
  await page.waitForTimeout(1500);

  // Monte carlo results
  await page.evaluate(() => document.getElementById('mcMed').scrollIntoView({behavior:'smooth', block:'center'}));
  await page.waitForTimeout(2000);

  await context.close();
  await browser.close();
  console.log('done keiei');
})();
