// Check contextual parcel and ground actions through the map's visible menus.
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, PARCEL_ID, PARCEL_GEOMETRY, runParcelCommand, openParcelAt, selectionSection } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('Escape dismisses the parcel and History opens its actual history card', async ({ mockApi: page }) => {
  await openCity(page);
  const stack = page.locator('#click-stack');
  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(stack).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stack).toBeHidden();
  await expect(page.locator('#parcel-info-panel')).toBeHidden();
  // Elsewhere on the same parcel: one physical click at one point is counted once.
  await openParcelAt(page, 15.9821, 45.8002);
  await page.locator('#parcel-info-panel [data-parcel-tab-id="info-tab"]').click();
  // The History section sits collapsed at the end of the Info tab; opening it fetches the history.
  const history = page.locator('#parcel-info-panel [data-parcel-history]');
  await expect(history.first()).toBeVisible();
  await history.first().locator('summary').click();
  await expect(history.first()).toHaveAttribute('open', '');
});

test('parcel panel Select multiple starts a selection containing the clicked parcel', async ({ mockApi: page }) => {
  await openCity(page);
  await openParcelAt(page, 15.9822, 45.80025);
  await page.locator('#parcel-manual-selection').click();
  await expect(selectionSection(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels])).toEqual([PARCEL_ID]);
});

test('parcel panel Detect block selects the connected cadastral block', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238']));
  await openParcelAt(page, 15.9821, 45.800225);
  await page.locator('#parcel-info-panel .multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(5);
  await expect(selectionSection(page)).toBeVisible();
});

test('selection section Detect block expands its selected seed to the cadastral block', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238']));
  await openParcelAt(page, 15.9821, 45.800225);
  await page.locator('#parcel-manual-selection').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(1);
  await selectionSection(page).locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(5);
});

test('global 3D mode keeps the selected parcel while inspecting its unapplied design', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await page.evaluate(({ id, geometry }) => (window as any).proposalStorage.addProposal({
    title: '3D parcel proposal', goal: 'park', lifecycleStatus: 'Active',
    cadastreParcelIds: [id], geometry, structureProposal: { kind: 'park', geometry }, applied: false,
  }), { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
  await expect(page.locator('#click-stack')).toBeHidden();
  await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.80025))).toBeLessThan(0.0001);
  const point = await page.evaluate(id => {
    const w = window as any;
    const { scene, camera, renderer } = w.getThreeModeInternals();
    let mesh: any;
    scene.traverse((object: any) => { if (object.isMesh && object.userData?.isParcel === true && object.userData?.parcelId === id) mesh = object; });
    if (!mesh) throw new Error('Selected parcel mesh is missing');
    mesh.geometry.computeBoundingBox();
    // The center overlaps the fixture building roof, so ray picking selects that source instead
    // of the parcel. Pick an interior corner away from the building footprint.
    const bounds = mesh.geometry.boundingBox;
    const point = bounds.min.clone().add(bounds.getSize(new w.THREE.Vector3()).multiply(new w.THREE.Vector3(0.88, 0.88, 0.5)));
    mesh.localToWorld(point); point.project(camera);
    const box = renderer.domElement.getBoundingClientRect();
    return { x: box.left + (point.x + 1) * box.width / 2, y: box.top + (1 - point.y) * box.height / 2 };
  }, PARCEL_ID);
  await page.mouse.click(point.x, point.y);
  // The click stack keeps the selected parcel context while its Design row opens the design view.
  const design = page.locator('#three-click-stack .click-stack__section[data-kind="designs"]');
  await expect(design.locator('.click-stack__row-detail')).toHaveText('3D parcel proposal');
  await design.locator('[data-action="row"]').click();
  await expect(design.locator('.three-mode-parcel-panel')).toBeVisible();
  await expect(page.locator('.three-mode-isolation-banner')).toContainText('Selected parcel');
  await expect.poll(() => page.evaluate(() => (window as any).getThreeSceneSummary().isolatedProposal)).toBe(false);
  await expect.poll(() => page.evaluate(() => Math.abs((window as any).map.getCenter().lat - 45.80025))).toBeLessThan(0.0001);
});

test('parcel section Compare opens both proposals and Details follows the chosen side', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(({ id, geometry }) => {
    for (const title of ['Unapplied park option', 'Unapplied square option']) (window as any).proposalStorage.addProposal({
      title, goal: 'park', lifecycleStatus: 'Active', geometry, structureProposal: { kind: 'park', geometry }, cadastreParcelIds: [id], applied: false,
    });
  }, { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await runParcelCommand(page, 15.9822, 45.80025, 'parcel.compare');
  const comparison = page.locator('#parcel-compare-dialog');
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText('Unapplied park option');
  await expect(comparison).toContainText('Unapplied square option');
  await comparison.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(comparison).toBeHidden();
  await runParcelCommand(page, 15.9822, 45.80025, 'parcel.compare');
  await expect(comparison).toBeVisible();
  const selected = await comparison.locator('.parcel-compare__picker--b select').inputValue();
  const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).title, selected);
  await comparison.locator('.parcel-compare__picker--b .parcel-compare__details').click();
  await expect(comparison).toBeHidden();
  const inspector = page.locator('#planning-inspector');
  const details = page.locator('#proposal-details-panel');
  await expect.poll(async () => await inspector.isVisible() || await details.isVisible()).toBe(true);
  if (await inspector.isVisible()) {
    await expect.poll(() => page.evaluate(() => (window as any).PlanningViews?.getSelected()?.proposalId)).toBe(selected);
    await expect(inspector).toContainText(title || '');
  } else {
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(selected);
    await expect(details).toContainText(title || '');
  }
});

test('Escape dismisses the bare-ground section', async ({ mockApi: page }) => {
  await openCity(page);
  await clickMapPoint(page, 15.98255, 45.80025);
  const stack = page.locator('#click-stack');
  await expect(stack.locator('.click-stack__section[data-kind="ground"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stack).toBeHidden();
});

// Stations are two ground actions (1f2fae6e1): Road station places a bus stop, Track station asks
// for the level (ground, elevated, underground) first.
for (const kind of ['road', 'roadStation', 'tram', 'underground', 'elevated']) {
  test(`ground section ${kind} starts its real editor`, async ({ mockApi: page }) => {
    await openCity(page);
    await clickMapPoint(page, 15.98255, 45.80025);
    const command = kind === 'road' || kind === 'roadStation' ? kind : 'trackStation';
    await page.locator(`#click-stack [data-command="ground.${command}"]`).click();
    if (command === 'trackStation') {
      // The stack stays behind the level chooser; placement closes it.
      const chooser = page.getByRole('dialog', { name: 'Track station', exact: true });
      await chooser.locator(`[data-station-level="${kind}"]`).click();
      await expect(chooser).toBeHidden();
    }
    await expect(page.locator('#click-stack')).toBeHidden();
    if (kind === 'road') {
      await expect(page.locator('#road-drawing-controls')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
    } else {
      await expect(page.locator('#station-placement-toolbar')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
      // The carried station is the chosen type: its preview shows that type's icon.
      const box = (await page.locator('#map').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const type = kind === 'roadStation' ? 'bus' : kind;
      const icon = await page.evaluate(type => (window as any).TransitStationModels.specFor(type).icon, type);
      await expect(page.locator('.transit-station-marker--preview span')).toHaveText(icon);
    }
  });
}
