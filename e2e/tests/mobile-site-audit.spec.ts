import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, openParcel, createSpace, runParcelCommand } from '../helpers/runtime';
import { applyLayout, createFromPlan, editorSave, openStackAgreement } from '../helpers/agreements';
import { installAreaMonitorSpaFallback } from '../helpers/mocks/area-monitor-server';
import { waitForMapReady } from '../helpers/app';
import { openWalletModal } from '../helpers/blockchain';

async function dragHandle(page: any, surface: any, deltaY: number) {
  const box = await surface.locator(':scope > .mobile-dock-sheet-handle').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + deltaY, { steps: 10 });
  await page.mouse.up();
}

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }]) {
  test(`primary mobile sheets resize, scroll and dismiss consistently at ${viewport.width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize(viewport);
    await openCity(page);
    for (const [button, id] of [['layers-button', 'layers-sheet'], ['planning-views-button', 'planning-views'], ['measurement-button', 'measurement-sheet'], ['proposals-button', 'proposals-sheet'], ['bets-button', 'bets-sheet'], ['activity-button', 'activity-sheet'], ['settings-button', 'settings-sheet']]) {
      await page.locator(`#${button}`).click();
      const sheet = page.locator(`#${id}`);
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
      const box = await sheet.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      // Short records fit their content; long sheets scroll within the available map area.
      expect(box!.height).toBeGreaterThan(44);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
      await sheet.locator(':scope > .mobile-dock-sheet-handle').focus();
      await page.keyboard.press('Home');
      const compact = (await sheet.boundingBox())!.height;
      await page.keyboard.press('End');
      expect((await sheet.boundingBox())!.height).toBeGreaterThanOrEqual(compact);
      await expect(sheet.locator(':scope > .mobile-dock-sheet-handle')).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(page.locator(`#${button}`)).toHaveAttribute('aria-expanded', 'false');
    }
    await page.locator('#settings-button').click();
    const settings = page.locator('#settings-sheet');
    for (const summary of await settings.locator(':scope > .map-sheet-body > details > summary').all()) await summary.click();
    await settings.locator(':scope > .mobile-dock-sheet-handle').focus();
    await page.keyboard.press('End');
    const expanded = (await settings.boundingBox())!.height;
    await dragHandle(page, settings, 120);
    expect((await settings.boundingBox())!.height).toBeLessThan(expanded - 80);
    await settings.locator(':scope > .mobile-dock-sheet-handle').focus();
    await page.keyboard.press('Home');
    await dragHandle(page, settings, 120);
    await expect(settings).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/map-sheet-open/);
  });
}

test('source and approval forms expand, keep actions reachable and cancel through their own cleanup', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openCity(page);
  await page.evaluate(() => (window as any).openBuildingSourceSettings());
  const source = page.locator('#parcel-source-settings');
  await expect(source).toBeVisible();
  await expect(source.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(1);
  expect((await source.boundingBox())!.height).toBeGreaterThan(200);
  expect((await source.boundingBox())!.height).toBeLessThanOrEqual(640);
  await expect(source.locator('.cb-dialog__footer')).toBeInViewport({ ratio: 1 });
  await source.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, source, 130);
  await expect(source).toHaveCount(0);

  await page.evaluate(() => (window as any).ProposalApprovalSetup.openDialog({}));
  const approval = page.locator('.approval-setup-dialog');
  await expect(approval).toBeVisible();
  expect((await approval.boundingBox())!.height).toBeGreaterThan(200);
  expect((await approval.boundingBox())!.height).toBeLessThanOrEqual(640);
  const apply = approval.locator('.cb-dialog__footer .btn-primary');
  await expect(apply).toBeInViewport({ ratio: 1 });
  // Reproduce keyboard shrink after an explicit resize, while layout height stays unchanged.
  await approval.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  expect((await approval.boundingBox())!.y + (await approval.boundingBox())!.height).toBeLessThanOrEqual(361);
  expect((await apply.boundingBox())!.y + (await apply.boundingBox())!.height).toBeLessThanOrEqual(361);
  await page.evaluate(() => {
    delete (window.visualViewport as any).height;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await approval.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Escape');
  await expect(approval).toHaveCount(0);
});

test('map agreement details resize without losing the saved agreement or applied layout', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { layoutId } = await applyLayout(page);
  const editor = await createFromPlan(page, layoutId);
  await editorSave(editor).click();
  const panel = await openStackAgreement(page);
  // The agreement panel is hosted in the click stack, and the stack is the phone sheet: a hosted
  // panel has no handle of its own (mobile-dock-sheet.js, cf72195aa).
  const sheet = page.locator('#click-stack');
  await expect(panel.locator(':scope > .mobile-dock-sheet-handle')).toHaveCount(0);
  // The stack fits its cards, so dragging it up grows it until the whole stack shows, no further.
  const initial = (await sheet.boundingBox())!.height;
  await dragHandle(page, sheet, -150);
  expect((await sheet.boundingBox())!.height).toBeGreaterThan(initial + 20);
  expect(await sheet.locator('.click-stack__sections').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await sheet.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, sheet, 140);
  await expect(sheet).toBeHidden();
  await expect(panel).toBeHidden();
  expect(await page.evaluate(id => {
    const w = window as any;
    return { agreements: w.AgreementStore.list().length, applied: w.isApplied(w.proposalStorage.getProposal(id)) };
  }, layoutId)).toEqual({ agreements: 1, applied: true });
});

test('every supporting page contains its content within a narrow phone viewport', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 740 });
  const paths = ['404.html', 'actor-explorer.html', 'tx-explorer.html', 'lens.html', 'feedback.html', 'parcel-coverage-report.html', 'parcel-source-formats.html', 'urban-planning.html', 'roadmap.html', 'hackathon-demo.html', 'deck.html', 'deck2.html', 'deck3.html', 'how-to-use.html', 'how-to-use-buildings.html', 'how-to-use-park-square.html', 'how-to-use-reparcellization.html', 'how-to-use-road.html', 'how-to-use-views.html', 'kako-koristiti.html', 'kako-koristiti-zgrade.html', 'kako-koristiti-park-trg.html', 'kako-koristiti-reparcelacija.html', 'kako-koristiti-cesta.html', 'kako-koristiti-prikazi.html', 'vocabulary/index.html', 'vocabulary/1/index.html'];
  const overflow: any[] = [];
  for (const path of paths) {
    await page.goto(`/${path}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1').first()).toBeVisible();
    const result = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 2 && getComputedStyle(el).position !== 'absolute').slice(0, 3).map(el => el.tagName + '.' + el.className) }));
    if (result.scroll > result.width + 2) overflow.push({ path, ...result });
  }
  expect(overflow).toEqual([]);
});

test('the road and cross-section sheets share resizing and drag-to-cancel without applying draft changes', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-transport-btn--road').click();
  const road = page.locator('#road-info-panel');
  await expect(road.locator(':scope > .mobile-dock-sheet-handle')).toBeVisible();
  await expect(road.locator('#finishRoadButton')).toBeInViewport({ ratio: 1 });
  await road.locator('#editRoadCrossSectionButton').click();
  const editor = page.locator('#corridor-editor-overlay .on-map-editor__panel');
  await expect(editor).toBeVisible();
  await expect(editor.locator(':scope > .mobile-dock-sheet-handle')).toBeVisible();
  await expect(editor.locator('.on-map-editor__toggle')).toBeHidden();
  const before = await page.evaluate(() => JSON.stringify((window as any).getRoadDrawingProfile()));
  await editor.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('End');
  await expect(editor.locator('.on-map-editor__footer')).toBeInViewport({ ratio: 1 });
  await editor.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, editor, 140);
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify((window as any).getRoadDrawingProfile()))).toBe(before);
  expect(await page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
  await road.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, road, 140);
  expect(await page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
});

test('model 3D keeps its scene while the same Layers sheet resizes and closes', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await createSpace(page, 'park');
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await page.locator('#layers-button').click();
  const layers = page.locator('#layers-sheet');
  await layers.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('End');
  await expect(layers.locator('#model-layer-controls')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(layers).toBeHidden();
  expect(await page.evaluate(() => !!(window as any).getThreeModeInternals())).toBe(true);
});

test('watched-area and site context panels dismiss through their original cleanup', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAreaMonitorSpaFallback(page);
  await page.goto('/monitors/1?city=zg&reduceMotion=1');
  await waitForMapReady(page);
  const monitor = page.locator('#area-monitor-detail-panel');
  await expect(monitor).toBeVisible();
  await monitor.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, monitor, 140);
  await expect(monitor).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/');
  await openCity(page);
  await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
  const site = page.locator('#site-panel');
  await expect(site).toBeVisible();
  await site.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, site, 140);
  await expect(site).toBeHidden();
  expect(await page.evaluate(() => (window as any).SiteTool.isActive())).toBe(false);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});

test('forms remain usable after rotating to a short landscape viewport', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await openCity(page);
  await page.evaluate(() => (window as any).ProposalApprovalSetup.openDialog({}));
  const form = page.locator('.approval-setup-dialog');
  await expect(form).toBeVisible();
  await expect(form.locator('.cb-dialog__footer')).toBeInViewport({ ratio: 1 });
  const handle = form.locator(':scope > .mobile-dock-sheet-handle');
  await handle.focus();
  await page.keyboard.press('End');
  expect((await form.boundingBox())!.height).toBeLessThanOrEqual(360);
  await expect(form.locator('.cb-dialog__footer')).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
});

test('profile and wallet choices share the handle; short confirmations retain direct actions', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openCity(page);
  const name = await page.locator('#username-text').textContent();
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal .cb-dialog');
  await expect(welcome).toBeVisible();
  await welcome.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, welcome, 140);
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect(page.locator('#username-text')).toHaveText(name!);
  await openWalletModal(page);
  const wallet = page.locator('.wallet-modal');
  await expect(wallet).toBeVisible();
  await wallet.locator(':scope > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Home');
  await dragHandle(page, wallet, 140);
  await expect(wallet).toHaveCount(0);
  await page.evaluate(() => { void (window as any).CbDialog.confirm('Keep working on this map?'); });
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('.mobile-dock-sheet-handle')).toHaveCount(0);
  const buttons = confirm.locator('.cb-dialog__footer .btn');
  expect((await buttons.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await buttons.last().boundingBox())!.width).toBeCloseTo((await buttons.first().boundingBox())!.width, 0);
  await buttons.first().click();
});
