import { openLayerSection } from '../helpers/layers';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, createBuilding, proposalState, parcelTab, PARCEL_ID, expectStatusLogged, answerBlockScope } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { openAndClosePopup, selectNativeOption } from '../helpers/controls';

const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

async function createGroundProposal(page: any, kind: 'park' | 'square'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind}`).click();
  await answerBlockScope(page);
  await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((proposal: any) => proposal.structureProposal?.kind === kind && proposal.applied), kind)).toBe(true);
  return page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.structureProposal?.kind === kind).proposalId, kind);
}

// curatedRoads: false leaves the fixture parcel off the curated road list, which always loads with
// the map (js/road-parcels.js), since a road's own style wins over every highlight.
async function openLayers(page: any, { curatedRoads = true } = {}) {
  await installLayerDatasets(page);
  if (!curatedRoads) {
    await page.route('**/road-parcels**', (route: any) => route.request().resourceType() === 'script'
      ? route.continue()
      : route.fulfill({ json: { ids: [], truncated: false } }));
  }
  await openCity(page);
  await page.evaluate(async ids => {
    await (window as any).CadastralParcelRepository.ensureIds(ids);
  }, PARCEL_IDS);
    await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).ParcelPresenter.getLayer(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);
    await expect.poll(() => page.evaluate(id => (window as any).LiveParcelFabric.get(id)?.properties?.BROJ_CESTICE, PARCEL_ID)).toBe('1234');
    await page.locator('#layers-button').click();
    await expect(page.locator('#layers-sheet')).toBeVisible();
    await openLayerSection(page, 'parcels');
    await openLayerSection(page, 'roads');
    // The never-built claims-count toggle was dropped from the sheet (fbe3758d); the ad-parcel toggle
    // is the one parcel control zoom must never gate.
    await expect(page.locator('#showClaimsCounts')).toHaveCount(0);
    const adParcels = page.locator('#showAdParcelsCheckbox');
    await expect(adParcels).toBeEnabled();
    const zoomIn = page.locator('.leaflet-control-zoom-in');
    const zoomOut = page.locator('.leaflet-control-zoom-out');
    if (await zoomIn.count()) {
      await zoomIn.click();
      await expect(adParcels).toBeEnabled();
      await zoomOut.click();
      await expect(adParcels).toBeEnabled();
    }
}

test.describe('Layers sheet behavior @features', () => {
  test('Alatau state-land controls fetch and draw free plots and applications', async ({ mockApi: page }) => {
    const relayCalls: string[] = [];
    // State land is independent of the ordinary parcel layer. Open the map with the visitor's
    // session choice to continue without parcels and supply only the two state land views here.
    await page.addInitScript(() => sessionStorage.setItem('cb_without_parcels:alatau', '1'));
    await page.route('**/parcel-provider-relay/kz-alatau-pkk?**', async route => {
      const target = new URL(route.request().url()).searchParams.get('url') || '';
      if (!/freelands_view|reqland_view/.test(target)) return route.fallback();
      relayCalls.push(target);
      const applications = target.includes('reqland_view');
      await route.fulfill({ json: {
        type: 'FeatureCollection', numberMatched: 1, totalFeatures: 1,
        features: [{ type: 'Feature', properties: { gid: applications ? 2 : 1, id: applications ? 'APP-1' : 'FREE-1',
          usedesc_ru: applications ? 'Жильё' : 'Свободный участок',
          auction_land_status_id: applications ? null : 89, status_land_id: applications ? 100 : null,
          create_time: '2026-01-02T00:00:00Z', update_time: '2026-02-03T00:00:00Z' },
          geometry: { type: 'Polygon', coordinates: [[[13668280, 4853540], [13668310, 4853540], [13668310, 4853570], [13668280, 4853570], [13668280, 4853540]]] } }]
      } });
    });
    await page.goto('/?city=alatau&at=43.7984,77.0911,16&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).CityConfigManager?.getCurrentCityConfig?.()?.stateLand);
    await page.locator('#layers-button').click();
    await expect(page.locator('#layers-sheet')).toBeVisible();
    await openLayerSection(page, 'parcels');
    const free = page.locator('#showStateFreePlots');
    const applications = page.locator('#showLandApplications');
    await expect(free).toBeVisible();
    await expect(applications).toBeVisible();
    await free.check();
    await expect.poll(() => page.locator('.state-land-shape--free').count()).toBe(1);
    await applications.check();
    await expect.poll(() => page.locator('.state-land-shape--application').count()).toBe(1);
    expect(relayCalls.some(url => url.includes('freelands_view'))).toBe(true);
    expect(relayCalls.some(url => url.includes('reqland_view'))).toBe(true);
    await free.uncheck();
    await expect(page.locator('.state-land-shape--free')).toHaveCount(0);
    await applications.uncheck();
    await expect(page.locator('.state-land-shape--application')).toHaveCount(0);
  });

  test('parcel, ownership, label, ad, and minted controls produce visible map data', async ({ mockApi: page }) => {
    // This complete sheet flow also opens and closes two real external browser tabs.
    test.setTimeout(60_000);
    await openLayers(page, { curatedRoads: false });
    const mapHasParcels = () => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer));
    await page.locator('#parcelsCheckbox').uncheck();
    await expect.poll(mapHasParcels).toBe(false);
    await page.locator('#parcelsCheckbox').check();
    await expect.poll(mapHasParcels).toBe(true);

    const proposalId = await page.evaluate(id => (window as any).proposalStorage.addProposal({
      title: 'Layer count fixture', goal: 'as-is', lifecycleStatus: 'Active', cadastreParcelIds: [id],
    }), PARCEL_ID);
    expect(proposalId).toBeTruthy();

    await page.locator('#showParcelNumbers').check();
    // The label is a span inside the marker's anchor icon since 51152a2e.
    await expect(page.locator('.leaflet-marker-icon.parcel-number-label-anchor .parcel-number-label').first()).toContainText('1234');
    await page.locator('#showOwnerCounts').check();
    await expect(page.locator('.parcel-owner-count-label').first()).toContainText('2');
    await page.locator('#showProposalCounts').check();
    await expect(page.locator('.parcel-proposal-count-label').first()).toContainText('1');
    const neutralStyle = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[0]);
    await page.locator('#highlightOwnershipGovernment').check();
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[1])).not.toBe(neutralStyle);
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[0])).toBe(neutralStyle);
    for (const [checkboxId, parcelId] of [
      ['highlightOwnershipInstitution', PARCEL_IDS[2]],
      ['highlightOwnershipCompany', PARCEL_IDS[3]],
      ['highlightOwnershipPrivate', PARCEL_IDS[0]],
    ]) {
      const previous = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, parcelId);
      await page.locator(`#${checkboxId}`).check();
      await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, parcelId)).not.toBe(previous);
    }

    await page.evaluate(id => (window as any).ParcelsMintedLayer.addMintedParcels([id]), PARCEL_ID);
    await page.locator('#markMintedCheckbox').check();
    await expect(page.locator('.minted-parcel-icon').first()).toBeVisible();

    const parcelStyleBeforeAd = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_ID);
    await page.locator('#showAdParcelsCheckbox').check();
    await expect.poll(() => page.evaluate(() => (window as any).ParcelsAdParcels.getAdParcelIds().has('HR-335754-1234'))).toBe(true);
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_ID)).not.toBe(parcelStyleBeforeAd);

    await page.locator('#layers-sheet [data-sheet-close]').click();
    await openParcel(page);
    await page.locator('.parcel-ad-link-btn').click();
    const adActions = page.locator('#parcel-ad-dialog');
    await expect(adActions).toBeVisible();
    const adUrl = 'https://example.invalid/fixture-ad';
    for (const [name, url] of [['Marketplace', adUrl]]) {
      // Returning from an external tab can refresh the parcel panel and close its popover.
      if (!(await adActions.isVisible())) await page.locator('.parcel-ad-link-btn').click();
      await page.context().route(`${url}**`, route => route.fulfill({ contentType: 'text/html', body: '<title>External destination fixture</title>' }));
      await openAndClosePopup(page, () => adActions.getByRole('button', { name, exact: true }).click(), async child => {
        // Verify and close the external tab as soon as it opens. Headed Chrome may hold the
        // parent click's input acknowledgement while this new native window remains open.
        // Commit is enough to verify the mocked destination without its full load event.
        await child.waitForURL(actual => actual.href.startsWith(url), { waitUntil: 'commit' });
        expect(page.context().pages().filter(candidate => candidate !== page)).toEqual([child]);
        if (name === 'Parcel builder') expect(new URL(child.url()).searchParams.get('parcel_identifier')).toBe('1234-335754');
      });
    }
    if (!(await adActions.isVisible())) await page.locator('.parcel-ad-link-btn').click();
    await page.locator('.parcel-ad-link-btn').click();
    await expect(adActions).toBeHidden();
    // Parcel Builder is authoring work, so it lives in the Tools page alongside the creation palette.
    const builderUrl = await page.evaluate(() => (window as any).CityConfigManager.getParcelBuilderConfig().url);
    await page.context().route(url => url.href.startsWith(builderUrl), route => route.fulfill({
      contentType: 'text/html', body: '<title>Parcel Builder fixture</title>',
    }));
    await parcelTab(page, 'tools-tab').click();
    await openAndClosePopup(page, () => page.locator('#parcelBuilderButton').click(), async child => {
      await child.waitForURL(actual => actual.href.startsWith(builderUrl), { waitUntil: 'commit' });
      expect(new URL(child.url()).searchParams.get('parcel_identifier')).toBe('1234-335754');
    });
  });

  test('hiding parcels survives viewport movement and blocks retained-layer interaction', async ({ mockApi: page }) => {
    await openLayers(page, { curatedRoads: false });
    const parcelToggle = page.locator('#parcelsCheckbox');
    const mapHasParcels = () => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer));
    await expect.poll(mapHasParcels).toBe(true);
    const retainedCenter = await page.evaluate((id) => {
      const w = window as any;
      const center = w.ParcelPresenter.getLayer(id).getBounds().getCenter();
      const point = w.map.latLngToContainerPoint(center);
      const rect = w.map.getContainer().getBoundingClientRect();
      return { lat: center.lat, lng: center.lng, x: point.x + rect.left, y: point.y + rect.top };
    }, PARCEL_ID);

    const closeLayers = () => page.locator('#layers-sheet [data-sheet-close]').click();
    const openLayersSheet = async () => {
      await page.locator('#layers-button').click();
      await openLayerSection(page, 'parcels');
    };
    await closeLayers();
    const hoverLabel = page.locator('.proposal-hover-parcel-label');
    await page.mouse.move(retainedCenter.x, retainedCenter.y);
    await expect(hoverLabel).toContainText('1234');
    await openLayersSheet();
    await parcelToggle.press('Space');
    await expect(parcelToggle).not.toBeChecked();
    await expect.poll(mapHasParcels).toBe(false);
    await closeLayers();

    await page.mouse.move(retainedCenter.x, retainedCenter.y);
    await expect(hoverLabel).toHaveCount(0);
    await clickMapPoint(page, retainedCenter.lng, retainedCenter.lat);
    await expect(page.locator('#click-stack')).toBeHidden();

    await page.evaluate(async () => {
      const w = window as any;
      const repository = w.CadastralParcelRepository;
      w.__viewportParcelCalls = 0;
      w.CadastralParcelRepository = {
        ...repository,
        ensureBounds(...args: unknown[]) {
          w.__viewportParcelCalls++;
          return repository.ensureBounds(...args);
        }
      };
      const zoom = w.map.getZoom();
      w.map.panBy([180, 0], { animate: false });
      w.map.setZoom(w.parcelZoomRange().min - 1, { animate: false });
      w.map.setZoom(zoom, { animate: false });
      await new Promise(resolve => setTimeout(resolve, w.ParcelFetchConfig.getDebounce() + 150));
    });
    expect(await page.evaluate(() => (window as any).__viewportParcelCalls)).toBe(0);
    await expect.poll(mapHasParcels).toBe(false);

    await openLayersSheet();
    await expect(parcelToggle).not.toBeChecked();
    await parcelToggle.check();
    await expect.poll(mapHasParcels).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__viewportParcelCalls)).toBeGreaterThan(0);
  });

  test('building and road reference layers load real features on checkbox clicks', async ({ mockApi: page }) => {
    await openLayers(page);
    await openLayerSection(page, 'buildings');
    await page.locator('#showBuildings').check();
    await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool.some((feature: any) => feature.properties.source === 'gdi-3d' && feature.properties.id === 9001))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);

    await page.locator('#showGovernmentRoadPlan').check();
    await expect.poll(() => page.evaluate(() => (window as any).governmentRoadPlanLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).governmentRoadPlanLayer))).toBe(true);

    await page.locator('#showOSMRoadLines').check();
    await expect.poll(() => page.evaluate(() => (window as any).osmRoadLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadLayer))).toBe(true);
    await page.locator('#showGUPRoadLines').check();
    await expect.poll(() => page.evaluate(() => (window as any).gupRoadLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).gupRoadLayer))).toBe(true);

    await page.locator('#showLegacyRoadCenterlines').check();
    await expect.poll(() => page.evaluate(() => {
      const map = (window as any).map;
      let names = 0;
      map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.name === 'Fixture street')) names++; });
      return names;
    })).toBeGreaterThan(0);

    await page.locator('#showWFSPolygons').check();
    await expectStatusLogged(page, 'Drew 1 DGU road-usage polygons');
    const withDguUse = await page.evaluate(() => {
      let count = 0;
      (window as any).map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.OBJECTID === 801)) count++; });
      return count;
    });
    expect(withDguUse).toBeGreaterThan(0);
    await page.locator('#showWFSPolygons').uncheck();
    await expect.poll(() => page.evaluate(() => {
      let count = 0;
      (window as any).map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.OBJECTID === 801)) count++; });
      return count;
    })).toBe(0);
  });

  test('proposed-building visibility follows a real applied building proposal', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createBuilding(page);
    const saved = await proposalState(page, proposalId);
    await expect.poll(() => page.evaluate(() => (window as any).proposedBuildings.length)).toBeGreaterThan(0);
    await page.locator('#planning-views-button').click();
    await expect(page.locator('#planning-views')).toBeVisible();
    // Planning appearance hides the canvas pane without deleting its geometry or source record.
    const renderedProposalBuildings = () => page.evaluate(() => {
      const map = (window as any).map;
      let count = 0;
      map.eachLayer((layer: any) => {
        if (layer?.options?.pane === 'proposedBuildingsPane' && layer.feature?.properties?.proposalId) count++;
      });
      return count;
    });
    const canvas = page.locator('.leaflet-proposedBuildings-pane canvas');
    const proposedDisplay = page.locator('[data-planning-setting="proposed"]');
    await selectNativeOption(proposedDisplay, 'solid');
    await expect.poll(renderedProposalBuildings).toBeGreaterThan(0);
    await expect(canvas).toBeVisible();
    await selectNativeOption(proposedDisplay, 'off');
    await expect(canvas).toBeHidden();
    expect(await proposalState(page, proposalId)).toEqual(saved);
  });

  for (const kind of ['park', 'square'] as const) {
    test(`${kind} layer visibility follows its applied ground proposal`, async ({ mockApi: page }) => {
      await installLayerDatasets(page);
      await openCity(page);
      await createGroundProposal(page, kind);
      await openLayerSection(page, 'parks-squares');
      const paneName = kind === 'park' ? 'parksPane' : 'squaresPane';
      const checkbox = page.locator(kind === 'park' ? '#showParksCheckbox' : '#showSquaresCheckbox');
      const panePaths = () => page.evaluate(name => (window as any).map.getPane(name)?.querySelectorAll('path').length || 0, paneName);
      await expect.poll(panePaths).toBeGreaterThan(0);
      await checkbox.uncheck();
      await expect.poll(panePaths).toBe(0);
      await checkbox.check();
      await expect.poll(panePaths).toBeGreaterThan(0);
    });
  }
});
