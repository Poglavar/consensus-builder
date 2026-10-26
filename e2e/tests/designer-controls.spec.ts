import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, closeParcel, showSelectionDesignTab, parcelTab } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const BLOCK_PARCEL_IDS = [
  'HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238',
];

async function resolveParcelScopePrompt(page: any, target: any, chooseWholeBlock: boolean) {
  const prompt = page.getByRole('alertdialog');
  await expect.poll(async () => (await target.isVisible()) || (await prompt.isVisible())).toBe(true);
  if (await prompt.isVisible()) {
    await prompt.getByRole('button', { name: chooseWholeBlock ? 'Yes, select the block' : 'No, just this parcel' }).click();
  }
  await expect(target).toBeVisible();
}

async function visibleCutLineEndpoints(page: any) {
  const endpoints = await page.evaluate(() => {
    const w = window as any;
    const map = w.map;
    let geometry: any = null;
    map?.eachLayer((layer: any) => {
      if (layer.options?.pane === 'reparcelTools' && layer.options.color === '#dc2626'
        && layer._path?.isConnected && layer.feature?.geometry) geometry = layer.feature.geometry;
    });
    if (!geometry || !w.turf) throw new Error('The parcel layout has no rendered pool boundary');
    const mapRect = map.getContainer().getBoundingClientRect();
    const obstacles = [...document.querySelectorAll('.on-map-reparcellization .on-map-editor__panel, .reparcel-tools')]
      .map((element: any) => element.getBoundingClientRect());
    const visible = (screen: { x: number; y: number }) => screen.x >= mapRect.left && screen.x <= mapRect.right
      && screen.y >= mapRect.top && screen.y <= mapRect.bottom
      && screen.x >= 8 && screen.x <= w.innerWidth - 8 && screen.y >= 8 && screen.y <= w.innerHeight - 8
      && map.getContainer().contains(document.elementFromPoint(screen.x, screen.y))
      && !obstacles.some(rect => screen.x >= rect.left && screen.x <= rect.right && screen.y >= rect.top && screen.y <= rect.bottom);
    const feature = { type: 'Feature', properties: {}, geometry };
    const [minLng, minLat, maxLng, maxLat] = w.turf.bbox(feature);
    const candidates = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].flatMap(ratio => {
      const lng = minLng + (maxLng - minLng) * ratio;
      const lat = minLat + (maxLat - minLat) * ratio;
      return [0.08, 0.04, 0.02].flatMap(extension => [
        [[minLng - (maxLng - minLng) * extension, lat], [maxLng + (maxLng - minLng) * extension, lat]],
        [[lng, minLat - (maxLat - minLat) * extension], [lng, maxLat + (maxLat - minLat) * extension]],
      ]);
    });
    for (const coordinates of candidates) {
      const line = w.turf.lineString(coordinates);
      if (w.turf.lineIntersect(line, feature).features.length < 2) continue;
      const screens = coordinates.map((coordinate: number[]) => {
        const projected = map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
        return { x: mapRect.left + projected.x, y: mapRect.top + projected.y };
      });
      if (screens.every(visible)) return screens;
    }
    throw new Error('No boundary-crossing line fits the unobstructed map area');
  });
  return endpoints as Array<{ x: number; y: number }>;
}

test.describe('Designer controls persist their edits @features', () => {
  test('parcel-based rule type and ranges change the generated design and saved proposal context', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcelBased').click();
    const modal = page.locator('#parcelbased');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });

    const maxFloors = page.locator('#parcelbased-maxfloors-slider');
    const originalFloors = Number(await maxFloors.inputValue());
    await maxFloors.focus();
    await maxFloors.press('ArrowRight');
    await expect(page.locator('#parcelbased-maxfloors-value')).toHaveText(String(originalFloors + 1));
    const initialDistance = Number(await page.locator('#parcelbased-mindistance-slider').inputValue());
    await page.locator('#parcelbased-mindistance-slider').focus();
    await page.locator('#parcelbased-mindistance-slider').press('ArrowRight');
    expect(Number(await page.locator('#parcelbased-mindistance-slider').inputValue())).toBeGreaterThan(initialDistance);

    const rule = page.locator('#parcelbased-ruletype-select');
    await selectNativeOption(rule, 'range');
    await expect(page.locator('#parcelbased-minimums')).toBeVisible();
    const minimumFloors = page.locator('#parcelbased-minfloors-slider');
    await expect(minimumFloors).toBeVisible();
    const initialMinimumFloors = Number(await minimumFloors.inputValue());
    await minimumFloors.focus();
    await minimumFloors.press('ArrowRight');
    expect(Number(await minimumFloors.inputValue())).toBeGreaterThan(initialMinimumFloors);
    for (const selector of ['#parcelbased-minfootprint-slider', '#parcelbased-minplot-slider']) {
      const slider = page.locator(selector);
      const before = Number(await slider.inputValue());
      await slider.focus();
      await slider.press('ArrowRight');
      expect(Number(await slider.inputValue())).toBeGreaterThan(before);
    }
    await selectNativeOption(rule, 'exact');
    await expect(page.locator('#parcelbased-minimums')).toBeHidden();
    await selectNativeOption(rule, 'max');
    await page.locator('#btn-parcelbased-done').click();

    const context = await page.evaluate(() => (window as any).pendingBuildingProposalContext);
    expect(context.parcelIds).toContain('HR-335754-1234');
    expect(context.parameters.rule.kind).toBe('max');
    expect(context.parameters.maxFloors).toBe(originalFloors + 1);
    expect(context.parameters.minDistance).toBeGreaterThan(2);
    expect(context.parameters.rule.minFloors).toBeGreaterThan(initialMinimumFloors);
    expect(context.parameters.rule.minPlotAreaM2).toBeGreaterThan(0);
    expect(context.buildings.length).toBeGreaterThan(0);
    expect(context.buildings.every((feature: any) => feature.geometry?.type === 'Polygon')).toBe(true);
  });

  test('minimum plot area excludes undersized cadastral parts from the saved building set', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await closeParcel(page);
    await showSelectionDesignTab(page);
    await page.locator('.parcel-build-btn--buildings').click();
    const wholeBlockPrompt = page.getByRole('alertdialog');
    if (await wholeBlockPrompt.isVisible().catch(() => false)) {
      await wholeBlockPrompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });

    const minPlot = page.locator('#blockify-minplot-slider');
    while (Number(await minPlot.inputValue()) < 100) await minPlot.press('ArrowRight');
    await expect(page.locator('#blockify-minplot-value')).toHaveText('100');

    // The slider decides which cadastral plots can host a building. The editor exposes those
    // exclusions in its live preview and the saved Block keeps them (a Block always stands on its
    // parcels, MEMORY.md 2026-10-18), while its massing stays one whole geometry rather than being
    // split into one saved building per eligible parcel.
    const livePreview = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).OnMapEditor.getPreview())));
    expect(livePreview.excluded).toHaveLength(3);
    const excludedParcelIds = await page.evaluate(([excluded, ids]) => {
      const turf = (window as any).turf;
      const repository = (window as any).CadastralParcelRepository;
      return (excluded as any[]).map(feature => {
        const center = turf.centroid(feature);
        return (ids as string[]).find(id => turf.booleanPointInPolygon(center, repository.get(id))) || null;
      }).sort();
    }, [livePreview.excluded, BLOCK_PARCEL_IDS]);
    expect(excludedParcelIds).toEqual(BLOCK_PARCEL_IDS.slice(0, 3).sort());
    await expect(page.locator('#blockify-info')).toContainText('3 parcels left out');
    expect(livePreview.draftPreview.features).toHaveLength(2);
    const visibleExcludedPlots = page.locator('#map-container .leaflet-onMapEditor-pane path[stroke="#b0453a"][stroke-dasharray="2, 5"]');
    await expect(visibleExcludedPlots).toHaveCount(3);
    await expect(visibleExcludedPlots.first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!(window as any).getActiveProposalDesignDraft?.()
      ?.editorPayload?.context?.buildingFeature?.geometry)).toBe(true);
    const authoredGeometry = await page.evaluate(() => JSON.parse(JSON.stringify(
      (window as any).getActiveProposalDesignDraft().editorPayload.context.buildingFeature.geometry
    )));
    await page.locator('#btn-blockify-done').click();

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((proposal: any) => proposal.applied && proposal.geometry?.buildings?.length))).toBe(true);
    const proposal = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((entry: any) => entry.applied && entry.geometry?.buildings?.length));
    expect(proposal.cadastreParcelIds).toEqual(expect.arrayContaining(BLOCK_PARCEL_IDS));
    expect(proposal.geometry.buildings).toHaveLength(1);
    // Authored records compact an identical blockMassing into the one saved building feature.
    expect(proposal.geometry.blockMassing).toBeUndefined();
    expect(proposal.geometry.buildings[0].geometry).toEqual(authoredGeometry);
    expect(proposal.buildingProposal.ineligibleParcels).toHaveLength(3);
    const relevantParcelIds = await page.evaluate(([site, ids]) => {
      const turf = (window as any).turf;
      const feature = { type: 'Feature', properties: {}, geometry: site };
      return (ids as string[]).filter(id => turf.booleanIntersects(feature, (window as any).CadastralParcelRepository.get(id)));
    }, [proposal.site, BLOCK_PARCEL_IDS]);
    // Not a free placement: the Block is declared on its parcels rather than bound to a moved site.
    expect(proposal.freePlacement ?? false).toBe(false);
    expect(relevantParcelIds.length).toBeGreaterThan(0);
    expect(proposal.cadastreParcelIds).toEqual(expect.arrayContaining(relevantParcelIds));

    await page.locator('#mode-3d-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(id => (window as any).proposedBuildings
      .some((feature: any) => feature.properties?.proposalId === id), proposal.proposalId)).toBe(true);
  });

  test('3D non-buildable plots toggle uses saved proposal exclusions', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    const proposalId = await page.evaluate(() => {
      const w = window as any;
      const massing = {
        type: 'Feature',
        properties: { height: 18, massing: true },
        geometry: { type: 'Polygon', coordinates: [[[15.9821, 45.8001], [15.9823, 45.8001], [15.9823, 45.8003], [15.9821, 45.8003], [15.9821, 45.8001]]] }
      };
      const excluded = {
        status: 'below-min-plot',
        height: 18,
        geometry: { type: 'Polygon', coordinates: [[[15.9824, 45.8001], [15.98255, 45.8001], [15.98255, 45.8003], [15.9824, 45.8003], [15.9824, 45.8001]]] },
        wouldBe: {
          type: 'Feature',
          properties: { height: 18 },
          geometry: { type: 'Polygon', coordinates: [[[15.9824, 45.8001], [15.98255, 45.8001], [15.98255, 45.8003], [15.9824, 45.8003], [15.9824, 45.8001]]] }
        }
      };
      return w.proposalStorage.addProposal({
        proposalId: 'e2e-ineligible-plot-toggle',
        title: 'E2E excluded plot toggle',
        description: 'Source-aware fixture for the saved non-buildable plot overlay.',
        offer: 100,
        offerCurrency: 'EUR',
        city: 'zg',
        goal: 'buildings',
        lifecycleStatus: 'Active',
        applied: true,
        cadastreParcelIds: ['HR-335754-1234'],
        geometry: { buildings: [massing], blockMassing: massing },
        buildingProposal: {
          typologyType: 'block',
          parameters: { rule: { kind: 'max', maxHeightM: 18 } },
          ineligibleParcels: [excluded]
        }
      });
    });
    await expect.poll(() => page.evaluate(id => (window as any).appliedIneligibleBlockParts(id).length, proposalId)).toBe(2);

    await page.locator('#mode-3d-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
    if (!(await page.locator('#model-layer-controls').isVisible())) await page.locator('#layers-button').click();
    await expect(page.locator('#model-layer-controls .three-mode-ui-panel')).toBeVisible();
    if (!(await page.locator('#planning-views').isVisible())) await page.locator('#planning-views-button').click();
    await expect(page.locator('#planning-views')).toBeVisible();
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'off');
    await selectNativeOption(page.locator('[data-planning-setting="proposed"]'), 'off');
    // Planning Views is its own sheet; the exclusion overlay toggle belongs to Layers.
    await page.locator('#layers-button').click();
    await expect(page.locator('#planning-views')).toBeHidden();
    await expect(page.locator('#model-layer-controls .three-mode-ui-panel')).toBeVisible();
    const toggle = page.locator('#model-layer-controls label.three-mode-wide-toggle[aria-label*="current applied rule"] input[type="checkbox"]');
    const ineligibleVisibleMeshes = () => page.evaluate(() => {
      const scene = (window as any).getThreeModeInternals()?.scene;
      const group = scene?.getObjectByName('IneligibleBuildings');
      const meshes: Array<{ vertices: number; opacity: number }> = [];
      group?.traverseVisible((object: any) => {
        if (!object.isMesh || !object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const opacity = Math.min(...materials.map((material: any) =>
          material.userData?.cbBuildingOpacity ?? material.opacity ?? 1));
        const vertices = object.geometry?.attributes?.position?.count || 0;
        if (vertices > 0) meshes.push({ vertices, opacity });
      });
      return meshes;
    });
    await expect(toggle).not.toBeChecked();
    await expect.poll(ineligibleVisibleMeshes).toHaveLength(0);
    await toggle.check();
    await expect.poll(ineligibleVisibleMeshes).not.toHaveLength(0);
    const visibleMeshes = await ineligibleVisibleMeshes();
    expect(visibleMeshes.every(mesh => mesh.vertices > 0 && mesh.opacity < 1)).toBe(true);
    await toggle.uncheck();
    await expect.poll(ineligibleVisibleMeshes).toHaveLength(0);
  });

  test('Block GeoJSON upload opens a Freeform footprint and saves it exactly', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await resolveParcelScopePrompt(page, page.locator('#btn-blockify-done'), false);
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    const uploaded = {
      type: 'Feature', properties: { name: 'fixture manual footprint', height: 18 },
      geometry: { type: 'Polygon', coordinates: [[[15.9820,45.80010],[15.98235,45.80010],[15.98235,45.80030],[15.9820,45.80030],[15.9820,45.80010]]] },
    };
    await page.locator('#blockify-geojson-input').setInputFiles({
      name: 'building.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²');
    await page.locator('#single-building-confirm').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.applied && p.goal === 'single' && p.geometry?.buildings?.[0]?.properties?.name === 'fixture manual footprint'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.goal === 'single' && p.geometry?.buildings?.[0]?.properties?.name === 'fixture manual footprint'));
    expect(saved.geometry.buildings).toHaveLength(1);
    expect(saved.geometry.buildings[0].geometry).toEqual(uploaded.geometry);
  });

  test('existing-building mode uses loaded footprints and saves the additional-floor rule', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(id => (window as any).CadastralParcelRepository.ensureIds([id]), BLOCK_PARCEL_IDS[3]);
    await openParcel(page, 'proposals', BLOCK_PARCEL_IDS[3]);
    await page.locator('.parcel-build-btn--buildings').click();
    await resolveParcelScopePrompt(page, page.locator('#btn-blockify-done'), false);
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#blockify-existing-toggle').check();
    await expect.poll(() => page.locator('#additional-floors-slider').isEnabled()).toBe(true);
    await expect(page.locator('#proposed-height-slider')).toBeVisible();

    await page.locator('#blockify-rule-additional').check();
    const floors = page.locator('#additional-floors-slider');
    const original = Number(await floors.inputValue());
    await floors.focus();
    await floors.press('ArrowRight');
    expect(Number(await floors.inputValue())).toBe(original + 1);
    await page.locator('#floor-height-slider').focus();
    await page.locator('#floor-height-slider').press('ArrowRight');
    const floorHeight = Number(await page.locator('#floor-height-slider').inputValue());
    await page.locator('#btn-blockify-done').click();

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.mode === 'existing'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.mode === 'existing'));
    expect(saved.buildingProposal.parameters).toMatchObject({ mode: 'existing', rule: 'additional', additionalFloors: original + 1, floorHeightM: floorHeight });
    expect(saved.geometry.buildings.length).toBeGreaterThan(0);
    expect(saved.geometry.buildings.every((building: any) => Number(building.properties.height) > 12)).toBe(true);
    await expect.poll(() => page.evaluate(id => (window as any).proposedBuildings
      .some((feature: any) => feature.properties?.proposalId === id), saved.proposalId)).toBe(true);
  });

  test('single-building palette controls save height, surroundings, and parcel treatment', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    const wholeBlockPrompt = page.getByRole('alertdialog');
    if (await wholeBlockPrompt.isVisible().catch(() => false)) {
      await wholeBlockPrompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#single-building-editor').locator('.on-map-editor__panel')).toBeVisible();
    const height = page.locator('#single-height-slider');
    const oldHeight = Number(await height.inputValue());
    await height.focus();
    await height.press('ArrowRight');
    // A rotation is disabled when the footprint cannot rotate inside the selected parcel.
    // This fixture's initial placement is constrained, so exercise the supported height and
    // surface controls without bypassing that real geometry gate.
    await selectNativeOption(page.locator('#single-ground-treatment'), 'green');
    const parcelTake = page.locator('#single-land-take [data-parcel-id]').first();
    await selectNativeOption(parcelTake, 'whole');
    await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²');
    await page.locator('#single-building-confirm').click();
    await expect(page.locator('#single-building-editor')).toHaveCount(0);

    const context = await page.evaluate(() => (window as any).pendingBuildingProposalContext);
    expect(context.parameters.height).toBe(oldHeight + 1);
    expect(context.buildings).toHaveLength(1);
    expect(context.groundSurface.treatment).toBe('green');
    expect(context.landTake?.geometry).toBeTruthy();
    expect(context.landTake.geometry.coordinates).toEqual([[[15.9819,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9819,45.8005],[15.9819,45.8]]]);
    expect(context.buildings.every((feature: any) => feature.geometry?.type === 'Polygon')).toBe(true);
  });

  test('row-house controls save a varied-height rule for the selected parcel block', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await closeParcel(page);
    await showSelectionDesignTab(page);
    await page.locator('.parcel-build-btn--row').click();
    await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });

    await selectNativeOption(page.locator('#rowhouse-ruletype-select'), 'range');
    await expect(page.locator('#rowhouse-minheight-group')).toBeVisible();
    const minimum = page.locator('#rowhouse-minheight-slider');
    await minimum.focus();
    await minimum.press('ArrowRight');
    const minimumHeight = Number(await minimum.inputValue());
    const rotationBefore = 0;
    await page.locator('#rowhouse-rotate-clockwise').click();
    await page.locator('#btn-rowhouse-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();

    await expect(page.locator('#rowhouse')).toHaveCount(0);
    const context = await page.evaluate(() => (window as any).pendingBuildingProposalContext);
    expect(context.parcelIds.length).toBeGreaterThan(1);
    expect(context.parameters.typology).toBe('row');
    expect(context.parameters.rule.kind).toBe('range');
    expect(context.parameters.rule.minHeightM).toBe(minimumHeight);
    expect(Number(context.parameters.rotation)).toBeCloseTo(rotationBefore - 5 * Math.PI / 180, 5);
    expect(context.buildings.length).toBeGreaterThan(0);
    expect(context.buildings.every((feature: any) => feature.geometry?.type === 'Polygon')).toBe(true);
  });

  test('road cross-section preset, lane ordering, width, direction and planting reach the applied corridor', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await clickMapPoint(page, 15.98195, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    await page.locator('#editRoadCrossSectionButton').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

    const preset = editor.locator('.corridor-editor-preset-select');
    await selectNativeOption(preset, '18');
    const initialRows = await editor.locator('.corridor-lane-row').count();
    await editor.locator('.corridor-editor-add-lane .cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="verge"]').click();
    await expect(editor.locator('.corridor-lane-row')).toHaveCount(initialRows + 1);

    let verge = editor.locator('.corridor-lane-type').filter({ has: page.locator('option[value="verge"]:checked') }).first();
    await expect(verge).toHaveValue('verge');
    const vergeIndex = await verge.getAttribute('data-lane-index');
    const vergeRow = editor.locator(`.corridor-lane-row[data-lane-index="${vergeIndex}"]`);
    await selectNativeOption(vergeRow.locator('.corridor-lane-landscape'), 'trees');
    const width = vergeRow.locator('.corridor-lane-width');
    const oldWidth = Number(await width.inputValue());
    await width.fill(String(oldWidth + 0.5));
    await width.press('Tab');
    await expect(width).toHaveValue(String(oldWidth + 0.5));
    await vergeRow.locator('[data-move-up]').click();

    const parkingRow = editor.locator('.corridor-lane-row:has(select.corridor-lane-type option[value="parking"]:checked)').first();
    await parkingRow.locator('.corridor-lane-tree-every').fill('2');
    await parkingRow.locator('.corridor-lane-tree-every').press('Tab');
    const directionalRow = editor.locator('.corridor-lane-row:has([data-direction-index])').first();
    await directionalRow.locator('[data-direction-index]').click();
    await editor.locator('.corridor-editor-save').click();
    await page.locator('#finishRoadButton').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.roadProposal))).toBe(true);
    const definition = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.roadProposal).roadProposal.definition);
    expect(definition.profile.strips.some((lane: any) => lane.type === 'verge' && lane.landscape === 'trees' && lane.width >= 1)).toBe(true);
    expect(definition.profile.strips.some((lane: any) => lane.type === 'parking' && lane.treeEvery === 2)).toBe(true);
    expect(definition.profile.strips.some((lane: any) => lane.type === 'driving' && lane.direction === 'backward')).toBe(true);
    expect(definition.profile.strips[0]).toBeTruthy();
    expect(definition.polygon.coordinates[0].length).toBeGreaterThan(3);
  });

  test('track gauge selection changes the authored width and persists with the finished track', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--track').click();
    await page.locator('.track-speed-option[data-speed="250"]').click();
    await clickMapPoint(page, 15.98195, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8005);
    await page.locator('#editRoadCrossSectionButton').click();
    const editor = page.locator('#corridor-editor-overlay');
    const rail = editor.locator('.corridor-lane-row:has(.corridor-lane-gauge)').first();
    await expect(rail.locator('.corridor-lane-gauge')).toHaveValue('1435');
    const widthBefore = Number(await rail.locator('.corridor-lane-width').inputValue());
    await selectNativeOption(rail.locator('.corridor-lane-gauge'), '1000');
    await expect(rail.locator('.corridor-lane-width')).not.toHaveValue(String(widthBefore));
    await editor.locator('.corridor-editor-save').click();
    await page.locator('#finishRoadButton').click();
    const warning = page.getByRole('alertdialog');
    await expect(warning).toContainText('5,000 m target for 250 km/h');
    await expect(warning).toContainText('not an engineering assessment');
    await warning.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.roadProposal))).toBe(false);
    await page.locator('#finishRoadButton').click();
    await warning.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.roadProposal))).toBe(true);

    const track = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.roadProposal).roadProposal.definition);
    expect(track.profile.strips.some((lane: any) => lane.type === 'rail' && Number(lane.gauge) === 1000)).toBe(true);
    expect(track.metadata.trackSpeed).toBe(250);
    expect(track.metadata.trackMinRadius).toBe(5000);
  });

  test('parcel-layout starting layouts, old/new tabs and commit reflect actual edits', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await openParcel(page, 'proposals', BLOCK_PARCEL_IDS[0]);
    await page.locator('.parcel-build-btn--parcel-layout').click();
    const modal = page.locator('.on-map-reparcellization');
    const scopePrompt = page.getByRole('alertdialog');
    await expect.poll(async () => (await modal.isVisible()) || (await scopePrompt.isVisible())).toBe(true);
    if (await scopePrompt.isVisible()) {
      await scopePrompt.getByRole('button', { name: 'Yes, select the block' }).click();
      await expect(parcelTab(page, 'propose-tab')).toBeVisible();
      await showSelectionDesignTab(page);
      await page.locator('.parcel-build-btn--parcel-layout').click();
    }
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('[data-reparcel-plots-tab="old"]').click();
    await expect(modal.locator('[data-reparcel-oldplots-table]')).toContainText('1234');
    await modal.locator('[data-reparcel-plots-tab="new"]').click();
    await expect(modal.locator('[data-reparcel-newplots-table]')).not.toBeEmpty();
    const plotRows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
    const plotCount = await plotRows.count();
    expect(plotCount).toBeGreaterThanOrEqual(2);
    const equalPlots = ((await modal.locator('[data-reparcel-newplots-table]').textContent()) || '').replace(/\s+/g, ' ').trim();

    // Draw freely starts from the current plots, not from a blank plot.
    await modal.locator('label.reparcel-alg-option:has(input[value="manual"])').click();
    await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('.reparcel-subtitle')).toContainText('Draw freely');
    await expect(modal.locator('[data-reparcel-newplots-table]')).toHaveText(equalPlots);
    await modal.locator('label.reparcel-alg-option:has(input[value="equal"])').click();
    await expect(modal.locator('.reparcel-subtitle')).toContainText('Equal plots');
    await expect(plotRows).toHaveCount(plotCount);

    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout')?.parcelLayout);
    expect(saved.algorithm).toBe('equal');
    expect(saved.plotCount).toBe(plotCount);
    expect(saved.plots).toHaveLength(plotCount);
  });

  test('a drawn parcel layout takes a split, a node edit, a comparison and a GeoJSON import', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcel-layout').click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('label.reparcel-alg-option:has(input[value="manual"])').click();
    await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');

    const rows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
    const beforeSplit = await rows.count();
    await modal.locator('[data-reparcel-line]').click();
    const map = page.locator('#map-container');
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeVisible();
    const box = await map.boundingBox();
    if (!box) throw new Error('Parcel-layout map has no visible bounds');
    const [start, end] = await visibleCutLineEndpoints(page);
    await page.mouse.click(start.x, start.y);
    await page.mouse.click(end.x, end.y);
    await expect(modal.locator('[data-reparcel-finish]')).toBeEnabled();
    await modal.locator('[data-reparcel-finish]').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(beforeSplit);

    const movableNode = page.locator('.reparcel-node-handle:not(.geom-handle--locked)').first();
    await expect(movableNode).toBeVisible();
    const beforeEdit = await modal.locator('[data-reparcel-newplots-table]').innerText();
    const nodeBox = await movableNode.boundingBox();
    if (!nodeBox) throw new Error('Parcel-layout node handle has no visible bounds');
    await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 14, nodeBox.y + nodeBox.height / 2 + 3, { steps: 4 });
    await page.mouse.up();
    await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
    await expect.poll(() => modal.locator('[data-reparcel-newplots-table]').innerText()).not.toBe(beforeEdit);
    await modal.locator('[data-reparcel-undo-edit]').click();
    await expect.poll(() => modal.locator('[data-reparcel-newplots-table]').innerText()).toBe(beforeEdit);

    const beforeAfter = modal.locator('[data-reparcel-compare]');
    await beforeAfter.click();
    await expect(map.locator('.map-compare__before')).toBeVisible();
    await expect(map.locator('.map-compare__label--before')).toContainText('Before');
    await expect(map.locator('.map-compare__label--after')).toContainText('After');
    await beforeAfter.click();
    await expect(map.locator('.map-compare__before')).toHaveCount(0);

    const uploaded = {
      type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { label: 'west plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9819,45.8000],[15.9822,45.8000],[15.9822,45.8005],[15.9819,45.8005],[15.9819,45.8000]]] } },
        { type: 'Feature', properties: { label: 'east plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9822,45.8000],[15.9825,45.8000],[15.9825,45.8005],[15.9822,45.8005],[15.9822,45.8000]]] } },
      ],
    };
    await modal.locator('[data-reparcel-upload]').setInputFiles({
      name: 'plots.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    await expect(modal.locator('[data-reparcel-status]')).toContainText(/Loaded 2 polygons/);
    await expect(rows).toHaveCount(2);

    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout')?.parcelLayout);
    expect(saved.algorithm).toBe('manual');
    expect(saved.plots).toHaveLength(2);
    expect(saved.plots.every((plot: any) => plot.geometry?.type === 'Polygon' && plot.source === 'geojson')).toBe(true);
  });
});
