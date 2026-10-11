import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, createSpace } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';

test.describe('World navigation and open ground @features', () => {
  test('city arrival loads the proposal pill count before opening the list and stops its pulse on first opening', async ({ mockApi: page }) => {
    await page.route('**/proposals/count?*', route => route.fulfill({ json: { count: 7 } }));
    await page.goto('/?city=zg&lang=en'); await waitForMapReady(page);
    const count = page.locator('#proposals-button-count');
    await expect(count).toHaveText('7'); await expect(count).toBeVisible();
    await expect(count).toHaveClass(/is-unopened/);
    await expect(page.locator('#proposals-button')).toHaveAttribute('aria-label', 'Proposals (7)');
    // The Proposals sheet mounts the list itself (fbe3758d), so opening the sheet is the first opening.
    await page.locator('#proposals-button').click();
    await expect(page.locator('#proposals-sheet .proposal-list-modal')).toBeVisible();
    await expect(count).not.toHaveClass(/is-unopened/);
  });

  test('Explore arrival counts and lists server proposals using the same visible area', async ({ mockApi: page }) => {
    const countQueries: string[] = [], listQueries: string[] = [];
    await page.route('**/proposals/count?*', route => {
      countQueries.push(route.request().url()); return route.fulfill({ json: { count: 7 } });
    });
    await page.route('**/proposals/summary?*', route => {
      listQueries.push(route.request().url()); return route.fulfill({ json: { proposals: [], count: 7 } });
    });
    await page.goto('/?city=explore&at=45.8,16,16&lang=en&reduceMotion=1'); await waitForMapReady(page);
    await expect(page.locator('#proposals-button-count')).toHaveText('7');
    expect(new URL(countQueries.at(-1)!).searchParams.has('bbox')).toBe(true);
    expect(new URL(countQueries.at(-1)!).searchParams.has('city')).toBe(false);
    await page.locator('#proposals-button').click();
    await expect(page.locator('#proposals-sheet .proposal-list-modal')).toBeVisible();
    await expect.poll(() => listQueries.length).toBeGreaterThan(0);
    expect(new URL(listQueries.at(-1)!).searchParams.get('bbox')).toBe(new URL(countQueries.at(-1)!).searchParams.get('bbox'));
  });
  test('the world globe searches a live city and opens its configured map', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#settings-button').click();
    await page.locator('#world-view-button').click();
    const world = page.locator('#world-view');
    await expect(world).toBeVisible();
    await expect(world.locator('canvas')).toBeVisible();
    await expect(world.getByRole('button', { name: 'Back to map' })).toBeVisible();
    await world.locator('.world-search__input').fill('Belgrade');
    await world.getByRole('option').filter({ hasText: 'Belgrade' }).first().click();
    await expect(world.locator('.world-popup__title')).toHaveText('Belgrade');
    await world.getByRole('button', { name: /Open Belgrade/ }).click();
    await waitForMapReady(page);
    await expect(world).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('belgrade');
  });

  // A city pick arrives on the city's newest proposal in 3D (js/world/arrival.js); a city with none
  // lands on its map as before. Zagreb is already loaded here, so the pick lands in place.
  for (const hasProposal of [true, false]) {
    test(`a city pick ${hasProposal ? 'arrives in 3D on its latest proposal' : 'with no proposals lands on the 2D map'}`, async ({ mockApi: page }) => {
      await openCity(page); const id = await createSpace(page, 'park');
      const summaries: string[] = [];
      await page.route('**/proposals/summary?*', route => {
        summaries.push(route.request().url());
        return route.fulfill({ json: { proposals: hasProposal ? [{ id: 77, proposalId: id }] : [], count: hasProposal ? 1 : 0 } });
      });
      await page.evaluate(() => (window as any).map.setView([45.85, 16.05], 12, { animate: false }));
      await page.locator('#settings-button').click(); await page.locator('#world-view-button').click();
      const world = page.locator('#world-view');
      await world.locator('.world-search__input').fill('Zagreb');
      await world.getByRole('option').filter({ hasText: 'Zagreb' }).first().click();
      await world.getByRole('button', { name: /Open Zagreb/ }).click();
      await expect(world).toHaveCount(0, { timeout: 15000 });
      await expect.poll(() => summaries.length).toBeGreaterThan(0);
      expect(new URL(summaries[0]).searchParams.get('limit')).toBe('1');
      // The arrival caption card was removed (fbe3758d): the pick lands in 3D on the selected
      // proposal, and the 2D mode tile leads back to the map.
      const details = page.locator('#proposal-details-panel');
      if (hasProposal) {
        await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false), { timeout: 20000 }).toBe(true);
        await expect.poll(() => page.evaluate(id => (window as any).ProposalSelection.getKey() === id, id)).toBe(true);
        expect(new URL(page.url()).searchParams.has('arrive')).toBe(false);
        await expect(page.locator('#mode-3d-toggle')).toHaveAttribute('aria-pressed', 'true');
        // Back on the map the proposal is still selected, framed, and opens from the map.
        await page.locator('#mode-2d-toggle').click();
        await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
        await expect(page.locator('path.proposal-primary-outline').first()).toBeVisible();
        await clickMapPoint(page, 15.9822, 45.80025);
        await expect(details).toBeVisible();
        await expect(details).toContainText('Park · parcel 1234');
      } else {
        await expect(page.locator('#mode-2d-toggle')).toHaveAttribute('aria-pressed', 'true');
        expect(await page.evaluate(() => (window as any).isThreeModeActive?.() ?? false)).toBe(false);
      }
    });
  }

  test('globe activity scrolls without buttons, pauses on hover and uses event colors and location labels', async ({ mockApi: page }) => {
    const events = ['create', 'execute', 'resolve', 'donate', 'accept'].map((type, index) => ({
      id: `event-${index}`, source: 'live', ok: true, action: { type, proposalId: 'proposal-42' },
      proposalName: 'Community park', cityId: 'zagreb', location: { lat: 45.8, lon: 16 }, occurredAt: `2026-10-02T12:0${index}:00Z`,
    }));
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events } }));
    await page.goto('/?city=zg&lang=en'); await waitForMapReady(page);
    await page.locator('#settings-button').click(); await page.locator('#world-view-button').click();
    const activity = page.locator('.world-activity');
    await expect(activity.getByRole('link')).toHaveCount(5, { timeout: 15000 });
    await expect(activity.getByRole('button')).toHaveCount(0);
    await expect(activity.getByRole('link').first()).toContainText('Zagreb');
    await expect(activity.getByRole('link').first()).toHaveAttribute('href', '/?focusProposal=proposal-42&city=zagreb&lang=en');
    const createColor = await activity.locator('[data-event-type="create"] .world-activity__action').first().evaluate(node => getComputedStyle(node).color);
    const resolveColor = await activity.locator('[data-event-type="resolve"] .world-activity__action').first().evaluate(node => getComputedStyle(node).color);
    expect(createColor).not.toBe(resolveColor);
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

  for (const applied of [true, false]) {
    test(`globe event arrives on a ${applied ? 'locally applied' : 'unapplied'} proposal in 3D, then the map, and leaves Activity reachable`, async ({ mockApi: page }) => {
      await openCity(page); const id = await createSpace(page, 'park');
      if (!applied) await page.evaluate(async id => { await (window as any).ProposalManager.unapplyProposal(id, { silent: true, suppressCameraMove: true }); }, id);
      await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [{
        id: 'park-event', action: { type: 'create', proposalId: id }, proposalName: 'Community park', cityId: 'zagreb',
        location: { lat: 45.80025, lon: 15.9822 }, occurredAt: '2026-10-02T12:00:00Z',
      }] } }));
      await page.evaluate(() => (window as any).map.setView([45.85, 16.05], 12, { animate: false }));
      await page.locator('#settings-button').click(); await page.locator('#world-view-button').click();
      await expect(page.locator('.world-activity a')).toBeVisible({ timeout: 15000 });
      await page.locator('.world-activity a').click();
      await expect(page.locator('#world-view')).toHaveCount(0);
      // A globe pick arrives in 3D on the proposal (js/world/arrival.js); still under reduced motion.
      // Its caption card was removed (fbe3758d): the 2D mode tile leads back to the map.
      await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false), { timeout: 20000 }).toBe(true);
      await expect.poll(() => page.evaluate(id => (window as any).ProposalSelection.getKey() === id, id)).toBe(true);
      expect(await page.evaluate(() => (window as any).getThreeModeInternals().controls.autoRotate)).toBe(false);
      await page.locator('#mode-2d-toggle').click();
      await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
      await expect(page.locator('.game-log-modal')).toHaveCount(0);
      await expect.poll(() => page.evaluate(id => (window as any).getProposalByIdOrHash(id).applied === true, id)).toBe(applied);
      await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(15);
      await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.80025))).toBeLessThan(0.002);
      const outline = page.locator('path.proposal-primary-outline').first();
      await expect(outline).toBeVisible();
      if (applied) await expect(outline).not.toHaveAttribute('stroke-dasharray', '10 5');
      else await expect(outline).toHaveAttribute('stroke-dasharray', '10 5');
      // 3D closes the 2D panels; the still-selected proposal reopens its details from the map.
      await clickMapPoint(page, 15.9822, 45.80025);
      await expect(page.locator('#proposal-details-panel')).toBeVisible();
      await expect(page.locator('#proposal-details-panel')).toContainText('Park · parcel 1234');
      await expect(page.locator('#parcel-menu')).toBeHidden();
      expect(await page.evaluate(id => (window as any).getProposalByIdOrHash(id).applied === true, id)).toBe(applied);
      // A map click opens the compact card; its expand button shows the Activity link.
      const expand = page.locator('#proposal-details-minimize');
      if (await expand.getAttribute('aria-expanded') === 'false') await expand.click();
      await expect(expand).toHaveAttribute('aria-expanded', 'true');
      const activity = page.locator('#proposal-details-panel [data-activity-scope="proposalId"]');
      await expect(activity).toBeVisible(); await activity.click();
      await expect(page.locator('.game-log-modal')).toBeVisible();
      if (!applied) {
        await page.locator('.game-log-modal-close').click();
        await expect(page.locator('.game-log-modal')).toHaveCount(0);
        await page.mouse.click(180, 150);
        await expect(page.locator('path.proposal-primary-outline')).toHaveCount(0);
        expect(await page.evaluate(id => (window as any).getProposalByIdOrHash(id).applied === true, id)).toBe(false);
      }
    });
  }

  test('a cross-city event keeps the globe cover over the default world map until its downloaded proposal is framed', async ({ mockApi: page }) => {
    // A record is stored only in the city its parcels are in (c97bceea, projections.md M8), so the
    // remote proposal is a Zagreb park and the event is picked from another city (Explore).
    await openCity(page); const id = await createSpace(page, 'park');
    const proposal = await page.evaluate(id => JSON.parse(JSON.stringify((window as any).getProposalByIdOrHash(id))), id);
    let releaseDownload!: () => void;
    const download = new Promise<void>(resolve => { releaseDownload = resolve; });
    await page.route('**/proposals/98765', async route => {
      await download;
      await route.fulfill({ json: { ...proposal, id: 98765, proposalId: '98765', cityId: 'zagreb', applied: false } });
    });
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [{
      id: 'remote-park', action: { type: 'create', proposalId: '98765' }, proposalName: 'Remote park', cityId: 'zagreb',
      location: { lat: 45.80025, lon: 15.9822 }, occurredAt: '2026-10-02T12:00:00Z',
    }] } }));
    await page.goto('/?city=explore&at=44.8,20.4,14&reduceMotion=1&lang=en'); await waitForMapReady(page);
    await page.locator('#settings-button').click(); await page.locator('#world-view-button').click();
    await expect(page.locator('.world-activity a')).toBeVisible({ timeout: 15000 });
    await page.locator('.world-activity a').click();
    await page.waitForURL(/city=zagreb/);
    await expect(page.locator('.world-handoff')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).WorldProposalEntry?.isOpening())).toBe(true);
    await expect(page.locator('.world-handoff')).toBeVisible();
    releaseDownload();
    await expect(page.locator('.world-handoff')).toHaveCount(0, { timeout: 15000 });
    // Zagreb has 3D buildings, so the pick arrives in 3D first (js/world/arrival.js); the 2D tile
    // goes back to the map (the caption card was removed in fbe3758d).
    await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.() ?? false), { timeout: 20000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection.getKey())).toBe('98765');
    await page.locator('#mode-2d-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('zagreb');
    await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(15);
    await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.80025))).toBeLessThan(0.002);
    await expect(page.locator('path.proposal-primary-outline').first()).toHaveAttribute('stroke-dasharray', '10 5');
  });

  test('phone globe activity shows approximate location with reduced motion', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/activity/recent?*', route => route.fulfill({ json: { events: [{
      id: 'phone', action: { type: 'execute', proposalId: 'park-1' }, proposalName: 'Community park', cityId: 'explore',
      location: { lat: 44.3, lon: 16.2 }, occurredAt: '2026-10-02T12:00:00Z',
    }] } }));
    await openCity(page); await page.locator('#settings-button').click(); await page.locator('#world-view-button').click();
    const activity = page.locator('.world-activity'); await expect(activity.getByRole('link')).toHaveCount(1, { timeout: 15000 });
    await expect(activity.getByRole('link')).toContainText('in Croatia');
    await expect(activity.getByRole('button')).toHaveCount(0);
    const box = await activity.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await expect(activity).toHaveClass(/world-activity--static/);
    await page.screenshot({ path: '/private/tmp/colosseum-globe-activity-phone.png' });
  });

  test('zooming out by wheel returns to a nonclosable globe, while programmatic framing does not bounce', async ({ mockApi: page }) => {
    await openCity(page);
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
    await page.locator('#settings-button').click();
    await page.locator('#world-view-button').click();
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
    await expect(page.locator('#ground-menu')).toBeVisible();
    await page.locator('#ground-menu [data-command="ground.drawSite"]').click();
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
    await page.locator('#proposal-list-actions > summary').click();
    await page.locator('#roosterScoreButton').click();
    const panel = page.locator('#grain-score-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
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
