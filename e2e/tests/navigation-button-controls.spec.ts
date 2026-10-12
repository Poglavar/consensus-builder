// Cover map search, globe navigation, city switching, and real Leaflet zoom controls.
import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedProposalServer, createSharedProposalServer, SharedProposalServer } from '../helpers/mocks/shared-server';

async function cityDevice(browser: import('@playwright/test').Browser, server: SharedProposalServer, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'explore');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedProposalServer(page, server);
  return { context, page };
}

async function publishSharedPark(page: import('@playwright/test').Page, server: SharedProposalServer): Promise<Record<string, any>> {
  await openCity(page);
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Navigation test author');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.GuestPolicy.check('share', { isGuest: w.getCurrentUserAgent?.()?.isGuest }).allowed;
  })).toBe(true);
  const proposalId = await createSpace(page, 'park');
  await showProposal(page, proposalId);
  await page.locator('.btn-share-proposal').click();
  await page.locator('.share-modal-overlay').getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.locator('.share-modal-overlay .share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
  expect(server.records.size).toBe(1);
  return server.records.values().next().value as Record<string, any>;
}

test.describe('Navigation button controls @features', () => {
  test('the map-search city chip opens the globe; mobile legend and city-label popup toggle and close', async ({ mockApi: page }) => {
    await openCity(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const chip = page.locator('.map-search__chip');
    await expect(chip).toBeVisible();
    await chip.click();
    const world = page.locator('#world-view');
    await expect(world).toBeVisible();

    const legend = world.getByRole('button', { name: 'Map legend' });
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('aria-expanded', 'false');
    await legend.click();
    await expect(legend).toHaveAttribute('aria-expanded', 'true');
    await expect(world.locator('.world-legend')).toHaveClass(/world-legend--open/);
    await legend.click();
    await expect(legend).toHaveAttribute('aria-expanded', 'false');

    const citySearch = world.locator('.world-search__input');
    // Tokyo is a live city with a large enough population to receive a label at mobile zoom.
    await citySearch.fill('Tokyo');
    const cityOption = world.getByRole('option').filter({ hasText: 'Tokyo' }).first();
    await expect(cityOption).toBeVisible();
    await cityOption.click();
    const popup = world.locator('.world-popup');
    await expect(popup.locator('.world-popup__title')).toHaveText('Tokyo');
    await popup.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popup).toBeHidden();

    const label = world.locator('.world-city-label:not(.world-city-label--hidden)').filter({ hasText: 'Tokyo' });
    await expect(label).toBeVisible({ timeout: 15_000 });
    const cityName = (await label.innerText()).trim();
    await label.click();
    await expect(popup).toBeVisible();
    await expect(popup.locator('.world-popup__title')).toHaveText(cityName);
    // A live-city popup offers the explicit city landing action in addition to Close.
    await Promise.all([
      page.waitForURL(url => url.searchParams.get('city') === 'tokyo', { timeout: 30_000 }),
      popup.getByRole('button', { name: 'Open Tokyo', exact: true }).click(),
    ]);
    await waitForMapReady(page);
    await expect(world).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('tokyo');
  });

  test('search Clear empties the query and removes its matching results', async ({ mockApi: page }) => {
    await page.route('https://photon.komoot.io/api/**', route => route.fulfill({ json: { features: [] } }));
    await openCity(page);
    await page.locator('.map-search__icon-button').click();
    const input = page.locator('#map-search-input');
    await input.fill('Belgrade');
    await expect(page.locator('.map-search__clear')).toBeVisible();
    await expect(page.locator('.map-search__results [role="option"]').filter({ hasText: /^Belgrade/ }).first()).toBeVisible();
    await page.locator('.map-search__clear').click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.map-search__clear')).toBeHidden();
    await expect(page.locator('.map-search__results [role="option"]').filter({ hasText: /^Belgrade/ })).toHaveCount(0);
  });

  test('an incoming Explore-city proposal asks before switching; Stay strips its route and Open follows the proposal city', async ({ mockApi: author, browser }) => {
    test.setTimeout(180_000);
    const server = createSharedProposalServer();
    await attachSharedProposalServer(author, server);
    const record = await publishSharedPark(author, server);
    const proposalId = String(record.proposalId);
    const baseURL = new URL(author.url()).origin;

    const staying = await cityDevice(browser, server, baseURL);
    try {
      await staying.page.goto(`/proposals/${record.id}?city=explore&reduceMotion=1`);
      const prompt = staying.page.locator('.city-switch-dialog');
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      await expect(prompt).toContainText('Zagreb');
      await prompt.getByRole('button', { name: 'Stay in Explore', exact: true }).click();
      await expect(prompt).toHaveCount(0);
      await expect.poll(() => staying.page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('explore');
      await expect.poll(() => new URL(staying.page.url()).pathname).toBe('/');
      const stayedUrl = new URL(staying.page.url());
      expect(stayedUrl.searchParams.get('city')).toBe('explore');
      expect(stayedUrl.searchParams.has('focusProposal')).toBe(false);
      expect(stayedUrl.searchParams.has('proposalShare')).toBe(false);
      expect(await staying.page.evaluate(id => (window as any).proposalStorage.getAllProposals().some((p: any) => String(p.proposalId) === id), proposalId)).toBe(false);
    } finally {
      await staying.context.close();
    }

    const opening = await cityDevice(browser, server, baseURL);
    try {
      await opening.page.goto(`/proposals/${record.id}?city=explore&reduceMotion=1`);
      const prompt = opening.page.locator('.city-switch-dialog');
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      const openInRequestedCity = prompt.locator('.cb-dialog__footer .btn-primary');
      await expect(openInRequestedCity).toContainText('Open in Zagreb');
      await Promise.all([
        // This shared route is already on /proposals/<server-id>; following it changes the city
        // query and reloads that proposal URL instead of rewriting it to ?focusProposal=.
        opening.page.waitForURL(url => url.searchParams.get('city') === 'zagreb' && url.pathname === `/proposals/${record.id}`, { timeout: 30_000 }),
        openInRequestedCity.click(),
      ]);
      await waitForMapReady(opening.page);
      await expect.poll(() => opening.page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
      await expect.poll(() => opening.page.evaluate(id => (window as any).proposalStorage.getAllProposals().some((p: any) => String(p.proposalId) === id), proposalId), { timeout: 30_000 }).toBe(true);
    } finally {
      await opening.context.close();
    }
  });

  test('floor-plan location map zoom controls change the real Leaflet zoom', async ({ mockApi: page }) => {
    await page.addInitScript(() => {
      let leaflet: any;
      Object.defineProperty(window, 'L', {
        configurable: true,
        get: () => leaflet,
        set: value => {
          leaflet = value;
          if (!leaflet || typeof leaflet.map !== 'function' || leaflet.map.__archiveMapCapture) return;
          const createMap = leaflet.map;
          const captureMap = function(this: any, ...args: any[]) {
            const instance = createMap.apply(this, args);
            (window as any).__archiveLocationMap = instance;
            return instance;
          };
          (captureMap as any).__archiveMapCapture = true;
          leaflet.map = captureMap;
        }
      });
    });
    await page.route('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', route => route.fulfill({ path: path.resolve(__dirname, '../../frontend/vendor/leaflet-1.9.4/leaflet.js'), contentType: 'application/javascript' }));
    await page.route('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', route => route.fulfill({ path: path.resolve(__dirname, '../../frontend/vendor/leaflet-1.9.4/leaflet.css'), contentType: 'text/css' }));
    await page.route('**/floor-plan-archive/catalogue', route => route.fulfill({ json: {
      buildings: [{ id: 'registered-1', name: 'Navigation Fixture', kind: 'registered', planCount: 1, locationAvailable: true, wholeBuildingAvailable: false }],
      sources: [], counts: { buildings: 1, sources: 0 },
    } }));
    await page.route('**/floor-plan-archive/status', route => route.fulfill({ json: { coverage: { agencies: { total: 0, websites: 0 } }, lastRun: null } }));
    await page.route('**/floor-plan-archive/agencies?*', route => route.fulfill({ json: { agencies: [] } }));
    await page.route('**/floor-plan-archive/building/registered-1', route => route.fulfill({ json: {
      id: 'registered-1', name: 'Navigation Fixture', kind: 'registered', plans: [{ id: 'ground', label: 'Ground floor' }],
      location: { latitude: 45.8, longitude: 15.98, basis: 'landmark' }, footprint: null, wholeBuilding: null,
    } }));
    await page.goto('/floor-plan-archive.html?lang=en');
    const map = page.locator('#map');
    await expect(map.locator('.leaflet-control-zoom')).toBeVisible();
    await expect(map.locator('.leaflet-marker-icon, .leaflet-interactive')).toHaveCount(1);
    const initialZoom = await page.evaluate(() => (window as any).__archiveLocationMap.getZoom());
    await map.locator('.leaflet-control-zoom-in').click();
    await expect.poll(() => page.evaluate(() => (window as any).__archiveLocationMap.getZoom())).toBe(initialZoom + 1);
    await map.locator('.leaflet-control-zoom-out').click();
    await expect.poll(() => page.evaluate(() => (window as any).__archiveLocationMap.getZoom())).toBe(initialZoom);

  });
});
