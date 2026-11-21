import { test, expect } from '../helpers/fixtures';

// App boot (map-core.js whenAppBooted, which the URL routes and the model view wait for) waits for
// the app's scripts, stylesheets and map core, not for window `load`: `load` also waits for every
// basemap tile, and one tile its server never answered held every route open.
test('the app boots while its basemap tiles never arrive', async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, () => { /* held open: never answered */ });
  await page.addInitScript(() => window.addEventListener('appBooted', () => { (window as any).__bootedForTest = true; }));
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__bootedForTest === true, null, { timeout: 20_000 });
  // The tiles are still out, so window `load` has not fired: boot did not wait for it.
  expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  expect(await page.evaluate(() => [...document.images].some(img => !img.complete && /tile\.openstreetmap\.org/.test(img.src)))).toBe(true);
});
