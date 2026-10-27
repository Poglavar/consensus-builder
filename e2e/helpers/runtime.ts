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

// Finish the explicit placement step using a real pointer on the draft's selected starting land.
export async function placeFreeformBuilding(page: Page): Promise<void> {
  await expect(page.locator('#single-building-editor')).toHaveAttribute('data-placing', 'true');
  const at = await page.evaluate(() => {
    const w = window as any;
    const site = w.getActiveProposalDesignDraft()?.fields?.site;
    const [lng, lat] = w.turf.pointOnFeature(site?.type === 'Feature' ? site : w.turf.feature(site)).geometry.coordinates;
    const three = w.isThreeModeActive?.() && w.getThreeModeInternals?.();
    if (three) {
      const [x, y] = three.latLngToXY(lat, lng);
      const point = new w.THREE.Vector3(x, y, 0).project(three.camera);
      const rect = three.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
    }
    const point = w.map.latLngToContainerPoint([lat, lng]);
    const rect = w.map.getContainer().getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  });
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#single-building-editor')).not.toHaveAttribute('data-placing');
}

// A real mouse click on an applied design on the map: a point inside its shape (MapPick.outlineOf, the
// shape a pick highlights) is brought to `at` (fractions of the map's size, clear of the dock or a
// sheet) and clicked once nothing covers the map there (a notice can sit over it for a few seconds).
export async function clickDesignOnMap(page: Page, id: string, at = { x: 0.3, y: 0.45 }): Promise<void> {
  const point = await page.evaluate(({ id, at }) => {
    const w = window as any;
    const features = w.MapPick.outlineOf(w.proposalStorage.getProposal(id));
    if (!features.length) throw new Error(`design ${id} has no shape on the map`);
    const [lng, lat] = w.turf.pointOnFeature(features[0]).geometry.coordinates;
    const size = w.map.getSize();
    const here = w.map.latLngToContainerPoint([lat, lng]);
    w.map.panBy([here.x - size.x * at.x, here.y - size.y * at.y], { animate: false });
    return { lng, lat };
  }, { id, at });
  await expect.poll(() => page.evaluate(({ lng, lat }) => {
    const w = window as any;
    const onScreen = w.map.latLngToContainerPoint([lat, lng]);
    const box = w.map.getContainer().getBoundingClientRect();
    const target = document.elementFromPoint(box.left + onScreen.x, box.top + onScreen.y);
    return target && target.closest('#map') ? 'map' : (target ? target.outerHTML.slice(0, 120) : 'nothing');
  }, point), { timeout: 20_000, message: `the map at ${id}'s point` }).toBe('map');
  await clickMapPoint(page, point.lng, point.lat);
}

// The click stack (click-stack.md): one right-docked panel for everything under a map click, a
// section per kind of thing there. The parcel section hosts #parcel-info-panel and the parcel's
// actions as [data-command="parcel.*"] buttons; bare ground's section carries [data-command="ground.*"].
export const clickStack = (page: Page) => page.locator('#click-stack');
export const stackSection = (page: Page, kind: string) => page.locator(`#click-stack .click-stack__section[data-kind="${kind}"]`);
export const stackCommand = (page: Page, id: string) => page.locator(`#click-stack [data-command="${id}"]`);
export const selectionSection = (page: Page) => stackSection(page, 'selection');

export async function expandSelectionSection(page: Page): Promise<void> {
  const row = selectionSection(page).locator('.click-stack__row');
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

// Contextual site commands remain available through the palette after their parcel shortcuts retire.
export async function runPaletteCommand(page: Page, command: string): Promise<void> {
  const label=await page.evaluate(id=>{
    const w=window as any;
    return w.UiCommands.labelOf(w.UiCommands.findCommand(id),(key: string)=>w.i18n.t(key));
  },command);
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.command-palette-backdrop')).toBeVisible();
  await page.locator('.command-palette__input').fill(label);
  await page.locator(`.command-palette__item[data-command="${command}"]`).click();
  await expect(page.locator('.command-palette-backdrop')).toBeHidden();
}

// Selection actions live in the section body, so reveal them before using a command.
export async function runSelectionCommand(page: Page, command: string): Promise<void> {
  await expandSelectionSection(page);
  if (command === 'selection.useAsSite') await runPaletteCommand(page,command);
  else await stackCommand(page, command).click();
}

export async function showSelectionDesignTab(page: Page): Promise<void> {
  await expandSelectionSection(page);
  await parcelTab(page, 'propose-tab').click();
}

// Expands a section of the open stack unless it already is.
export async function expandStackSection(page: Page, kind: string): Promise<void> {
  const row = stackSection(page, kind).locator('.click-stack__row');
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

// The parcel panel's tab buttons (Info, Propose, Proposals, Tools). Hosted in the stack it shows
// Info, Propose and Tools: the Designs section lists the parcel's proposals. The parcel section
// shows only the actions the panel does not offer (Compare, Use as site) as [data-command] buttons.
export const parcelTab = (page: Page, tabId: string) => page.locator(`#parcel-info-panel [data-parcel-tab-id="${tabId}"]`);

// Before / after folds the click stack to its rows; the Design row shows its card again. A
// stack that is not folded is left as it is.
export async function unfoldStack(page: Page): Promise<void> {
  if (!(await clickStack(page).evaluate(element => element.classList.contains('is-folded')).catch(() => false))) return;
  await stackSection(page, 'designs').locator('.click-stack__row').click();
  await expect(clickStack(page)).not.toHaveClass(/\bis-folded\b/);
}

// Hides the parcel panel. In selection mode the section stays active, so collapse its row instead
// of using Escape, which ends selection.
export async function closeParcel(page: Page): Promise<void> {
  const panel = page.locator('#parcel-info-panel');
  if (await selectionSection(page).count()) {
    const row = selectionSection(page).locator('.click-stack__row');
    if (await row.getAttribute('aria-expanded') === 'true') await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    return;
  }
  if (await clickStack(page).locator('#parcel-info-panel').isVisible()) {
    await page.keyboard.press('Escape');
    await expect(clickStack(page)).toBeHidden();
  } else {
    await panel.locator('.panel-header .close-button').click();
  }
  await expect(panel).toBeHidden();
}

// A map click at a point whose stack holds a parcel, with the parcel section expanded.
export async function openParcelAt(page: Page, lng: number, lat: number): Promise<void> {
  await clickMapPoint(page, lng, lat);
  await expect(clickStack(page)).toBeVisible();
  // A corridor may have replaced the source parcel at this point. Design tools belong to the
  // current formed remainder when one is present; the cadastral parcel is only the fallback.
  const kind = await stackSection(page, 'formed').count() ? 'formed' : 'parcels';
  await expandStackSection(page, kind);
  await expect(stackSection(page, kind).locator('#parcel-info-panel')).toBeVisible();
}

// The parcel at a point, then one of the parcel section's actions.
export async function runParcelCommand(page: Page, lng: number, lat: number, command: string): Promise<void> {
  await openParcelAt(page, lng, lat);
  if (command === 'parcel.useAsSite') await runPaletteCommand(page,command);
  else await stackCommand(page, command).click();
}

// The parcel at a point, with its panel on one tab.
export async function openParcelTabAt(page: Page, lng: number, lat: number, tabId: string): Promise<void> {
  await openParcelAt(page, lng, lat);
  await parcelTab(page, tabId).click();
  await expect(page.locator(`#${tabId}`)).toBeVisible();
}

// Opens the ordinary block editor from the current parcel panel, resolving the optional scope
// prompt the same way createBuilding does.
export async function openBlockEditor(page: Page): Promise<void> {
  await page.locator('.parcel-build-btn--buildings').click();
  const prompt = page.getByRole('alertdialog');
  const ruleType = page.locator('#blockify-ruletype-select');
  await expect(prompt.or(ruleType)).toBeVisible();
  if (await prompt.isVisible()) await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
  await expect(ruleType).toBeVisible();
}

// Clicks the parcel's centre and brings up its section in the click stack, with the parcel panel on
// `tab` (explicitly selects Info, Design, or Tools; the application's default is Design).
export async function openParcel(page: Page, tab = 'info', id = PARCEL_ID): Promise<void> {
  const center = await page.evaluate(parcelId => {
    const w = window as any;
    const layer = w.ParcelPresenter.getLayer(parcelId);
    if (!layer) throw new Error(`ParcelPresenter has no layer for ${parcelId}`);
    const center = layer.getBounds().getCenter();
    w.map.panTo(center, { animate: false });
    return { lng: center.lng, lat: center.lat };
  }, id);
  // Leave manual selection first: Escape finishes the mode but retains selected parcels in the
  // stack, so a second Escape closes that retained stack before the next map click.
  if (await page.evaluate(() => !!(window as any).multiParcelSelection?.isActive)) {
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!(window as any).multiParcelSelection?.isActive)).toBe(false);
  }
  if (await clickStack(page).isVisible()) {
    await page.keyboard.press('Escape');
    // Closing a design can reveal land retained behind it. Dismiss that separate selection too.
    if (await page.evaluate(() => (window as any).ClickStack.current()?.topRef === 'selection:current')) {
      await page.keyboard.press('Escape');
    }
    await expect(clickStack(page)).toBeHidden();
  }
  await clickMapPoint(page, center.lng, center.lat);
  await expect(clickStack(page)).toBeVisible();
  await expandStackSection(page, 'parcels');
  await expect(stackSection(page, 'parcels').locator('#parcel-info-panel')).toBeVisible();
  if (tab === 'info') await parcelTab(page, 'info-tab').click();
  else if (tab === 'proposals' || tab === 'design') await parcelTab(page, 'propose-tab').click();
  else if (tab === 'tools') await parcelTab(page, 'tools-tab').click();
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

// The proposal panel's tabs: Overview (name, rung, type, author, size) and Details (land and
// ownership, verification, the record). The actions stay in the footer under both.
export async function showProposalTab(page: Page, tab: 'overview' | 'details'): Promise<void> {
  const button = page.locator(`#proposal-details-panel [data-proposal-tab="${tab}"]`);
  if (await button.getAttribute('aria-selected') !== 'true') await button.click();
  await expect(page.locator(`#proposal-details-panel [data-proposal-tabpanel="${tab}"]`)).toBeVisible();
}

export async function showProposal(page: Page, id: string): Promise<void> {
  await page.evaluate(id => (window as any).showProposalDetails(id), id);
  if (await page.locator('body').evaluate(el => el.classList.contains('three-mode-active'))) {
    await page.locator('#three-click-stack').getByRole('button', { name: 'Design actions', exact: true }).click();
  }
  await expect(stackSection(page, 'designs').locator('#proposal-details-panel')).toBeVisible();
  await expect(page.locator('#planning-inspector')).toBeHidden();
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
  await openBlockEditor(page);
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
