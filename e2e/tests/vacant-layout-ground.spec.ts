import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, stubBasemapTiles, clickMapPoint, expandStackSection } from '../helpers/runtime';

test('empty layout plots have wild ground and fences, replaced when a park occupies a plot', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const editor = page.locator('.on-map-reparcellization');
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled();
  await editor.locator('[data-reparcel-commit]').click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.vacant-layout-plot')).toHaveCount(2);
  const point = await page.evaluate(() => {
    const w = window as any;
    return w.turf.centerOfMass(w.vacantLayoutPlots()[0]).geometry.coordinates;
  });

  const fences = () => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals?.()?.scene?.traverse((object: any) => {
      if (object.userData?.isVacantPlotFence) count++;
    });
    return count;
  });
  await page.keyboard.press('Escape');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await expect.poll(fences).toBe(2);
  expect(await page.evaluate(() => {
    const view = (window as any).getThreeModeInternals();
    view.renderer.compile(view.scene, view.camera);
    return view.renderer.info.programs.filter((program: any) => program.diagnostics?.runnable === false)
      .map((program: any) => program.diagnostics.fragmentShader.log);
  })).toEqual([]);
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeHidden();
  await clickMapPoint(page, point[0], point[1]);
  await expandStackSection(page, 'formed');
  await page.locator('.parcel-build-btn--park').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'No, just this parcel' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.structureProposal?.kind === 'park')), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.vacant-layout-plot')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('#mode-3d-toggle').click();
  await expect.poll(fences).toBe(1);
});
