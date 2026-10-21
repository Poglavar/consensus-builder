import { Browser, BrowserContext, Page, expect } from '@playwright/test';
import { sampleParcels } from './mocks/parcel-data';
import { mockAllApiRoutes } from './mocks/api-routes';
import { attachSharedIndex, ensurePageIndex, fileDesign, SharedIndex } from './mocks/shared-server';
import { waitForMapReady } from './app';
import { selectNativeOption } from './controls';

export const PARCEL_ID = sampleParcels.features[0].properties.parcelId;
export const PARCEL_GEOMETRY = sampleParcels.features[0].geometry;

// The status line has one writer at a time and ground loading writes to it too, so a message can be
// replaced before an assertion reads it. Logged messages (non-transient updateStatus calls) are
// asserted from the session's status log instead.
export async function expectStatusLogged(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(t => (window as any).statusLogEntries().some((entry: any) => String(entry.message).includes(t)), text)).toBe(true);
}

// Basemap tiles answered locally, so a spec never waits on the tile network.
export async function stubBasemapTiles(page: Page): Promise<void> {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
}

// Another device opening `url`: its own browser context and storage, answered by the same index
// (mocks/shared-server.ts) as the device that published.
export async function openOnAnotherDevice(browser: Browser, url: string, index: SharedIndex, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'new_york');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedIndex(page, index);
  await stubBasemapTiles(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  return { context, page };
}

export async function openCity(page: Page, parcelId = PARCEL_ID): Promise<void> {
  // Readiness is the map/repository below; slow external basemap tiles must not hold navigation open.
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => {
    const w = window as any;
    return !!w.proposalStorage && !!w.CadastralParcelRepository && !!w.ParcelPresenter && !!w.ProposalManager;
  });
  await page.evaluate(async (id) => {
    const w = window as any;
    w.map.setView([45.80025, 15.9822], 18, { animate: false });
    await w.CadastralParcelRepository.ensureIds([id]);
  }, parcelId);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), parcelId)).toBe(true);
}

export async function clickMapPoint(page: Page, lng: number, lat: number): Promise<void> {
  const point = await page.evaluate(({ lng, lat }) => {
    const w = window as any;
    const p = w.map.latLngToContainerPoint([lat, lng]);
    const box = w.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  }, { lng, lat });
  await page.mouse.click(point.x, point.y);
}

export async function openParcel(page: Page, tab = 'info', id = PARCEL_ID): Promise<void> {
  const center = await page.evaluate(parcelId => {
    const w = window as any;
    const layer = w.ParcelPresenter.getLayer(parcelId);
    if (!layer) throw new Error(`ParcelPresenter has no layer for ${parcelId}`);
    const center = layer.getBounds().getCenter();
    w.map.panTo(center, { animate: false });
    return { lng: center.lng, lat: center.lat };
  }, id);
  await clickMapPoint(page, center.lng, center.lat);
  await expect(page.locator('#parcel-menu')).toBeVisible();
  await page.locator('#parcel-menu').getByRole('menuitem', { name: tab === 'proposals' ? 'Propose here' : tab === 'tools' ? 'Tools' : 'Details', exact: true }).click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
}

// A design published in the index that this browser has never loaded: a park on the parcel, found by
// the Proposals tabs' GET /designs?bbox=… (js/parcels/parcel-set-proposals.js). Returns its CID, the
// rows' data-server-id.
export async function publishOn(page: Page, parcelId: string): Promise<string> {
  const parcel = sampleParcels.features.find(feature => feature.properties.parcelId === parcelId);
  if (!parcel) throw new Error(`publishOn: ${parcelId} is not a fixture parcel`);
  const content = {
    schema: 'design/v1', goal: 'park', title: 'Published park', description: null, author: 'Fixture author', city: 'zagreb',
    site: parcel.geometry, toleranceM: null, geometry: null, origin: null, authoredAt: '2026-10-12T10:00:00.000Z',
    structureProposal: { kind: 'park' },
  };
  // Bound to exactly this parcel, whichever fixture faces the page shows.
  return fileDesign(await ensurePageIndex(page), content, {
    binding: { parcels: [{ parcelId, overlapM2: 100, intrusionM: 10 }], touched: [], toleranceM: 0, coverage: 'complete', unsurveyedM2: 0, siteM2: 100, source: 'server:e2e-fixture-cadastre' },
    createdAt: '2026-10-12T10:00:00.000Z',
  });
}

// A guest asked for a profile name before something leaves the device (GuestPolicy 'publish' opens
// the welcome dialog) chooses one.
export async function chooseProfileName(page: Page, name: string): Promise<void> {
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  await welcome.locator('#username-input').fill(name);
  await welcome.locator('#welcome-submit-btn').click();
  await expect(welcome).toBeHidden();
  await expect(page.locator('#username-text')).toHaveText(name);
}

export async function createSpace(page: Page, kind: 'park'|'square'|'lake'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind}`).click();
  await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((p: any) => p.structureProposal?.kind === kind && p.applied), kind)).toBe(true);
  return page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === kind).proposalId, kind);
}

export async function proposalState(page: Page, id: string): Promise<any> {
  return page.evaluate(id => JSON.parse(JSON.stringify((window as any).getProposalByIdOrHash(id))), id);
}

export async function showProposal(page: Page, id: string): Promise<void> {
  await page.evaluate(id => (window as any).showProposalDetails(id), id);
  const inspector = page.locator('#planning-inspector');
  const details = page.locator('#proposal-details-panel');
  await expect.poll(async () => await inspector.isVisible() || await details.isVisible()).toBe(true);
  if (await inspector.isVisible()) {
    await inspector.getByRole('button', { name: 'Proposal actions', exact: true }).click();
    await expect(details).toBeVisible();
  }
}

export async function drawCorridor(page: Page, kind: 'road'|'track'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-transport-btn--${kind}`).click();
  if (kind === 'track') await page.locator('#track-speed-confirm-btn').click();
  await expect(page.locator('#road-drawing-controls')).toBeVisible();
  await clickMapPoint(page, 15.98195, 45.80025);
  await clickMapPoint(page, 15.98245, 45.80025);
  await page.locator('#finishRoadButton').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.roadProposal && p.applied))).toBe(true);
  return page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.roadProposal && p.applied).proposalId);
}

export async function createBuilding(page: Page, rule: 'exact' | 'max' | 'range' = 'exact'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--buildings').click();
  const scope = page.getByRole('alertdialog');
  const ruleSelect = page.locator('#blockify-ruletype-select');
  await expect.poll(async () => await scope.isVisible() || await ruleSelect.isVisible()).toBe(true);
  if (await scope.isVisible()) await scope.getByRole('button', { name: 'No, just this parcel' }).click();
  await selectNativeOption(page.locator('#blockify-ruletype-select'), rule);
  if (rule !== 'exact') {
    await page.locator('#height-slider').focus();
    await page.keyboard.press('End');
  }
  await expect(page.locator('#btn-blockify-done')).toBeEnabled();
  await page.locator('#btn-blockify-done').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.geometry?.buildings?.length && p.applied))).toBe(true);
  return page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.geometry?.buildings?.length && p.applied).proposalId);
}
