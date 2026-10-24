// Actual model-scene authoring and immutable flight sharing. Keep transport fixtures here so a
// second isolated device reads durable records rather than inheriting the editor's local storage.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { attachSharedIndex, cidOfObject, createSharedIndex, fileDesign } from '../helpers/mocks/shared-server';
const records = require('../../frontend/js/design-record.js');

test.setTimeout(120_000);
const panel = (page: Page) => page.locator('#camera-flight-panel');
const action = (page: Page, name: string) => panel(page).locator(`[data-flight-action="${name}"]`);
const field = (page: Page, name: string) => panel(page).locator(`[data-flight-field="${name}"]`);
const record = (page: Page): Promise<any> => page.evaluate(() => { const w = window as any;return (w.CameraFlightEditor?.active || w.CameraFlightPlayer?.active).getRecord(); });
const capture = (page: Page): Promise<any> => page.evaluate(() => { const w = window as any;return (w.CameraFlightEditor?.active || w.CameraFlightPlayer?.active).session.capture(); });
const optionalRequests = (page: Page) => page.evaluate(() => Array.from(document.scripts).filter(script => script.src).map(script => new URL(script.src).pathname)
  .filter(path => /\/js\/camera-flight(?:-(?:camera|edit|editor|session))?\.js$/.test(path) || path.endsWith('/interior-viewer/interior-viewer.js')));

function durableFlights() {
  const rows = new Map<string, any>();
  const requests: Array<{ method: string; cid: string | null }> = [];
  let failNextSave = false;
  return {
    rows, requests, failNextSave: () => { failNextSave = true; },
    async attach(page: Page, index: ReturnType<typeof createSharedIndex>) {
      await page.route(/\/flights(?:\/[^/?]+)?(?:\?.*)?$/, async route => {
        const request = route.request(), url = new URL(request.url());
        const match = /\/flights(?:\/([^/]+))?\/?$/.exec(url.pathname);
        if (!match) return route.fallback();
        const cid = match[1] || null;
        if (request.isNavigationRequest()) {
          // Exercise the real /flights/:cid path with the same index.html fallback as hosting.
          if (!cid || !rows.has(cid)) return route.fulfill({ status: 404, body: 'Flight not found' });
          const response = await route.fetch({ url: new URL('/', request.url()).href });
          return route.fulfill({ response });
        }
        if (!['fetch', 'xhr'].includes(request.resourceType())) return route.fallback();
        requests.push({ method: request.method(), cid });
        if (request.method() === 'POST' && !cid) {
          if (failNextSave) { failNextSave = false; return route.fulfill({ status: 503, json: { error: 'Fixture flight save failed.' } }); }
          const content = request.postDataJSON()?.content;
          if (!content || content.designCids.some((id: string) => !index.designs.has(id))) {
            return route.fulfill({ status: 409, json: { error: 'Selected designs must be published.' } });
          }
          const key = cidOfObject(content), row = { cid: key, content: JSON.parse(JSON.stringify(content)) };
          rows.set(key, row);return route.fulfill({ status: 201, json: row });
        }
        const row = cid && rows.get(cid);
        return row ? route.fulfill({ json: row }) : route.fulfill({ status: 404, json: { error: 'Flight not found.' } });
      });
    }
  };
}
async function prepare(page: Page) {
  const index = createSharedIndex();
  const cid = fileDesign(index, records.published({ goal: 'single', city: 'zg', title: 'Flight test building',
    site: PARCEL_GEOMETRY, geometry: { buildings: [{ type: 'Feature',
      properties: { floors: 3, height: 9, type: 'proposedBuilding' }, geometry: PARCEL_GEOMETRY }] },
    buildingProposal: { typologyType: 'single', parameters: { floors: 3, height: 9 } }, createdAt: '2026-10-24T00:00:00.000Z' }));
  const flights = durableFlights();
  await attachSharedIndex(page, index);await flights.attach(page, index);
  await stubBasemapTiles(page);await mockBuildingScene(page);await openCity(page);
  await page.evaluate(async cid => {
    await (window as any).handleSharedDesignRoute([cid], { frame: false, openDetails: false });
  }, cid);
  await expect.poll(() => page.evaluate(cid => {
    const w = window as any, design = w.DesignSync.localCopyOf(cid);return !!design && w.isApplied(design);
  }, cid)).toBe(true);
  return { index, cid, flights };
}
async function enterModel(page: Page) {
  await page.evaluate(() => (window as any).PlanningViews.configure('existing', 'ghost'));
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals()?.scene.traverseVisible((object: any) => {
      if (object.isMesh && object.geometry?.attributes?.position?.count && object.userData.isNearbyBuilding3D) count++;
    });
    return count;
  }), { timeout: 30_000 }).toBeGreaterThan(0);
}
async function openEditor(page: Page) {
  await page.locator('#camera-flight-open').click();await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-flight-point]')).toHaveCount(1);
}
async function addViews(page: Page) {
  const start = await capture(page);
  for (const delta of [[8, 3, 1], [20, -4, 5]]) {
    const pose = { ...start, position: start.position.map((value: number, i: number) => value + delta[i]) };
    await page.evaluate(pose => (window as any).CameraFlightEditor.active.session.apply(pose), pose);
    await action(page, 'add-view').click();
  }
  await expect(panel(page).locator('[data-flight-point]')).toHaveCount(3);
  return start;
}
async function editField(page: Page, name: string, value: string) {
  await field(page, name).fill(value);await field(page, name).press('Tab');
}
async function seek(page: Page, seconds: number) {
  // Drive the real range input's handler; the controller's seek method remains available for
  // browser debugging, but assertions exercise the UI's deterministic scrub path here.
  await page.locator('#camera-flight-time').evaluate((element, value) => {
    const input = element as HTMLInputElement;input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
}
function expectPose(actual: any, expected: any) {
  actual.position.forEach((value: number, i: number) => expect(value).toBeCloseTo(expected.position[i], 4));
  const dot = actual.quaternion.reduce((sum: number, value: number, i: number) => sum + value * expected.quaternion[i], 0);
  expect(Math.abs(dot)).toBeCloseTo(1, 8);expect(actual.fov).toBe(expected.fov);
}

test.describe('camera flights in the actual model scene', () => {
  test('2D and ordinary 3D stay lazy; flight controls capture two distinct camera views', async ({ mockApi: page }) => {
    await prepare(page);expect(await optionalRequests(page)).toEqual([]);
    await expect(page.locator('#three-container canvas')).toHaveCount(0);
    await enterModel(page);expect(await optionalRequests(page)).toEqual([]);
    await openEditor(page);const start = await addViews(page), flight = await record(page);
    expect(flight.route).toHaveLength(3);
    expect(flight.route[1].position[0] - start.position[0]).toBeCloseTo(8, 4);
    expect(flight.route[2].position[2] - start.position[2]).toBeCloseTo(5, 4);
    expect((await optionalRequests(page)).some(path => path.endsWith('/camera-flight.js'))).toBe(true);
    expect((await optionalRequests(page)).some(path => path.endsWith('/interior-viewer.js'))).toBe(false);
    await expect(action(page, 'play')).toBeEnabled();await expect(panel(page).locator('[data-flight-status]')).toBeVisible();
  });

  test('a phone can change route height and timing, undo/redo and reorder points', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 375, height: 812 });await prepare(page);await enterModel(page);await openEditor(page);await addViews(page);
    await editField(page, 'title', 'Courtyard arrival');await editField(page, 'height', '6.5');await editField(page, 'travel', '7');
    const beforeHold = await record(page);await editField(page, 'hold', '1.25');
    await expect.poll(async () => (await record(page)).route[2]).toMatchObject({ position: [expect.any(Number), expect.any(Number), 6.5], travelSeconds: 7, holdSeconds: 1.25 });
    await action(page, 'undo').click();expect((await record(page)).route).toEqual(beforeHold.route);
    await action(page, 'redo').click();const beforeMove = await record(page);
    await panel(page).locator('[data-flight-point]').last().locator('[data-flight-action="up"]').click();
    const moved = await record(page);expect(moved.route.map((point: any) => point.id)).toEqual([beforeMove.route[0].id, beforeMove.route[2].id, beforeMove.route[1].id]);
    expect(moved.route[1].position[2]).toBe(6.5);expect(moved.title).toBe('Courtyard arrival');
    await expect(action(page, 'close')).toBeInViewport();
    expect(await panel(page).evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(375);
  });

  test('look keys and a complete spin remain independent of route positions and cue the view', async ({ mockApi: page }) => {
    await prepare(page);await enterModel(page);await openEditor(page);await addViews(page);
    const before = await record(page);await seek(page, 1);
    const eye = await capture(page);await page.evaluate(pose => (window as any).CameraFlightEditor.active.session.apply(pose), { ...eye, quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
    await action(page, 'add-look').click();expect((await record(page)).route).toEqual(before.route);
    await panel(page).locator('details').filter({ has: page.locator('[data-flight-action=spin]') }).locator('summary').click();
    await seek(page, 2);await action(page, 'spin').click();const spun = await record(page);
    expect(spun.route).toEqual(before.route);expect(spun.looks.length).toBeGreaterThanOrEqual(9);
    const angularTravel = spun.looks.slice(1).reduce((sum: number, look: any, i: number) => {
      const dot = look.quaternion.reduce((value: number, component: number, axis: number) => value + component * spun.looks[i].quaternion[axis], 0);
      return sum + 2 * Math.acos(Math.min(1, Math.abs(dot)));
    }, 0);
    expect(angularTravel).toBeGreaterThanOrEqual(2 * Math.PI - 1e-6);
    await page.evaluate(() => (window as any).applyThreeInteriorView({ xray: '1', suggested: '1', suggestedExisting: '0', cutaway: '0' }));
    await panel(page).locator('details').filter({ has: page.locator('[data-flight-action=cue]') }).locator('summary').click();
    await action(page, 'cue').click();const final = await record(page);
    expect(final.cues).toContainEqual(expect.objectContaining({ settings: expect.objectContaining({ xray: '1', suggested: '1', cutaway: '0' }) }));
    await expect(panel(page).locator('[data-flight-look]')).toHaveCount(final.looks.length);
  });

  test('play/pause and scrub apply exact poses, and closing restores ordinary orbit controls', async ({ mockApi: page }) => {
    await prepare(page);await enterModel(page);
    const enabledBefore = await page.evaluate(() => (window as any).getThreeModeInternals().controls.enabled);
    await openEditor(page);await addViews(page);await seek(page, 0);await action(page, 'play').click();
    await expect(panel(page)).toHaveAttribute('data-flight-state', 'playing');await action(page, 'pause').click();
    await expect(panel(page)).toHaveAttribute('data-flight-state', 'paused');
    const flight = await record(page), end = await page.evaluate(record => (window as any).CameraFlight.duration(record), flight);
    await seek(page, end);const expected = await page.evaluate(({ record, time }) => (window as any).CameraFlight.compile(record).evaluate(time), { record: flight, time: end });
    expectPose(await capture(page), expected);
    await action(page, 'overview').click();await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().controls.enabled)).toBe(true);
    await action(page, 'stop').click();await action(page, 'close').click();await expect(panel(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().controls.enabled)).toBe(enabledBefore);
    const orbitPosition = await page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
    const canvas = page.locator('#three-container canvas'), box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width * .35, box!.y + box!.height * .5);
    await page.mouse.down();await page.mouse.move(box!.x + box!.width * .35 + 80, box!.y + box!.height * .5, { steps: 8 });await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray())).not.toEqual(orbitPosition);
    await expect(page.locator('body')).toHaveClass(/three-mode-active/);
    await page.locator('#mode-2d-toggle').click();await expect(page.locator('body')).not.toHaveClass(/three-mode-active/);
  });

  test('share failure stays visible; a successful durable link restores the exact design and look settings without autoplay', async ({ mockApi: page, browser, baseURL }) => {
    const { index, cid, flights } = await prepare(page);await enterModel(page);
    await page.evaluate(() => (window as any).applyThreeInteriorView({ xray: '1', suggested: '1', suggestedExisting: '0', cutaway: '1' }));
    await openEditor(page);await addViews(page);await editField(page, 'title', 'Inside to courtyard');
    flights.failNextSave();await action(page, 'share').click();await expect(panel(page).locator('[data-flight-status]')).toContainText('Fixture flight save failed.');
    await expect(panel(page).locator('a[data-flight-link]')).toBeHidden();expect(flights.rows.size).toBe(0);
    await action(page, 'share').click();await expect(panel(page).locator('a[data-flight-link]')).toHaveAttribute('href', /\/flights\/baf/);
    const link = await panel(page).locator('a[data-flight-link]').getAttribute('href');expect(link).toBeTruthy();
    const savedCid = new URL(link!, page.url()).pathname.split('/').pop()!, saved = flights.rows.get(savedCid);
    expect(saved.content.designCids).toEqual([cid]);expect(flights.requests.some(request => request.method === 'GET' && request.cid === savedCid)).toBe(true);
    const context = await browser.newContext({ baseURL });
    try {
      await context.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('cb_site_intro_seen_v1', '1'); });
      const receiver = await context.newPage();await mockAllApiRoutes(receiver);await attachSharedIndex(receiver, index);await flights.attach(receiver, index);
      await mockBuildingScene(receiver);await stubBasemapTiles(receiver);await receiver.goto(link!, { waitUntil: 'domcontentloaded' });
      await expect(panel(receiver)).toBeVisible({ timeout: 60_000 });expect(await record(receiver)).toEqual(saved.content);
      await expect(panel(receiver)).not.toHaveAttribute('data-flight-state', 'playing');await expect(action(receiver, 'add-view')).toHaveCount(0);
      expect((await optionalRequests(receiver)).some(path => path.endsWith('/camera-flight-editor.js') || path.endsWith('/camera-flight-edit.js'))).toBe(false);
      expect(await receiver.evaluate(() => (window as any).getThreeInteriorView())).toEqual({ xray: '1', suggested: '1', suggestedExisting: '0', cutaway: '1' });
      expect(await receiver.evaluate(() => { const w = window as any;return w.proposalStorage.getAllProposals().filter((p: any) => w.isApplied(p)).map((p: any) => w.DesignSync.publishedCid(p)).sort(); })).toEqual([cid]);
      await action(receiver, 'play').click();await expect(panel(receiver)).toHaveAttribute('data-flight-state', 'playing');await action(receiver, 'pause').click();
    } finally { await context.close(); }
  });

  test('entering a generated apartment loads walking only for exploration and returns to the flight camera', async ({ mockApi: page }) => {
    await prepare(page);await enterModel(page);
    await page.evaluate(() => (window as any).applyThreeInteriorView({ xray: '1', suggested: '1', suggestedExisting: '0', cutaway: 'all' }));
    await openEditor(page);await expect.poll(() => field(page, 'apartment').locator('option').count()).toBeGreaterThan(1);
    const apartment = field(page, 'apartment').locator('option').nth(1);await field(page, 'apartment').selectOption((await apartment.getAttribute('value'))!);
    expect((await optionalRequests(page)).some(path => path.endsWith('/interior-viewer.js'))).toBe(false);
    await action(page, 'enter').click();const entry = await capture(page);
    expect(entry.position.every(Number.isFinite)).toBe(true);expect(entry.position[2]).toBeGreaterThan(0);
    await action(page, 'explore').click();await expect(action(page, 'back-to-flight')).toBeVisible();await expect(action(page, 'add-view')).toBeDisabled();
    expect((await optionalRequests(page)).some(path => path.endsWith('/interior-viewer.js'))).toBe(true);
    await expect(page.locator('.person-view-controls')).toBeVisible();
    await action(page, 'back-to-flight').click();await expect(action(page, 'add-view')).toBeEnabled();expectPose(await capture(page), entry);
    await expect(page.locator('.person-view-controls')).toHaveCount(0);
  });
});
