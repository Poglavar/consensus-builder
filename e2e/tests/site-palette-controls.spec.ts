// Exercise every action of the site's proposal panel ("Propose here") through its real UI handlers.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, publishOn, PARCEL_ID, runParcelCommand } from '../helpers/runtime';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function beginParcelSite(page: import('@playwright/test').Page) {
  await openCity(page);
  await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
  const panel = page.locator('#site-panel');
  await expect(panel).toBeVisible();
  const site = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).SiteTool.current().site)));
  await panel.locator('[data-site-action="propose"]').click();
  const proposals = page.locator('#site-info-panel');
  await expect(proposals).toBeVisible();
  return { panel: proposals, site };
}

async function expectActiveDraftSite(page: import('@playwright/test').Page, site: any, adapterKey: string) {
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft()?.adapterKey || null)).toBe(adapterKey);
  const draft = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalDraftStore.getActiveDraft())));
  expect(draft.fields.site).toEqual(site);
  expect(draft.fields.binding.parcels.map((hit: any) => hit.parcelId)).toContain(PARCEL_ID);
}

async function expectFreeformDraftSite(page: import('@playwright/test').Page, authoredSite: any) {
  await expect.poll(() => page.evaluate(() => document.getElementById('single-building-editor') !== null)).toBe(true);
  const state = await page.evaluate(() => {
    const w = window as any;
    const draft = w.proposalDraftStore.getActiveDraft();
    const guideGeometries: any[] = [];
    const visitedLayers = new Set<any>();
    const inspectLayer = (layer: any) => {
      if (!layer || visitedLayers.has(layer)) return;
      visitedLayers.add(layer);
      const options = layer.options || {};
      const isGuide = options.pane === 'onMapEditorPane'
        && (options.color === '#e53935' || options.style?.color === '#e53935');
      if (isGuide && layer.feature?.geometry) {
        // Read the feature attached to the rendered Leaflet layer so serialization precision
        // does not round the authored coordinates while checking the placement guide.
        guideGeometries.push(layer.feature.geometry);
      }
      if (typeof layer.eachLayer === 'function') {
        layer.eachLayer(inspectLayer);
      }
    };
    w.map.eachLayer(inspectLayer);
    const guideGeometry = guideGeometries.length === 1
      ? w.__siteDraft.toMultiPolygon(guideGeometries[0]) : null;
    const buildings = draft?.editorPayload?.context?.buildings || [];
    let union = null;
    for (const building of buildings) {
      const feature = w.turf.feature(building.geometry, building.properties || {});
      union = union ? w.turf.union(union, feature) : feature;
    }
    const buildingsSite = union?.geometry ? w.__siteDraft.toMultiPolygon(union.geometry) : null;
    const insideGuide = !!guideGeometry && buildings.length > 0 && buildings.every((building: any) =>
      w.SingleBuildingGeometry.footprintWithinBoundary(
        building,
        w.turf.feature(guideGeometry),
        w.turf
      ));
    return {
      guideGeometry,
      draftSite: draft?.fields?.site || null,
      buildingsSite,
      placement: draft?.editorPayload?.placement || null,
      insideGuide,
      groundTreatment: draft?.editorPayload?.context?.groundSurface?.treatment || 'none',
      takeWholeParcels: draft?.editorPayload?.context?.takeWholeParcels === true
    };
  });
  expect(state.guideGeometry).toEqual(authoredSite);
  expect(state.insideGuide).toBe(true);
  expect(state.placement?.free).toBe(true);
  expect(state.groundTreatment).toBe('paved');
  expect(state.takeWholeParcels).toBe(false);
  // Paving surrounds the footprint within the authored site; the material footprint is smaller.
  expect(state.draftSite).toEqual(authoredSite);
}

test.describe('Site proposals already on its parcels @core', () => {
  test('the card counts them, Show opens the Proposals tab, and the tabs switch', async ({ mockApi: page }) => {
    const publishedCid = await publishOn(page, PARCEL_ID);
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    const card = page.locator('#site-panel');
    await expect(card.locator('.site-panel__existing')).toContainText('1 design already on these parcels');
    await card.locator('[data-site-action="show-proposals"]').click();
    const panel = page.locator('#site-info-panel');
    await expect(panel.locator('[data-site-tab="proposals"]')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('[data-site-tab="proposals"] .parcel-tab-count')).toHaveText('1');
    await expect(panel.locator(`[data-site-tab-panel="proposals"] [data-server-id="${publishedCid}"]`)).toContainText('Published park');
    const infoTab=panel.getByRole('tab',{name:'Info',exact:true});
    await expect(infoTab.locator('.fa-circle-info')).toBeVisible();
    await expect(infoTab).toHaveAttribute('title','Info');
    await expect(infoTab).toHaveText('');
    await infoTab.click();
    await expect(panel.locator('[data-site-tab-panel="info"]')).toContainText('Bound parcels (1)');
    const designTab=panel.getByRole('tab',{name:'Design',exact:true});
    await expect(designTab.locator('.fa-pen')).toBeVisible();
    await expect(designTab).toHaveAttribute('title','Design');
    await expect(designTab).toHaveText('');
    await designTab.click();
    await expect(panel.locator('[data-site-tab-panel="propose"] .parcel-build-btn--park')).toBeVisible();
  });
});

test.describe('Site build palette controls @core', () => {
  for (const item of [
    { key: 'buildings', adapter: 'buildings', surface: '#blockify-modal', label: 'Block' },
    { key: 'single', adapter: 'single', surface: '#single-building-editor', label: 'Freeform' },
  ]) test(`${item.label} opens its editor draft on the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${item.key}`).click();
    await expect(page.locator(item.surface).locator('.on-map-editor__panel')).toBeVisible();
    if (item.key === 'single') await expectFreeformDraftSite(page, site);
    else await expectActiveDraftSite(page, site, item.adapter);
  });

  for (const item of [
    { key: 'row', adapter: 'row', surface: '#rowhouse', label: 'Row houses' },
    { key: 'parcelBased', adapter: 'parcelBased', surface: '#parcelbased', label: 'Detached' },
  ]) test(`${item.label} plot flow opens its editor draft on the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${item.key}`).click();
    // Plot cutting continues on the site card; the proposal panel steps aside.
    const card = page.locator('#site-panel');
    await expect(panel).toBeHidden();
    await expect(card.locator('[data-site-action="plots-continue"]')).toBeEnabled();
    await expect(card.locator('[data-site-action="plots-back"]')).toBeVisible();
    await card.locator('[data-site-action="plots-continue"]').click();
    await expect(page.locator(item.surface).locator('.on-map-editor__panel')).toBeVisible();
    await expectActiveDraftSite(page, site, item.adapter);
  });

  for (const kind of ['park', 'square', 'lake']) test(`${kind} creates the matching structure from the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${kind}`).click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((proposal: any) =>
      proposal.applied && proposal.structureProposal?.kind === kind && proposal.site), kind)).toBe(true);
    const result = await page.evaluate(kind => {
      const proposal = (window as any).proposalStorage.getAllProposals().find((item: any) =>
        item.applied && item.structureProposal?.kind === kind && item.site);
      return { site: proposal.site, geometry: proposal.structureProposal.geometry };
    }, kind);
    expect(result.site).toEqual(site);
    const siteArea = await page.evaluate(geometry => (window as any).turf.area(geometry), site);
    const structureArea = await page.evaluate(geometry => (window as any).turf.area(geometry), result.geometry);
    expect(Math.abs(structureArea - siteArea)).toBeLessThan(0.1);
  });

  test('Lay out parcels waits for selected parcels on a site wholly over parcels, and says why', async ({ mockApi: page }) => {
    const { panel } = await beginParcelSite(page);
    const layout = panel.locator('.parcel-build-btn--parcel-layout');
    const reason = 'Lay out parcels works on selected parcels: select them instead of drawing a site.';
    await expect(layout).toBeDisabled();
    await expect(layout).toHaveAttribute('title', reason);
    await expect(panel.locator('.parcel-build-disabled-reason')).toHaveText(reason);
  });

  test('Subdivide opens the parcel-layout editor over the authored site, open ground included', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async id => { await (window as any).CadastralParcelRepository.ensureIds([id]); }, SECOND_PARCEL_ID);
    await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), SECOND_PARCEL_ID)).toBe(true);
    await page.evaluate(() => (window as any).map.setView([45.80025, 15.98255], 19, { animate: false }));
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(page.locator('#click-stack .click-stack__section[data-kind="ground"]')).toBeVisible();
    await page.locator('#click-stack [data-command="ground.drawSite"]').click();
    const panel = page.locator('#site-panel');
    await expect(panel).toBeVisible();
    await clickMapPoint(page, 15.98235, 45.80012);
    await clickMapPoint(page, 15.98275, 45.80012);
    await clickMapPoint(page, 15.98275, 45.80038);
    await clickMapPoint(page, 15.98235, 45.80038);
    await expect(panel.locator('[data-site-action="finish"]')).toBeEnabled();
    await panel.locator('[data-site-action="finish"]').click();
    await expect(panel.locator('[data-site-action="propose"]')).toBeEnabled();
    const openGroundArea = await page.evaluate(() => (window as any).__siteDraft.bindingSummary((window as any).SiteTool.current().preview).unsurveyedM2);
    expect(openGroundArea).toBeGreaterThan(0);
    await expect(panel.locator('.site-panel__note').filter({ hasText: 'ownership is unknown' })).toContainText('ground outside the supplied parcels');
    await panel.locator('[data-site-action="propose"]').click();
    const subdivide = page.locator('#site-info-panel .parcel-build-btn--parcel-layout');
    await expect(subdivide).toBeEnabled();
    await expect(subdivide).toHaveText(/Subdivide/i);
    await subdivide.click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('.on-map-editor__heading h2')).toHaveText('Subdivide');
    // Open ground has no borders to keep.
    await expect(modal.locator('input[name="reparcel-algorithm"][value="amend"]')).toBeDisabled();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    const siteArea = await page.evaluate(() => {
      const w = window as any;
      return w.turf.area(w.proposalDraftStore.getActiveDraft().fields.site);
    });
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toHaveCount(0);
    // The saved layout is pooled from the site: its pool is the site, open ground and all.
    const layout = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).pendingParcelLayout)));
    expect(layout.poolSource).toBe('site');
    expect(Math.abs(layout.openGroundM2 - openGroundArea)).toBeLessThan(1);
    const areas = await page.evaluate(plan => {
      const turf = (window as any).turf;
      return { pool: turf.area(plan.pool), plots: plan.plots.reduce((sum: number, plot: any) => sum + turf.area(plot.geometry), 0) };
    }, layout);
    expect(Math.abs(areas.pool - siteArea)).toBeLessThan(0.5);
    expect(Math.abs(areas.plots - siteArea)).toBeLessThan(1);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout' && proposal.parcelLayout?.poolSource === 'site'))).toBe(true);
  });

  for (const item of [
    { key: 'road', status: '#road-drawing-controls', label: 'Road' },
    { key: 'track', status: '#road-drawing-controls', label: 'Track' },
  ]) test(`${item.label} opens the real corridor drawing tool from the site palette`, async ({ mockApi: page }, testInfo) => {
    const { panel } = await beginParcelSite(page);
    if (item.key === 'track') {
      const track=panel.locator('.parcel-transport-btn--track');
      await expect(track.locator('.cb-icon-track')).toHaveCSS('mask-image', /track\.svg/);
      await track.scrollIntoViewIfNeeded();
      await page.screenshot({path:testInfo.outputPath('track-icon.png')});
    }
    await panel.locator(`.parcel-transport-btn--${item.key}`).click();
    if (item.key === 'track') {
      await expect(page.locator('#track-speed-confirm-btn')).toBeVisible();
      await page.locator('#track-speed-confirm-btn').click();
    }
    await expect(page.locator(item.status)).toBeVisible();
    await expect(panel).toBeHidden();
    await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  });

  for (const item of [
    { key: 'bus' },
    { key: 'tram' },
    { key: 'underground' },
    { key: 'elevated' },
  ]) test(`${item.key} station starts real placement mode from the site palette`, async ({ mockApi: page }) => {
    const { panel } = await beginParcelSite(page);
    await panel.locator(`.parcel-transport-btn--${item.key}`).click();
    const toolbar = page.locator('#station-placement-toolbar');
    await expect(toolbar).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    const mapPoint = await page.evaluate(() => {
      const map = (window as any).map;
      const center = map.latLngToContainerPoint(map.getCenter());
      const bounds = map.getContainer().getBoundingClientRect();
      return { x: bounds.left + center.x, y: bounds.top + center.y };
    });
    await page.mouse.move(mapPoint.x, mapPoint.y);
    const preview = page.locator('.transit-station-marker--preview span');
    await expect(preview).toBeVisible();
    const expectedIcon = await page.evaluate(key => (window as any).TransitStationModels.specFor(key).icon, item.key);
    await expect(preview).toHaveText(expectedIcon);
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#station-placement-status')).toContainText('Station placement cancelled.');
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(false);
  });
});
