// Search metadata stays lightweight, plans precede designs, and long lists own their scrolling.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_GEOMETRY, stubBasemapTiles } from '../helpers/runtime';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');

function seed(page: any, count = 1) {
  const index = pageIndex(page);
  const design = fileDesign(index, records.published({ title: 'River', city: 'zg', goal: 'park',
    site: PARCEL_GEOMETRY, structureProposal: { kind: 'park', geometry: PARCEL_GEOMETRY },
    createdAt: '2026-10-23T10:00:00Z' }));
  const cids = Array.from({ length: count }, (_, i) => filePlan(index,
    plans.create(`River district ${String(i + 1).padStart(2, '0')}`, [design], {
      at: '45.80025,15.9822,18', mode: '2d', city: 'new_york', language: 'en'
    })));
  return { index, design, cids };
}

async function searchFor(page: any, query: string) {
  await page.locator('.map-search__icon-button').click();
  const input = page.locator('#map-search-input');
  await input.fill(query);
  return input;
}

test('plans precede designs, metadata is cached, and Commands menu is absent', async ({ mockApi: page }) => {
  const { index } = seed(page, 2);
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
  await openCity(page);
  const input = await searchFor(page, 'River');
  const options = page.locator('.map-search__item--plan, .map-search__item--proposal');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText('River district 01');
  await expect(options.nth(1)).toContainText('River district 02');
  await expect(options.nth(2)).toContainText('River');
  await expect(page.locator('.map-search__results')).not.toContainText('Commands…');
  expect(index.requests.filter(row => row.path.startsWith('/designs/'))).toHaveLength(0);
  await input.fill('');
  await input.fill('River');
  await expect(options).toHaveCount(3);
  expect(index.requests.filter(row => row.path.startsWith('/search?'))).toHaveLength(1);
  // Changing only the case must keep the cached results visible too.
  await input.fill('RIVER');
  await expect(options).toHaveCount(3);
  expect(index.requests.filter(row => row.path.startsWith('/search?'))).toHaveLength(1);
});

test('Enter opens the matching plan while the geocoder is still pending', async ({ mockApi: page }) => {
  const { cids } = seed(page);
  await stubBasemapTiles(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://photon.komoot.io/api/**', async route => {
    await gate;
    await route.fulfill({ json: { features: [] } }).catch(() => {});
  });
  await openCity(page);
  const input = await searchFor(page, 'River');
  try {
    // Press immediately: catalog metadata has not arrived yet, and Photon remains blocked.
    await input.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/plans/${cids[0]}`));
    await expect.poll(() => page.evaluate(() => (window as any).NamedPlans?.current?.cid), { timeout: 30_000 }).toBe(cids[0]);
  } finally { release(); }
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 720 }]) {
  test(`long results scroll without zooming the map at ${viewport.width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize(viewport);
    seed(page, 20);
    await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
    await openCity(page);
    await searchFor(page, 'River');
    const results = page.locator('.map-search__results');
    await expect(results.locator('.map-search__item--plan, .map-search__item--proposal')).toHaveCount(21);
    const dimensions = await results.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight,
      bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }));
    expect(dimensions.content).toBeGreaterThan(dimensions.height);
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewport);
    const zoom = await page.evaluate(() => (window as any).map.getZoom());
    await results.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => results.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).map.getZoom())).toBe(zoom);
    await page.locator('#map-search-input').fill('River');
    await page.locator('#map-search-input').press('ArrowUp');
    await expect(results.locator('[role="option"]').last()).toHaveAttribute('aria-selected', 'true');
  });
}

test('a superseded response cannot replace results for the current query', async ({ mockApi: page }) => {
  seed(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/search?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'Old query') return route.fallback();
    started(); await gate;
    await route.fulfill({ json: { plans: [{ cid: 'old', title: 'Old query', designCount: 1 }], designs: [] } }).catch(() => {});
  });
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
  await openCity(page);
  const input = await searchFor(page, 'Old query');
  await requested;
  await input.fill('River');
  await expect(page.locator('.map-search__results [role="option"]').first()).toContainText('River district');
  release();
  await expect(page.locator('.map-search__results')).not.toContainText('Old query');
  await expect(page.locator('.map-search__results [role="option"]').first()).toContainText('River district');
});

test('selecting a design downloads its full record only after confirmation', async ({ mockApi: page }) => {
  const { index, design } = seed(page);
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
  await openCity(page);
  await searchFor(page, 'River');
  const option = page.locator('.map-search__item--proposal').filter({ hasText: 'River' });
  await expect(option).toBeVisible();
  expect(index.requests.filter(row => row.path === `/designs/${design}`)).toHaveLength(0);
  await option.click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Download?');
  expect(index.requests.filter(row => row.path === `/designs/${design}`)).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => page.evaluate(cid => !!(window as any).DesignSync.localCopyOf(cid), design)).toBe(true);
  expect(index.requests.filter(row => row.path === `/designs/${design}`)).toHaveLength(1);
  await expect(page.getByRole('region', { name: 'River', exact: true })).toBeVisible();
});
