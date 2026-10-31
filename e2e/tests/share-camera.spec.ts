import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';

const camera = { targetLat: 45.80025, targetLng: 15.9822, headingDeg: 40, pitchRad: -0.6, range: 300 };
const cameraParam = Object.values(camera).join(',');

for (const mode of ['model', 'photo'] as const) {
  test(`${mode} plan creation saves camera and rotation choices; sharing cannot edit them`, async ({ mockApi: page }, testInfo) => {
    test.setTimeout(90_000);
    await mockBuildingScene(page);
    if (mode === 'photo') await mockPhotoTiles(page);
    await openCity(page);
    const id = await createSpace(page, 'park');
    const content = await page.evaluate(id => (window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)), id);
    const index = pageIndex(page), cid = fileDesign(index, content);
    const modeToggle = page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-realistic-toggle');
    await modeToggle.click();
    await expect(modeToggle).not.toHaveClass(/mode-btn-loading/, { timeout: 20_000 });
    await expect(page.locator('#three-container canvas')).toBeVisible();
    if (mode === 'photo') await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
    await page.evaluate(view => (window as any).applyThree3DGeoView(view), camera);
    const captured = await page.evaluate(() => (window as any).getThree3DGeoView());
    // The command palette remains available when 3D hides the bottom navigation.
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.command-palette__input').fill('Lists');
    await page.locator('.command-palette__item').filter({ hasText: /^Lists/ }).first().click();
    await page.locator('#shareAppliedProposalsButton').click();
    // Create plan ticks the designs in Lists → Designs; Continue opens the composer listing them.
    await page.locator('#lists-actions').getByRole('button', { name: 'Create plan', exact: true }).click();
    await page.locator(`#proposal-list-host .lists-item[data-list-id="${id}"] input[type=checkbox]`).check();
    await page.locator('#lists-actions [data-lists-continue]').click();
    const composer = page.locator('.plan-composer');
    await expect(composer.locator('.plan-dialog__members li')).toHaveCount(1);
    await composer.getByLabel('Plan name', { exact: true }).fill('Camera view');
    const includeCamera = composer.locator('[data-plan-view="camera"]');
    const rotate = composer.locator('[data-plan-view="rotate"]');
    await expect(includeCamera).toBeChecked();
    await expect(rotate).not.toBeChecked();
    await includeCamera.uncheck();
    await rotate.check();
    // View options are part of creation. They cannot publish a draft or create a public link.
    expect(index.requests.filter(r => r.method === 'POST' && ['/pins', '/designs', '/plans'].includes(r.path))).toHaveLength(0);
    await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
    const planSection = page.locator('#three-click-stack .click-stack__section[data-kind="plans"]');
    await expect(planSection.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    let saved = await page.evaluate(() => (window as any).PlanWorkspace.list().find((p: any) => p.content.title === 'Camera view'));
    expect(saved.content.view).toMatchObject({ mode, rotate: true, camera: null });
    // A new composition can also retain the original captured camera.
    await page.keyboard.press('Escape');
    // Ticking designs in Lists framed them on the map; return to the original camera first.
    await page.evaluate(view => (window as any).applyThree3DGeoView(view), camera);
    await page.evaluate(id => (window as any).PlanDialog.create({ members: [(window as any).proposalStorage.getProposal(id)] }), id);
    await composer.getByLabel('Plan name', { exact: true }).fill('Camera included');
    await composer.locator('[data-plan-view="rotate"]').check();
    await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
    await expect(planSection.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    saved = await page.evaluate(() => (window as any).PlanWorkspace.list().find((p: any) => p.content.title === 'Camera included'));
    expect(saved.content.view).toMatchObject({ mode, rotate: true });
    for (const key of Object.keys(camera)) expect(saved.content.view.camera[key]).toBeCloseTo(captured[key], 4);
    await planSection.getByRole('button', { name: 'Share plan', exact: true }).click();
    const share = page.locator('.plan-share');
    await expect(share.locator('[data-plan-view]')).toHaveCount(0);
    expect(index.requests.filter(r => r.method === 'POST' && ['/pins', '/designs', '/plans'].includes(r.path))).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath(`share-camera-${mode}.png`) });
  });
}

for (const [mode, action] of [['model', 'pointer'], ['model', 'wheel'], ['photo', 'key']] as const) {
  test(`${mode} arrival rotates the saved camera and stops on ${action}`, async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await mockBuildingScene(page);
    let releaseTiles: (() => void) | undefined;
    if (mode === 'photo') {
      await mockPhotoTiles(page);
      const gate = new Promise<void>(resolve => { releaseTiles = resolve; });
      await page.route('https://tiles.example.test/fixture.gltf**', async route => { await gate; await route.fallback(); });
    }
    await page.goto(`/?city=zg&at=45.80025,15.9822,18&${mode === 'model' ? '3d' : 'photo'}&camera=${cameraParam}&rotate=1`);
    if (mode === 'photo') {
      await expect.poll(() => page.evaluate(() => (window as any).__mapModeState?.desired)).toBe('photo');
      // The canvas exists while held terrain loads, but is only revealed after grounding.
      await expect(page.locator('#three-container canvas')).toBeAttached({ timeout: 20_000 });
      await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals?.()?.controls?.autoRotate)).toBe(false);
      releaseTiles!();
      await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode?.getLoadDiagnostics().grounded), { timeout: 20_000 }).toBe(true);
    }
    await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals?.()?.controls?.autoRotate), { timeout: 15_000 }).toBe(true);
    const heading = () => page.evaluate(() => (window as any).getThree3DGeoView().headingDeg);
    const before = await heading();
    await expect.poll(async () => Math.abs(await heading() - before)).toBeGreaterThan(0.2);
    if (action === 'pointer') await page.locator('#three-container canvas').click({ position: { x: 100, y: 100 } });
    if (action === 'wheel') { await page.mouse.move(100, 100); await page.mouse.wheel(0, 40); }
    if (action === 'key') await page.keyboard.press('Shift');
    await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals().controls.autoRotate)).toBe(false);
    if (action === 'pointer') await expect(page.locator('#three-click-stack')).toBeHidden();
  });
}

test('input during Google terrain loading cancels the pending arrival rotation', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await mockPhotoTiles(page);
  let releaseTiles!: () => void;
  const gate = new Promise<void>(resolve => { releaseTiles = resolve; });
  await page.route('https://tiles.example.test/fixture.gltf**', async route => { await gate; await route.fallback(); });
  await page.goto(`/?city=zg&at=45.80025,15.9822,18&photo&camera=${cameraParam}&rotate=1`);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals()?.controls?.autoRotate)).toBe(false);
  await page.keyboard.press('Shift');
  releaseTiles();
  await expect.poll(() => page.evaluate(() => (window as any).PhotorealMode.getLoadDiagnostics().grounded), { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).getThreeModeInternals().controls.autoRotate)).toBe(false);
});

for (const flags of ['', '&rotate=0', '&rotate=1&reduceMotion=1']) {
  test(`arrival remains still with ${flags || 'no rotation option'}`, async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await page.goto(`/?city=zg&at=45.80025,15.9822,18&3d&camera=${cameraParam}${flags}`);
    await expect(page.locator('#three-container canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).getThreeModeInternals?.()?.controls?.autoRotate)).toBe(false);
    const pose = await page.evaluate(() => (window as any).getThree3DGeoView());
    expect(pose.targetLat).toBeCloseTo(camera.targetLat, 6);
    expect(pose.targetLng).toBeCloseTo(camera.targetLng, 6);
    // Geographic heading/range reconstruct through the existing spherical-to-Mercator adapter.
    expect(Math.abs(pose.headingDeg - camera.headingDeg)).toBeLessThan(0.01);
    expect(Math.abs(pose.pitchRad - camera.pitchRad)).toBeLessThan(0.001);
    expect(Math.abs(pose.range - camera.range)).toBeLessThan(0.5);
  });
}
