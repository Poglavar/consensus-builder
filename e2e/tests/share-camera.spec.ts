import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';

const camera = { targetLat: 45.80025, targetLng: 15.9822, headingDeg: 40, pitchRad: -0.6, range: 300 };
const cameraParam = Object.values(camera).join(',');

for (const mode of ['model', 'photo'] as const) {
  test(`${mode} sharing offers camera and rotation choices and saves them in a named plan`, async ({ mockApi: page }, testInfo) => {
    await mockBuildingScene(page);
    if (mode === 'photo') await mockPhotoTiles(page);
    await openCity(page);
    const id = await createSpace(page, 'park');
    const content = await page.evaluate(id => (window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)), id);
    const index = pageIndex(page), cid = fileDesign(index, content);
    await page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-realistic-toggle').click();
    await expect(page.locator('#three-container canvas')).toBeVisible();
    if (mode === 'photo') await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
    await page.evaluate(view => (window as any).applyThree3DGeoView(view), camera);
    const captured = await page.evaluate(() => (window as any).getThree3DGeoView());
    // The command palette remains available when 3D hides the bottom navigation.
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.command-palette__input').fill('Open Designs');
    await page.locator('.command-palette__item').filter({ hasText: 'Open Designs' }).click();
    await page.locator('#shareAppliedProposalsButton').click();
    await expect(page.locator('.share-plan-link')).toBeHidden();
    await expect(page.locator('.share-plan-publish-selected')).toBeVisible();
    // Merely choosing view options cannot publish a draft or turn it into a share link.
    await page.locator('#share-rotate').check();
    await expect(page.locator('.share-plan-link')).toBeHidden();
    expect(index.requests.filter(r => r.method === 'POST' && ['/pins', '/designs'].includes(r.path))).toHaveLength(0);
    await page.locator('#proposals-sheet [data-sheet-close]').click();
    await page.evaluate(({ id, cid }) => { const w = window as any;
      w.DesignSync.markPublished(w.proposalStorage.getProposal(id), { cid, apiBase: w.resolveBackendBaseUrl() });
    }, { id, cid });
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.command-palette__input').fill('Open Designs');
    await page.locator('.command-palette__item').filter({ hasText: 'Open Designs' }).click();
    await page.locator('#shareAppliedProposalsButton').click();
    const link = page.locator('.share-plan-link__input[readonly]');
    await expect(link).toBeVisible();
    let url = new URL(await link.inputValue());
    expect(url.searchParams.has('draft')).toBe(false);
    expect(url.searchParams.get('rotate')).toBe('0');
    const pose = await page.evaluate(value => (window as any).MapShare.readCamera(value), url.searchParams.get('camera'));
    for (const key of Object.keys(camera)) expect(pose[key]).toBeCloseTo(captured[key], 4);
    await page.locator('#share-include-camera').uncheck();
    expect(new URL(await link.inputValue()).searchParams.has('camera')).toBe(false);
    await page.locator('#share-rotate').check();
    url = new URL(await link.inputValue());
    expect(url.searchParams.get('rotate')).toBe('1');
    expect(url.searchParams.has('camera')).toBe(false);
    await page.locator('#share-include-camera').check();
    await page.getByRole('button', { name: 'Name this plan', exact: true }).click();
    await page.getByLabel('Plan name', { exact: true }).fill('Camera view');
    await page.getByRole('button', { name: 'Save plan link', exact: true }).click();
    await expect(link).toHaveValue(/\/plans\/bafkrei[a-z2-7]{52}$/);
    const saved = index.plans.get(new URL(await link.inputValue()).pathname.split('/').pop()!)!;
    expect(saved.content.view).toMatchObject({ mode, rotate: true });
    for (const key of Object.keys(camera)) expect(saved.content.view.camera[key]).toBeCloseTo(captured[key], 4);
    await expect(page.locator('#share-rotate')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`share-camera-${mode}.png`) });
  });
}

for (const [mode, action] of [['model', 'pointer'], ['model', 'wheel'], ['photo', 'key']] as const) {
  test(`${mode} arrival rotates the saved camera and stops on ${action}`, async ({ mockApi: page }) => {
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
