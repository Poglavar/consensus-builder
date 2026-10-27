import { openPlanActions } from '../helpers/plan-actions';
// The world globe and the ground around a city: the Proposals pill, the globe's search, location and
// city picks, its activity feed (agreements proposed and decided, bets on them: plan-design-agreement.md
// M3) and city counts, wheel-out to the globe, data-source requests and open ground.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, createSpace, PARCEL_GEOMETRY } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { cidOfObject, fileDesign, pageIndex } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, proposeOverPark } from '../helpers/agreements';

// `count` parks published in Zagreb, as the design index lists them (GET /designs, newest first).
function publishParks(page: Page, count: number): string[] {
  return Array.from({ length: count }, (_, index) => fileDesign(pageIndex(page), {
    schema: 'design/v1', goal: 'park', title: `Published park ${index + 1}`, description: null, author: 'Fixture author', city: 'zagreb',
    site: PARCEL_GEOMETRY, toleranceM: null, geometry: null, origin: null, authoredAt: `2026-10-1${index % 10}T10:00:00.000Z`,
    structureProposal: { kind: 'park', blockName: null },
  }));
}

// One /activity/recent event about an agreement (backend/routes/agent-activity.js): a bet action also
// names the agreement's account.
function agreementEvent(id: string, type: string, cid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, source: 'live', ok: true, action: { type, agreementCid: cid }, entity: { type: 'agreement', id: cid },
    agreementName: 'Community park agreement', designGoal: 'park', cityId: 'zagreb', location: { lat: 45.80025, lon: 15.9822 },
    occurredAt: '2026-10-02T12:00:00Z', ...extra,
  };
}
const BET_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';

// A park drawn here, as the design/v1 object it would be published as.
const designOf = (page: Page, id: string) => page.evaluate(id => {
  const w = window as any;
  return JSON.parse(JSON.stringify(w.DesignRecord.published(w.proposalStorage.getProposal(id))));
}, id);

async function openWorldFromSettings(page: Page): Promise<void> {
  await page.locator('#settings-button').click();
  const navigation = page.locator('#settings-sheet details[data-section="navigation"]');
  if (!(await navigation.evaluate(element => (element as HTMLDetailsElement).open))) {
    await navigation.locator(':scope > summary').click();
  }
  await expect(page.locator('#world-view-button')).toBeVisible();
  await page.locator('#world-view-button').click();
}

test.describe('World navigation and open ground @features', () => {
  test('city arrival loads the proposal pill count before opening the list and stops its pulse on first opening', async ({ mockApi: page }) => {
    // The count is the city's published designs the index lists (DesignSync: the index has no count route).
    publishParks(page, 7);
    await page.goto('/?city=zg&lang=en'); await waitForMapReady(page);
    const count = page.locator('#proposals-button-count');
    await expect(count).toHaveText('7'); await expect(count).toBeVisible();
    await expect(count).toHaveClass(/is-unopened/);
    await expect(page.locator('#proposals-button')).toHaveAttribute('aria-label', 'Designs (7)');
    // The Proposals sheet mounts the list itself (fbe3758d), so opening the sheet is the first opening.
    await page.locator('#proposals-button').click();
    await expect(page.locator('#proposals-sheet .proposal-list-modal')).toBeVisible();
    await expect(count).not.toHaveClass(/is-unopened/);
  });

  test('Explore arrival counts and lists server proposals using the same visible area', async ({ mockApi: page }) => {
    // One listing answers both: GET /designs by the visible area, whose rows are the count.
    const listQueries: string[] = [];
    const rows = publishParks(page, 7).map(cid => pageIndex(page).designs.get(cid));
    await page.route(url => url.pathname.endsWith('/designs'), route => {
      if (route.request().resourceType() !== 'fetch' && route.request().resourceType() !== 'xhr') return route.fallback();
      listQueries.push(route.request().url());
      return route.fulfill({ json: { designs: rows, count: rows.length } });
    });
    // Dhaka: no configured city covers it, so the address alone opens explore there
    await page.goto('/?at=23.7104,90.4074,16&lang=en&reduceMotion=1'); await waitForMapReady(page);
    await expect(page.locator('#proposals-button-count')).toHaveText('7');
    const first = new URL(listQueries.at(-1)!);
    expect(first.searchParams.has('bbox')).toBe(true);
    expect(first.searchParams.has('city')).toBe(false);
    await page.locator('#proposals-button').click();
    await expect(page.locator('#proposals-sheet .proposal-list-modal')).toBeVisible();
    await expect.poll(() => listQueries.length).toBeGreaterThan(0);
    expect(new URL(listQueries.at(-1)!).searchParams.get('bbox')).toBe(first.searchParams.get('bbox'));
  });
  test('the world globe searches a live city and opens its configured map', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    await openCity(page);
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await expect(world).toBeVisible({ timeout: 45_000 });
    await expect(world.locator('canvas')).toBeVisible();
    await expect(world.getByRole('button', { name: 'Back to map' })).toBeVisible();
    await world.locator('.world-search__input').fill('Belgrade');
    await world.getByRole('option').filter({ hasText: 'Belgrade' }).first().click();
    await expect(world.locator('.world-popup__title')).toHaveText('Belgrade');
    await world.getByRole('button', { name: /Open Belgrade/ }).click();
    await waitForMapReady(page);
    await expect(world).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager?.getCurrentCityId?.() ?? null), { timeout: 15_000 }).toBe('belgrade');
  });

  // Show my location treats the browser's position as a search hit: the globe flies there and
  // opens what is available at that point; with no position it says so in the results. The failure
  // comes first: the app accepts a position up to a minute old, so after a fix it would reuse it.
  test('the world globe Show my location opens the place at the browser position, and says when there is none', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    // Permission granted but no fix (Playwright's emulation of an unavailable position); a refused
    // permission would prompt in headed Chrome instead of answering.
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation(null);
    await openCity(page);
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await expect(world.locator('canvas')).toBeVisible({ timeout: 45_000 });
    const locate = world.getByRole('button', { name: 'Show my location', exact: true });
    await locate.click();
    await expect(world.locator('.world-search__empty')).toHaveText('Could not get your location.', { timeout: 20_000 });

    await page.context().setGeolocation({ latitude: 44.8125, longitude: 20.4612 });
    await locate.click();
    await expect(world.locator('.world-popup__title')).toHaveText('Selected location', { timeout: 20_000 });
    await expect(world.getByRole('button', { name: 'Open the map here' })).toBeVisible();
  });

  test('the world globe excludes province destinations and opens a clicked point at street level', async ({ mockApi: page }) => {
    await openCity(page);
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await world.getByRole('combobox', { name: 'Search cities' }).fill('Ontario');
    await expect(world.getByRole('option')).toHaveCount(0);
    await expect(world.locator('.world-search__empty')).toHaveText('No matching city');
    // Orient the camera; the actual destination is then chosen by a canvas pointer click.
    await page.evaluate(async () => { await (window as any).WorldView.flyTo({ lat: 50.52, lon: -84.79 }, { altitudeKm: 8500 }); });
    const pixel = await page.evaluate(() => (window as any).WorldView.project(50.52, -84.79));
    const canvas = await world.locator('canvas').first().boundingBox();
    if (!canvas || !pixel) throw new Error('Globe destination is not visible');
    await page.mouse.click(canvas.x + pixel.x, canvas.y + pixel.y);
    await expect(world.locator('.world-popup__title')).toHaveText('Selected location');
    await expect(world.getByRole('button', { name: 'Ask for this area' })).toHaveCount(0);
    await world.getByRole('button', { name: 'Open the map here' }).click();
    await waitForMapReady(page);
    await expect(world).toHaveCount(0);
    const view = await page.evaluate(() => ({ center: (window as any).map.getCenter(), zoom: (window as any).map.getZoom() }));
    expect(view.zoom).toBe(19);
    expect(view.center.lat).toBeCloseTo(50.52, 2);
    expect(view.center.lng).toBeCloseTo(-84.79, 2);
  });

  test('Back to map closes the world globe and restores the current city map', async ({ mockApi: page }) => {
    await openCity(page);
    const cityBefore = await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId());
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await expect(world).toBeVisible();
    await world.getByRole('button', { name: 'Back to map' }).click();
    await expect(world).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe(cityBefore);
    await expect(page.locator('#map')).toBeVisible();
  });

  // A city pick arrives on the city's newest published design in 3D (js/world/arrival.js: GET
  // /designs?city=…&limit=1); a city with none lands on its map as before. Zagreb is already loaded
  // here, so the pick lands in place. The design was published elsewhere: it is downloaded, parked.
  for (const hasProposal of [true, false]) {
    test(`a city pick ${hasProposal ? 'arrives in 3D on its latest proposal' : 'with no proposals lands on the 2D map'}`, async ({ mockApi: page }) => {
      test.setTimeout(120_000);
      await openCity(page);
      let cid: string | null = null;
      if (hasProposal) {
        // Someone's park: drawn here for its object, then removed, so only the index holds it.
        const id = await createSpace(page, 'park');
        const content = await designOf(page, id);
        await page.evaluate(async id => {
          const w = window as any;
          await w.ProposalManager.unapplyProposal(id, { silent: true, suppressCameraMove: true });
          w.proposalStorage.removeProposal(id);
          w.proposalStorage.save();
        }, id);
        cid = fileDesign(pageIndex(page), content);
      }
      await page.evaluate(() => (window as any).map.setView([45.85, 16.05], 12, { animate: false }));
      await openWorldFromSettings(page);
      const world = page.locator('#world-view');
      await world.locator('.world-search__input').fill('Zagreb');
      await world.getByRole('option').filter({ hasText: 'Zagreb' }).first().click();
      await world.getByRole('button', { name: /Open Zagreb/ }).click();
      await expect(world).toHaveCount(0, { timeout: 15000 });
      const latest = () => pageIndex(page).requests.filter(request => request.method === 'GET' && /^\/designs\?/.test(request.path)
        && new URL(request.path, 'http://index').searchParams.get('limit') === '1');
      await expect.poll(() => latest().length).toBeGreaterThan(0);
      expect(new URL(latest()[0].path, 'http://index').searchParams.get('city')).toBe('zagreb');
      // The arrival caption card was removed (fbe3758d): the pick lands in 3D on the selected
      // design, and the 2D mode tile leads back to the map.
      if (hasProposal) {
        const localId = `design-${cid}`;
        await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false), { timeout: 20000 }).toBe(true);
        await expect.poll(() => page.evaluate(id => (window as any).ProposalSelection.getKey() === id, localId)).toBe(true);
        // Downloaded by its CID and parked: shown while selected, not applied, and published as that CID.
        expect(await page.evaluate(id => {
          const w = window as any;
          const record = w.getProposalByIdOrHash(id);
          return { applied: record.applied === true, cid: w.DesignSync.publishedCid(record) };
        }, localId)).toEqual({ applied: false, cid });
      } else {
        await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false)).toBe(false);
      }
    });
  }

  test('globe activity scrolls without buttons, pauses on hover and uses event colors and location labels', async ({ mockApi: page }) => {
    // Agreements proposed and decided, and bets on them; a bet opens the bet, the rest the agreement.
    const cid = cidOfObject({ schema: 'agreement/v1', title: 'Community park agreement' });
    const events = ['propose', 'execute', 'resolve', 'donate', 'stake'].map((type, index) => agreementEvent(`event-${index}`, type, cid, {
      occurredAt: `2026-10-02T12:0${index}:00Z`,
      ...(['resolve', 'stake'].includes(type) ? { agreementAccount: BET_ACCOUNT } : {}),
      ...(type === 'stake' ? { action: { type, agreementCid: cid, side: 'yes', amount: '1' } } : {}),
    }));
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events } }));
    await page.goto('/?city=zg&lang=en'); await waitForMapReady(page);
    await openWorldFromSettings(page);
    const activity = page.locator('.world-activity');
    await expect(activity.getByRole('link')).toHaveCount(5, { timeout: 15000 });
    await expect(activity.getByRole('button')).toHaveCount(0);
    await expect(activity.getByRole('link').first()).toContainText('Zagreb');
    // The newest is the bet, at its own link; the agreement's actions link the agreement.
    await expect(activity.getByRole('link').first()).toContainText(/Bet 1\sUSDC on yes/);
    await expect(activity.getByRole('link').first()).toHaveAttribute('href', `/bets/${BET_ACCOUNT}?city=zagreb&lang=en`);
    await expect(activity.locator('[data-event-type="propose"]').first()).toHaveAttribute('href', `/agreements/${cid}?city=zagreb&lang=en`);
    await expect(activity.locator('[data-event-type="propose"] .world-activity__action').first()).toHaveText('Agreement proposed');
    await expect(activity.locator('[data-event-type="execute"]').first()).toContainText('Agreement executed');
    await expect(activity.locator('[data-event-type="propose"] .world-activity__subject').first()).toHaveText('Community park agreement');
    const proposeColor = await activity.locator('[data-event-type="propose"] .world-activity__action').first().evaluate(node => getComputedStyle(node).color);
    const resolveColor = await activity.locator('[data-event-type="resolve"] .world-activity__action').first().evaluate(node => getComputedStyle(node).color);
    expect(proposeColor).not.toBe(resolveColor);
    await page.mouse.move(5, 5);
    const track = activity.locator('.world-activity__track');
    await expect(track).toHaveCSS('animation-duration', '40s');
    const before = await track.evaluate(node => getComputedStyle(node).transform);
    await expect.poll(() => track.evaluate(node => getComputedStyle(node).transform)).not.toBe(before);
    await activity.hover(); await expect(track).toHaveCSS('animation-play-state', 'paused');
    await page.screenshot({ path: '/private/tmp/colosseum-globe-activity-desktop.png' });
    await activity.locator('.world-activity__viewport').hover();
    await page.mouse.wheel(0, 160);
    await expect(activity).toHaveClass(/world-activity--manual/);
    await expect.poll(() => activity.locator('.world-activity__viewport').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(track).toHaveCSS('animation-name', 'none');
    await page.mouse.wheel(0, -1000);
    await expect.poll(() => activity.locator('.world-activity__viewport').evaluate(node => node.scrollTop)).toBe(0);
  });

  // An agreement in the feed opens its link in place: its designs are applied (a design unapplied here
  // is applied again) and its panel opens over the map.
  for (const applied of [true, false]) {
    test(`a globe agreement event opens the agreement over the map with its ${applied ? 'applied' : 'unapplied'} design applied, and leaves Activity reachable`, async ({ mockApi: page }) => {
      test.setTimeout(120_000);
      await openCity(page);
      const title = 'Community park agreement';
      const { cid, parkId } = await proposeOverPark(page, { title, author: 'Globe fixture' });
      if (!applied) await page.evaluate(async id => { await (window as any).ProposalManager.unapplyProposal(id, { silent: true, suppressCameraMove: true }); }, parkId);
      const isApplied = () => page.evaluate(id => (window as any).getProposalByIdOrHash(id).applied === true, parkId);
      expect(await isApplied()).toBe(applied);
      await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [agreementEvent('park-event', 'propose', cid, { agreementName: title })] } }));
      await page.evaluate(() => (window as any).map.setView([45.85, 16.05], 12, { animate: false }));
      await openWorldFromSettings(page);
      const link = page.locator('.world-activity a').first();
      await expect(link).toBeVisible({ timeout: 15000 });
      await expect(link).toHaveAttribute('href', `/agreements/${cid}?city=zagreb&reduceMotion=1`);
      await link.click();
      await expect(page.locator('#world-view')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/agreements/${cid}`);
      const panel = page.locator('section#agreement-panel');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#agreement-panel-title')).toHaveText(title);
      await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
      // Its design stands on the map, and the agreement matches what it shapes there.
      await expect.poll(isApplied, { timeout: 30_000 }).toBe(true);
      await expect(panel.locator('[data-agreement-status="current"]')).toBeVisible({ timeout: 30_000 });
      // The global Activity control stays reachable over the agreement.
      const activitySheet = page.locator('#activity-sheet');
      await expect(activitySheet).toBeHidden();
      await page.locator('#activity-button').click();
      await expect(activitySheet).toBeVisible();
      await expect(activitySheet.locator('#activity-events-pane')).toBeVisible();
      await activitySheet.locator('[data-sheet-close]').click();
      await expect(activitySheet).toBeHidden();
    });
  }

  // A record is stored only in the city its parcels are in (c97bceea, projections.md M8): an agreement
  // event picked from another city (Explore) reloads into its city on the agreement's link, whose
  // route opens it there.
  test('a cross-city agreement event reloads in the agreement\'s city and opens it there', async ({ mockApi: page }) => {
    test.setTimeout(150_000);
    await openCity(page);
    const title = 'Remote park agreement';
    const { cid } = await proposeOverPark(page, { title, author: 'Globe fixture' });
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [agreementEvent('remote-park', 'propose', cid, { agreementName: title })] } }));
    await page.goto('/?city=explore&at=44.8,20.4,14&reduceMotion=1&lang=en'); await waitForMapReady(page);
    await openWorldFromSettings(page);
    const link = page.locator('.world-activity a').first();
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(link).toHaveAttribute('href', `/agreements/${cid}?city=zagreb&lang=en&reduceMotion=1`);
    await link.click();
    await page.waitForURL(url => url.pathname === `/agreements/${cid}` && url.searchParams.get('city') === 'zagreb', { timeout: 30_000 });
    await waitForMapReady(page);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
    const panel = page.locator('section#agreement-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#agreement-panel-title')).toHaveText(title);
    await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
    // The globe's last frame covered the reload and is gone once the map has drawn.
    await expect(page.locator('.world-handoff')).toHaveCount(0, { timeout: 15000 });
  });

  // The globe paints a city with agreements and puts their count on its label (GET /activity/cities).
  test('the globe labels a city with the number of agreements proposed there', async ({ mockApi: page }) => {
    const index = pageIndex(page);
    fileIndexedAgreement(index, { title: 'First agreement', createdAt: '2026-10-20T09:00:00.000Z', community: true, author: 'Globe fixture' });
    fileIndexedAgreement(index, { title: 'Second agreement', createdAt: '2026-10-20T09:00:00.000Z', community: true, author: 'Globe fixture' });
    await openCity(page);
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await expect(world.locator('canvas')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => index.requests.some(request => request.method === 'GET' && request.path === '/activity/cities')).toBe(true);
    await page.evaluate(async () => { await (window as any).WorldView.flyTo({ lat: 45.815, lon: 15.982 }, { altitudeKm: 1500 }); });
    const label = page.locator('.world-city-label[aria-label="Zagreb, 2 agreements"]');
    await expect(label).toHaveCount(1, { timeout: 20_000 });
    await expect(label.locator('.world-city-label__count')).toHaveText('2');
    await expect(label.locator('.world-city-label__name')).toHaveText('Zagreb');
  });

  test('phone globe activity shows approximate location with reduced motion', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const cid = cidOfObject({ schema: 'agreement/v1', title: 'Community park' });
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [
      agreementEvent('phone', 'execute', cid, { agreementName: 'Community park', cityId: 'explore', location: { lat: 44.3, lon: 16.2 } }),
    ] } }));
    await openCity(page); await openWorldFromSettings(page);
    const activity = page.locator('.world-activity'); await expect(activity.getByRole('link')).toHaveCount(1, { timeout: 15000 });
    await expect(activity.getByRole('link')).toContainText('in Croatia');
    await expect(activity.getByRole('button')).toHaveCount(0);
    const box = await activity.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await expect(activity).toHaveClass(/world-activity--static/);
    await page.screenshot({ path: '/private/tmp/colosseum-globe-activity-phone.png' });
  });

  test('zooming out by wheel returns to a nonclosable globe, while programmatic framing does not bounce', async ({ mockApi: page }) => {
    await openCity(page);
    // Zoom-out-to-globe is wired once the app has booted (world-entry.js); on a slow machine the map
    // can be ready before that, and a wheel turned in between is not meant to open the globe.
    await page.evaluate(() => (window as any).whenAppBooted());
    await page.evaluate(() => (window as any).map.setView([45.8, 16], 4, { animate: false }));
    await expect(page.locator('#world-view')).toHaveCount(0);
    await page.evaluate(() => (window as any).map.setZoom(5, { animate: false }));
    await page.locator('#map').hover(); await page.mouse.wheel(0, 500);
    await expect(page.locator('#world-view')).toBeVisible({ timeout: 15000 });
    const camera = await page.evaluate(() => (window as any).WorldView.getCamera());
    expect(Math.abs(camera.lat - 45.8)).toBeLessThan(1);
    await expect(page.locator('.world-view__close')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#world-view')).toBeVisible();
    await page.evaluate(() => (window as any).WorldView.close());
    await expect(page.locator('#world-view')).toHaveCount(0);
    await page.evaluate(() => (window as any).map.fire('zoomend'));
    await expect(page.locator('#world-view')).toHaveCount(0);
  });

  test('requesting an available data source retries a failed request then opens exploration', async ({ mockApi: page }) => {
    let attempts = 0;
    let request: any;
    await page.route('**/cities/requests', route => {
      request = route.request().postDataJSON();
      return route.fulfill({ status: ++attempts === 1 ? 503 : 200, json: { ok: true } });
    });
    await openCity(page);
    await openWorldFromSettings(page);
    const world = page.locator('#world-view');
    await world.locator('.world-search__input').fill('Dhaka');
    await world.getByRole('option').filter({ hasText: 'Dhaka' }).first().click();
    await world.getByRole('button', { name: 'Ask for this city' }).click();
    await expect(world.locator('.world-popup__error')).toHaveText('Could not send the request. Try again?');
    await world.getByRole('button', { name: 'Ask for this city' }).click();
    await expect(world.getByRole('button', { name: 'Request noted, thank you' })).toBeDisabled();
    expect(attempts).toBe(2);
    expect(request).toMatchObject({ name: 'Dhaka' });
    await world.getByRole('button', { name: 'Open the map here' }).click();
    await waitForMapReady(page);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.isExplore())).toBe(true);
    await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 23.7104))).toBeLessThan(0.001);
  });

  test('open ground can draw a site and cancel it without binding an unrelated parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).map.setView([45.8008, 15.9817], 18, { animate: false }));
    await clickMapPoint(page, 15.9817, 45.8008);
    await expect(page.locator('#click-stack .click-stack__section[data-kind="ground"]')).toBeVisible();
    const ground = page.locator('#click-stack .click-stack__section[data-kind="ground"]');
    await expect(ground.getByRole('button', { name: 'Draw a parcel', exact: true })).toBeVisible();
    await expect(ground.locator('.click-stack__facts')).toHaveText('Unsurveyed ground or a gap between parcels.');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const boxes = await ground.locator('.click-stack__actions > button').evaluateAll(buttons => buttons.map(button => {
        const { x, y, width } = button.getBoundingClientRect(); return { x, y, width };
      }));
      expect(boxes).toHaveLength(7);
      expect(boxes[0].width).toBeGreaterThan(boxes[1].width * 1.9);
      for (const i of [1, 3, 5]) {
        expect(Math.abs(boxes[i].width - boxes[i + 1].width)).toBeLessThan(1);
        expect(Math.abs(boxes[i].y - boxes[i + 1].y)).toBeLessThan(1);
        expect(boxes[i + 1].x).toBeGreaterThan(boxes[i].x);
        expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
      }
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator('#click-stack [data-command="ground.drawSite"]').click();
    await expect(page.locator('#site-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).SiteTool.isActive())).toBe(true);
    await page.locator('#site-panel [data-site-action="cancel"]').first().click();
    await expect(page.locator('#site-panel')).toBeHidden();
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
  });

  test('urbanist inspection scores actual applied parcel geometry and restores the map when closed', async ({ mockApi: page }) => {
    await openCity(page);
    await createSpace(page, 'park');
    await page.locator('#proposals-button').click();
    // Plan-wide actions sit in the collapsed "Plan actions" group (fbe3758d).
    await (await openPlanActions(page)).getByRole('button', { name: 'Urban rooster', exact: true }).click();
    const panel = page.locator('#grain-score-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    await expect(panel.locator('[data-grain-role="planName"]')).toHaveText('Applied composition');
    await expect(panel.locator('[data-grain-role="route"]')).toHaveText('Local composition · score stays in this browser');
    await test.info().attach('local-composition-score', { body: await panel.screenshot(), contentType: 'image/png' });
    const score = Number(await panel.locator('[data-grain-role="totalScore"]').innerText());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await panel.locator('.grain-score-methodology summary').click();
    await expect(panel.locator('[data-grain-role="methodologyBody"]')).toBeVisible();
    await panel.locator('[data-grain-action="sound"]').click();
    await expect(panel.locator('[data-grain-action="sound"]')).toHaveAttribute('aria-pressed', 'false');
    await panel.locator('[data-grain-action="close"]').click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).map.dragging.enabled())).toBe(true);
  });
});
