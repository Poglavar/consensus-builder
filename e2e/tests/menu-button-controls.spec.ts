// Check contextual parcel and ground actions through the map's visible menus.
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('parcel menu Close dismisses the selected parcel and History opens its actual history card', async ({ mockApi: page }) => {
  await openCity(page);
  const menu = page.locator('#parcel-menu');
  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(menu).toBeVisible();
  await menu.locator('[data-parcel-menu-close]').click();
  await expect(menu).toBeHidden();
  await clickMapPoint(page, 15.9822, 45.80025);
  await menu.locator('[data-command="parcel.history"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  const history = page.locator('#parcel-info-panel [data-parcel-history]');
  await expect(history.first()).toBeVisible();
  await expect(history.first()).toHaveAttribute('open', '');
});

test('parcel menu Select more starts a selection containing the clicked parcel', async ({ mockApi: page }) => {
  await openCity(page);
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#parcel-menu [data-command="parcel.selectMore"]').click();
  await expect(page.locator('#parcel-menu')).toBeHidden();
  await expect(page.locator('#selection-tray')).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels])).toEqual([PARCEL_ID]);
});

test('parcel menu Detect block selects the connected cadastral block', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238']));
  await clickMapPoint(page, 15.9821, 45.800225);
  await page.locator('#parcel-menu [data-command="parcel.detectBlock"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(5);
  await expect(page.locator('#selection-tray')).toBeVisible();
});

test('selection tray Detect block expands its selected seed to the cadastral block', async ({ mockApi: page }) => {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238']));
  await clickMapPoint(page, 15.9821, 45.800225);
  await page.locator('#parcel-menu [data-command="parcel.selectMore"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(1);
  await page.locator('#selection-tray [data-command="blocks.fromSelected"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(5);
});

test('parcel menu Offer my land explains the ownership proof required from a guest', async ({ mockApi: page }) => {
  await openCity(page);
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#parcel-menu [data-command="parcel.offer"]').click();
  const notice = page.locator('#ephemeral-message-container .ephemeral-message');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Offering your land needs proof that it is yours: connect your Solana wallet');
  await expect(page.locator('.create-proposal-modal:visible')).toHaveCount(0);
});

test('global 3D mode opens from a selected parcel and retains parcel picking and isolation', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await page.evaluate(({ id, geometry }) => (window as any).proposalStorage.addProposal({
    title: '3D parcel proposal', goal: 'decide-later', kind: 'owner-deal', lifecycleStatus: 'Active',
    cadastreParcelIds: [id], geometry, applied: false,
  }), { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
  await expect(page.locator('#parcel-menu')).toBeHidden();
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
  await page.locator('.three-mode-parcel-panel [data-role="show-proposal"]').click();
  await expect(page.locator('.three-mode-parcel-panel .parcel-panel-proposal-name')).toHaveText('3D parcel proposal');
  await expect(page.locator('.three-mode-isolation-banner')).toContainText('Proposal view');
  await expect.poll(() => page.evaluate(() => (window as any).getThreeSceneSummary().isolatedProposal)).toBe(true);
});

test('parcel menu Compare opens both proposals and Details follows the chosen side', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(({ id, geometry }) => {
    for (const title of ['Unapplied park option', 'Unapplied square option']) (window as any).proposalStorage.addProposal({
      title, goal: 'decide-later', kind: 'owner-deal', lifecycleStatus: 'Active', geometry, cadastreParcelIds: [id], applied: false,
    });
  }, { id: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#parcel-menu [data-command="parcel.compare"]').click();
  const comparison = page.locator('#parcel-compare-dialog');
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText('Unapplied park option');
  await expect(comparison).toContainText('Unapplied square option');
  await comparison.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(comparison).toBeHidden();
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#parcel-menu [data-command="parcel.compare"]').click();
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

test('ground menu Close dismisses its actions', async ({ mockApi: page }) => {
  await openCity(page);
  await clickMapPoint(page, 15.98255, 45.80025);
  const menu = page.locator('#ground-menu');
  await expect(menu).toBeVisible();
  await menu.locator('[data-ground-menu-close]').click();
  await expect(menu).toBeHidden();
});

for (const kind of ['road', 'tramStation', 'undergroundStation', 'elevatedStation']) {
  test(`ground menu ${kind} starts its real editor`, async ({ mockApi: page }) => {
    await openCity(page);
    await clickMapPoint(page, 15.98255, 45.80025);
    await page.locator(`#ground-menu [data-command="ground.${kind}"]`).click();
    await expect(page.locator('#ground-menu')).toBeHidden();
    if (kind === 'road') {
      await expect(page.locator('#road-drawing-controls')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
    } else {
      await expect(page.locator('#station-placement-toolbar')).toBeVisible();
      await expect(page.locator('#station-placement-status')).toContainText(kind === 'tramStation' ? /tram/i : kind === 'undergroundStation' ? /metro|underground/i : /elevated/i);
      await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    }
  });
}
