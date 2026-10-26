// Parcel loads that never finish: the ground fallback opens, a design link still applies by its own
// geometry without parcels, and a design link whose index read hangs gives the map its parcels back.
import { Browser, Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, showProposal, confirmDesignOnlyShare } from '../helpers/runtime';
import { attachSharedIndex, cidOfObject, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

const LOAD_TIMEOUT_MS = 500;
const DELAYED_ROUTE_MS = 1500;
const TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABmJLR0QA/wD/AP+gvaeTAAAAFElEQVQImWNkYGD4z8DAwMDEAAUADigBA7Y4ytMAAAAASUVORK5CYII=', 'base64');

async function delayParcelResponsesPastDeadline(
  page: Page,
  pattern: string | RegExp,
  matches: (request: Request) => boolean = request => {
    const url = new URL(request.url());
    return /\/parcels?(?:\/|$)/i.test(url.pathname)
      || url.pathname.includes('/parcel-sources/')
      || url.hostname === 'oss.uredjenazemlja.hr';
  }
): Promise<() => number> {
  let held = 0;
  await page.route(pattern, async route => {
    const request = route.request();
    if (!matches(request)) {
      await route.fallback();
      return;
    }
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') {
      await route.fallback();
      return;
    }
    held += 1;
    // Keep the intercepted response pending past the app's short test deadline. The browser
    // abort may be reported only after Playwright releases the route, so this bounded wait also
    // lets us observe the cancellation without leaving a route handler hanging after the test.
    await new Promise(resolve => setTimeout(resolve, DELAYED_ROUTE_MS));
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } catch { /* The app's AbortSignal may already have cancelled the intercepted request. */ }
  });
  return () => held;
}

async function setLoadTimeout(page: Page): Promise<void> {
  await page.addInitScript(timeout => {
    (window as any).PARCEL_LOAD_TIMEOUT_MS = timeout;
  }, LOAD_TIMEOUT_MS);
}

async function mockBasemapTiles(page: Page): Promise<void> {
  // URL-driven proposal routes wait for window.load. Keep the metadata-timeout case independent
  // of the live OSM tile service so the deep-link handler starts deterministically.
  await page.route(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//,
    route => route.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG }));
}

// Holds every POST /designs/batch (a design link's index read) until released, counting them.
async function holdIndexReads(page: Page): Promise<{ held: () => number; release: () => void }> {
  let held = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.endsWith('/designs/batch'), async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    held += 1;
    await gate;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], count: 0 }) });
    } catch { /* The app's deadline may already have cancelled the intercepted request. */ }
  });
  return { held: () => held, release };
}

async function createReceiver(
  browser: Browser,
  baseURL: string | undefined,
  index: SharedIndex,
  city: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(({ timeout, city }) => {
    (window as any).PARCEL_LOAD_TIMEOUT_MS = timeout;
    try {
      localStorage.setItem('cb_current_city', city);
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch { /* opaque origin */ }
  }, { timeout: LOAD_TIMEOUT_MS, city });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedIndex(page, index);
  return { page, close: () => context.close() };
}

// A park published through its details' Share: the index that holds it, its CID and its city.
async function publishPark(page: Page): Promise<{ index: SharedIndex; cid: string; city: string }> {
  await openCity(page);
  const city = await page.evaluate(() => String((window as any).CityConfigManager.getCurrentCityId()));
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Timeout tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  const drawingId = await createSpace(page, 'park');
  await showProposal(page, drawingId);
  await page.locator('#proposal-details-panel .btn-share-proposal').click();
  await confirmDesignOnlyShare(page);
  const index = pageIndex(page);
  await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
  await page.evaluate(() => (window as any).hideProposalDetailsPanel(true));
  return { index, cid: [...index.designs.keys()][0], city };
}

test('a hung viewport parcel request opens the ground fallback and clears the fetch flag', async ({ mockApi: page }) => {
  await setLoadTimeout(page);
  const held = await delayParcelResponsesPastDeadline(page, '**/*');
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.evaluate(() => {
    const w = window as any;
    void w.fetchParcelData(w.map.getBounds()).catch(() => {});
  });

  const dialog = page.locator('.ground-fallback-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.locator('[data-option="without-parcels"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any)._fetchParcelDataInProgress)).toBe(false);
  await expect.poll(() => held()).toBeGreaterThan(0);
});

test('a design link survives Continue without parcels and applies its saved site geometry', async ({ browser, baseURL, mockApi: author }) => {
  test.setTimeout(150_000);
  const { index, cid, city } = await publishPark(author);
  const row = index.designs.get(cid)!;
  const boundIds = row.binding.parcels.map((hit: any) => String(hit.parcelId)).sort();
  const siteGeometry = row.content.structureProposal?.geometry;
  expect(boundIds.length).toBeGreaterThan(0);
  expect(siteGeometry).toBeTruthy();
  const localId = `design-${cid}`;

  const receiver = await createReceiver(browser, baseURL, index, city);
  try {
    const held = await delayParcelResponsesPastDeadline(receiver.page, '**/*');
    await receiver.page.goto(`/designs/${cid}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(receiver.page);
    const dialog = receiver.page.locator('.ground-fallback-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => held()).toBeGreaterThan(0);

    const pathname = await receiver.page.evaluate(() => location.pathname);
    await Promise.all([
      receiver.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      dialog.locator('[data-option="without-parcels"]').click()
    ]);
    await expect.poll(() => receiver.page.evaluate(() => location.pathname)).toBe(pathname);
    await expect.poll(() => receiver.page.evaluate(id => sessionStorage.getItem(`cb_without_parcels:${id}`), city)).toBe('1');

    // Without parcels the link applies its design by its own geometry, as the index bound it.
    await expect.poll(() => receiver.page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage?.getProposal(id);
      return !!record && !!w.isProposalCurrentlyApplied(record);
    }, localId), { timeout: 60_000 }).toBe(true);
    const applied = await receiver.page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(id);
      return {
        declaredIds: (record?.cadastreParcelIds || []).map(String).sort(),
        geometry: record?.structureProposal?.geometry,
        cadastralFeatureCount: w.CadastralParcelRepository.snapshot().featureCount
      };
    }, localId);
    expect(applied.declaredIds).toEqual(boundIds);
    expect(applied.geometry).toEqual(siteGeometry);
    expect(applied.cadastralFeatureCount).toBe(0);
    expect(await receiver.page.evaluate(() => location.pathname)).toBe(pathname);
  } finally {
    await receiver.close();
  }
});

test('a design-link index read that hangs gives up at the deadline, releases deep-link parcel suppression and says so', async ({ mockApi: page }) => {
  await setLoadTimeout(page);
  await mockBasemapTiles(page);
  const cid = cidOfObject({ schema: 'design/v1', title: 'A design whose index read hangs' });
  const index = await holdIndexReads(page);
  try {
    await page.goto(`/designs/${cid}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);

    await expect.poll(() => index.held()).toBeGreaterThan(0);
    // The read is still held: only the deadline can have ended the route.
    await expect.poll(() => page.evaluate(() => (window as any).skipParcelFetchUntilProposalLoaded), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any)._fetchParcelDataInProgress || false)).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).statusLogEntries()
      .some((entry: any) => /could not be reached/i.test(entry.message)))).toBe(true);
    expect(await page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), `design-${cid}`)).toBe(false);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/designs/${cid}`);
  } finally {
    index.release();
  }
});
