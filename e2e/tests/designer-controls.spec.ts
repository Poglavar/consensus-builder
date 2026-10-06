import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint } from '../helpers/runtime';
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

test.describe('Designer controls persist their edits @features', () => {
  test('parcel-based rule type and ranges change the generated design and saved proposal context', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcelBased').click();
    const modal = page.locator('#parcelbased-modal');
    await expect(modal).toBeVisible();
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
    await rule.selectOption('range');
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
    await rule.selectOption('exact');
    await expect(page.locator('#parcelbased-minimums')).toBeHidden();
    await rule.selectOption('max');
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
    await page.locator('#parcel-info-panel .close-button').click();
    await page.locator('#selection-tray [data-command="selection.propose"]').click();
    await page.locator('.parcel-build-btn--buildings').click();
    const wholeBlockPrompt = page.getByRole('alertdialog');
    if (await wholeBlockPrompt.isVisible().catch(() => false)) {
      await wholeBlockPrompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });

    const minPlot = page.locator('#blockify-minplot-slider');
    while (Number(await minPlot.inputValue()) < 100) await minPlot.press('ArrowRight');
    await expect(page.locator('#blockify-minplot-value')).toHaveText('100');
    await page.locator('#btn-blockify-done').click();

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((proposal: any) => proposal.applied && proposal.geometry?.buildings?.length))).toBe(true);
    const proposal = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((entry: any) => entry.applied && entry.geometry?.buildings?.length));
    expect(proposal.cadastreParcelIds).toEqual(expect.arrayContaining(BLOCK_PARCEL_IDS));
    const buildingParcelIds = await page.evaluate(([buildings, ids]) => {
      const turf = (window as any).turf;
      return (buildings as any[]).map(building => {
        const center = turf.centroid(building);
        return (ids as string[]).find(id => turf.booleanPointInPolygon(center, (window as any).CadastralParcelRepository.get(id))) || null;
      });
    }, [proposal.geometry.buildings, BLOCK_PARCEL_IDS]);
    expect(buildingParcelIds).toHaveLength(2);
    expect(buildingParcelIds).toContain(BLOCK_PARCEL_IDS[3]);
    expect(buildingParcelIds).toContain(BLOCK_PARCEL_IDS[4]);
    for (const id of BLOCK_PARCEL_IDS.slice(0, 3)) expect(buildingParcelIds).not.toContain(id);
    expect(proposal.buildingProposal.ineligibleParcels).toHaveLength(3);
    expect(proposal.buildingProposal.ineligibleParcels.every((entry: any) => entry.status === 'below-min-plot')).toBe(true);

    await page.locator('#mode-3d-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
    await page.locator('#three-mode-built-display').selectOption('off');
    await page.locator('#three-mode-planned-display').selectOption('off');
    const sceneMeshes = () => page.evaluate(() => {
      const meshes: any[] = [];
      (window as any).getThreeModeInternals().scene.traverse((object: any) => {
        if (!object.isMesh || !object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const opacity = Math.min(...materials.map((material: any) => material.userData?.cbBuildingOpacity ?? material.opacity ?? 1));
        meshes.push({ opacity, vertices: object.geometry?.attributes?.position?.count || 0 });
      });
      return meshes;
    });
    const toggle = page.locator('.three-mode-wide-toggle input');
    await expect(toggle).not.toBeChecked();
    const meshesWithoutExcludedParts = await sceneMeshes();
    await toggle.check();
    await expect.poll(async () => (await sceneMeshes()).length).toBeGreaterThan(meshesWithoutExcludedParts.length);
    const meshesWithExcludedParts = await sceneMeshes();
    expect(meshesWithExcludedParts.some((mesh: any) => mesh.opacity < 1 && mesh.vertices > 0)).toBe(true);
    await toggle.uncheck();
    await expect.poll(async () => (await sceneMeshes()).length).toBe(meshesWithoutExcludedParts.length);
  });

  test('manual building outline accepts a real GeoJSON upload and saves the uploaded footprint', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    const wholeParcelPrompt = page.getByRole('alertdialog');
    if (await wholeParcelPrompt.isVisible().catch(() => false)) {
      await wholeParcelPrompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#blockify-manual-toggle').click();
    await expect.poll(() => page.locator('#blockify-container .polygon-geometry-editor__vertex').count()).toBeGreaterThan(2);

    // Upload is the actual manual-mode file control; the editor clips this polygon to the selected parcel.
    const uploaded = {
      type: 'Feature', properties: { name: 'fixture manual footprint' },
      geometry: { type: 'Polygon', coordinates: [[[15.9820,45.80010],[15.98235,45.80010],[15.98235,45.80030],[15.9820,45.80030],[15.9820,45.80010]]] },
    };
    await page.locator('#blockify-geojson-input').setInputFiles({
      name: 'building.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    await expect.poll(() => page.locator('#blockify-container .polygon-geometry-editor__vertex').count()).toBeGreaterThan(2);
    await expect(page.locator('#blockify-manual-toggle')).toHaveClass(/active/);
    await page.locator('#btn-blockify-done').click();

    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.mode === 'manual'));
    expect(saved).toBeTruthy();
    expect(saved.buildingProposal.parameters.manualOuterRing.length).toBeGreaterThan(2);
    expect(saved.geometry.buildings).toHaveLength(1);
    expect(saved.geometry.buildings[0].geometry.type).toBe('Polygon');
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

  test('single-building palette controls save height, surroundings, parcel treatment, and added footprint', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    const wholeBlockPrompt = page.getByRole('alertdialog');
    if (await wholeBlockPrompt.isVisible().catch(() => false)) {
      await wholeBlockPrompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#single-building-modal')).toBeVisible();
    const selector = page.locator('#single-building-selector');
    const initialBuildings = await selector.locator('option').count();
    const height = page.locator('#single-height-slider');
    const oldHeight = Number(await height.inputValue());
    await height.focus();
    await height.press('ArrowRight');
    // A rotation is disabled when the footprint cannot rotate inside the selected parcel.
    // This fixture's initial placement is constrained, so exercise the supported height and
    // surface controls without bypassing that real geometry gate.
    await page.locator('#single-ground-treatment').selectOption('green');
    await page.locator('#single-parcel-mode').selectOption('whole');
    await page.locator('#single-building-add').click();
    await expect(selector.locator('option')).toHaveCount(initialBuildings + 1);
    await page.locator('#single-building-confirm').click();
    await expect(page.locator('#single-building-modal')).toHaveCount(0);

    const context = await page.evaluate(() => (window as any).pendingBuildingProposalContext);
    expect(context.parameters.height).toBe(oldHeight + 1);
    expect(context.buildings).toHaveLength(initialBuildings + 1);
    expect(context.groundSurface.treatment).toBe('green');
    expect(context.takeWholeParcels).toBe(true);
    expect(context.buildings.every((feature: any) => feature.geometry?.type === 'Polygon')).toBe(true);
  });

  test('row-house controls save a varied-height rule for the selected parcel block', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await page.locator('#parcel-info-panel .close-button').click();
    await page.locator('#selection-tray [data-command="selection.propose"]').click();
    await page.locator('.parcel-build-btn--row').click();
    await expect(page.locator('#rowhouse-modal')).toBeVisible();
    await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });

    await page.locator('#rowhouse-ruletype-select').selectOption('range');
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

    await expect(page.locator('#rowhouse-modal')).toHaveCount(0);
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
    await expect(editor).toBeVisible();

    const preset = editor.locator('.corridor-editor-preset-select');
    await preset.selectOption('18');
    const initialRows = await editor.locator('.corridor-lane-row').count();
    await editor.locator('.corridor-editor-add-lane .cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="verge"]').click();
    await expect(editor.locator('.corridor-lane-row')).toHaveCount(initialRows + 1);

    let verge = editor.locator('.corridor-lane-type').filter({ has: page.locator('option[value="verge"]:checked') }).first();
    await expect(verge).toHaveValue('verge');
    const vergeIndex = await verge.getAttribute('data-lane-index');
    const vergeRow = editor.locator(`.corridor-lane-row[data-lane-index="${vergeIndex}"]`);
    await vergeRow.locator('.corridor-lane-landscape').selectOption('trees');
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
    await page.locator('#track-speed-confirm-btn').click();
    await clickMapPoint(page, 15.98195, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    await page.locator('#editRoadCrossSectionButton').click();
    const editor = page.locator('#corridor-editor-overlay');
    const rail = editor.locator('.corridor-lane-row:has(.corridor-lane-gauge)').first();
    await expect(rail.locator('.corridor-lane-gauge')).toHaveValue('1435');
    const widthBefore = Number(await rail.locator('.corridor-lane-width').inputValue());
    await rail.locator('.corridor-lane-gauge').selectOption('1000');
    await expect(rail.locator('.corridor-lane-width')).not.toHaveValue(String(widthBefore));
    await editor.locator('.corridor-editor-save').click();
    await page.locator('#finishRoadButton').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.roadProposal))).toBe(true);

    const track = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.roadProposal).roadProposal.definition);
    expect(track.profile.strips.some((lane: any) => lane.type === 'rail' && Number(lane.gauge) === 1000)).toBe(true);
    expect(track.metadata.trackSpeed).toBeGreaterThan(0);
  });

  test('readjustment algorithm, ownership assignment, old/new tabs and commit reflect actual edits', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await openParcel(page, 'proposals', BLOCK_PARCEL_IDS[0]);
    await page.locator('.parcel-build-btn--reparcellization').click();
    const modal = page.locator('.reparcel-modal-overlay');
    const scopePrompt = page.getByRole('alertdialog');
    await expect.poll(async () => (await modal.isVisible()) || (await scopePrompt.isVisible())).toBe(true);
    if (await scopePrompt.isVisible()) {
      await scopePrompt.getByRole('button', { name: 'Yes, select the block' }).click();
      await expect(page.locator('#selection-tray [data-command="selection.propose"]')).toBeVisible();
      await page.locator('#selection-tray [data-command="selection.propose"]').click();
      await page.locator('.parcel-build-btn--reparcellization').click();
    }
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('[data-reparcel-plots-tab="old"]').click();
    await expect(modal.locator('[data-reparcel-oldplots-table]')).toContainText('1234');
    await modal.locator('[data-reparcel-plots-tab="new"]').click();
    await expect(modal.locator('[data-reparcel-newplots-table]')).not.toBeEmpty();

    await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check();
    await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('.reparcel-subtitle')).toContainText('Manual');
    await expect(modal.locator('[data-reparcel-newplots-table]')).toContainText('Unassigned');
    await modal.locator('input[name="reparcel-algorithm"][value="sweep-line"]').check();
    await expect(modal.locator('.reparcel-subtitle')).toContainText('Sweep');

    await modal.locator('[data-reparcel-assign]').click();
    await expect(modal.locator('[data-reparcel-assign]')).toHaveAttribute('aria-pressed', 'true');
    const plot = modal.locator('#reparcel-map .leaflet-overlay-pane path.leaflet-interactive').first();
    await plot.click();
    await expect(modal.locator('.reparcel-owner-popup')).toBeVisible();
    const publicOwner = modal.locator('.reparcel-owner-popup__row').filter({ hasText: /^Public land$/ });
    await expect(publicOwner).toBeVisible();
    await publicOwner.locator('input[type="checkbox"]').check();
    await modal.locator('.reparcel-owner-popup__close').click();
    await page.evaluate(() => (window as any).i18n.setLanguage('hr'));
    await plot.click();
    await expect(modal.locator('.reparcel-owner-popup')).toContainText('Javno zemljište');
    await expect(modal.locator('.reparcel-owner-popup')).not.toContainText('Public land');
    await modal.locator('.reparcel-owner-popup__close').click();
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));

    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toBeHidden();
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.applied && proposal.reparcellization)?.reparcellization);
    expect(saved.polygons.length).toBeGreaterThan(0);
    expect(saved.algorithm).toBe('sweep-line');
    expect(saved.polygons.some((plot: any) => plot.owners?.some((owner: any) => owner.ownerKey === 'public-land'))).toBe(true);
  });

  test('manual readjustment draws a split, edits a node, shuffles ownership, compares, and imports GeoJSON', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const modal = page.locator('.reparcel-modal-overlay');
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check();
    await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');

    const rows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
    const beforeSplit = await rows.count();
    await modal.locator('[data-reparcel-line]').click();
    const map = modal.locator('#reparcel-map');
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeVisible();
    const box = await map.boundingBox();
    if (!box) throw new Error('Readjustment map has no visible bounds');
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5);
    await expect(modal.locator('[data-reparcel-finish]')).toBeEnabled();
    await modal.locator('[data-reparcel-finish]').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(beforeSplit);

    const movableNode = modal.locator('.reparcel-node-handle:not(.geom-handle--locked)').first();
    await expect(movableNode).toBeVisible();
    const beforeEdit = await modal.locator('[data-reparcel-newplots-table]').innerText();
    const nodeBox = await movableNode.boundingBox();
    if (!nodeBox) throw new Error('Readjustment node handle has no visible bounds');
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
    await expect(map.locator('.reparcel-before-map')).toBeVisible();
    await expect(map.locator('.reparcel-compare-label--before')).toContainText('Before');
    await expect(map.locator('.reparcel-compare-label--after')).toContainText('After');
    await beforeAfter.click();
    await expect(map.locator('.reparcel-before-map')).toHaveCount(0);

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

    const ownershipBeforeShuffle = await rows.allInnerTexts();
    for (let attempt = 0; attempt < 20; attempt++) {
      await modal.locator('[data-reparcel-shuffle]').click();
      const current = await rows.allInnerTexts();
      if (JSON.stringify(current) !== JSON.stringify(ownershipBeforeShuffle)) break;
    }
    await expect.poll(async () => JSON.stringify(await rows.allInnerTexts())).not.toBe(JSON.stringify(ownershipBeforeShuffle));
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toBeHidden();
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.applied && proposal.reparcellization)?.reparcellization);
    expect(saved.algorithm).toBe('manual');
    expect(saved.polygons).toHaveLength(2);
    expect(saved.polygons.every((plot: any) => plot.geometry?.type === 'Polygon')).toBe(true);
  });
});
