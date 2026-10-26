// Purpose: exercise the shared editor shell where map context, mode changes, and narrow screens
// used to make controls drift, disappear, or unlock too early.
import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, openBlockEditor, clickMapPoint, createBuilding, PARCEL_GEOMETRY, closeParcel, showSelectionDesignTab } from '../helpers/runtime';
import { buildings3D, mockBuildingScene } from '../helpers/mocks/building-data';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import type { Page } from '@playwright/test';

const MODES = ['#mode-3d-toggle', '#mode-realistic-toggle', '#mode-ai-toggle'];

async function editorPanelBox(page: Page, root: string) {
  const panel = page.locator(`${root} .on-map-editor__panel`);
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  if (!box) throw new Error(`No panel bounds for ${root}`);
  return box;
}

async function expectEditorDockedRight(page: Page, root: string) {
  const box = await editorPanelBox(page, root);
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box.x).toBeGreaterThan(viewportWidth / 2);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  expect(viewportWidth - (box.x + box.width)).toBeLessThan(30);
}

async function enableGdiContext(page: Page) {
  await page.evaluate(() => (window as any).MapShell.revealControl('showBuildings'));
  const gdi = page.locator('#showBuildings');
  if (!(await gdi.isChecked())) await gdi.check();
  await page.evaluate(() => (window as any).MapShell.closeSheets());
}

async function openEditor(page: Page, kind: 'block' | 'single' | 'detached' | 'row') {
  if (kind === 'row') {
    const blockParcels = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];
    await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), blockParcels);
    await openParcel(page, 'info', blockParcels[0]);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await closeParcel(page);
    await showSelectionDesignTab(page);
    await page.locator('.parcel-build-btn--row').click();
    return { root: '#rowhouse', done: '#btn-rowhouse-done', cancel: '#rowhouse .on-map-editor__header .close-circle-btn' };
  }

  if (kind === 'block') {
    await openParcel(page, 'proposals');
    await openBlockEditor(page);
    return { root: '#blockify-modal', done: '#btn-blockify-done', cancel: '#blockify-modal .on-map-editor__header .close-circle-btn' };
  }
  await openParcel(page, 'proposals');
  if (kind === 'single') {
    await page.locator('.parcel-build-btn--single').click();
    await placeFreeformBuilding(page);
    return { root: '#single-building-editor', done: '#single-building-confirm', cancel: '#single-building-editor .on-map-editor__header .close-circle-btn' };
  }
  await page.locator('.parcel-build-btn--parcelBased').click();
  return { root: '#parcelbased', done: '#btn-parcelbased-done', cancel: '#parcelbased .on-map-editor__header .close-circle-btn' };
}

async function nearbyBuildingMeshCount(page: Page) {
  return page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals().scene.traverse((object: any) => {
      if (object.isMesh && object.userData?.isNearbyBuilding3D && object.visible && object.parent?.visible) count += 1;
    });
    return count;
  });
}

async function closeDesignEditor(page: Page, root: string, cancelButton: string) {
  if ((page.viewportSize()?.width || 1280) <= 639) {
    const handle = page.locator(`${root} .on-map-editor__panel > .mobile-dock-sheet-handle`);
    await handle.focus();
    await page.keyboard.press('Escape');
  } else await page.locator(cancelButton).click();
  const discard = page.getByRole('alertdialog');
  if (await discard.isVisible().catch(() => false)) {
    const discardButton = discard.getByRole('button', { name: /discard|cancel design/i }).first();
    if (await discardButton.isVisible().catch(() => false)) await discardButton.click();
  }
  await expect(page.locator(root)).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/on-map-editing/);
  await expect(page.locator('#mode-3d-toggle')).toBeEnabled();
}

test.describe('Shared on-map editor shell @features', () => {
  for (const viewport of [
    { label: 'desktop', width: 1280, height: 900 },
    { label: '320px mobile', width: 320, height: 780 }
  ]) {
    test(`3D view hint and live status fit while bottom navigation is hidden on ${viewport.label}`, async ({ mockApi: page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockBuildingScene(page);
      await openCity(page);
      // Keep the real /buildings/near load active long enough for the view-angle hint's normal
      // ten-second timer to fire. The status text and busy state still come from the 3D loader.
      await page.route('**/buildings/near', async route => {
        await new Promise(resolve => setTimeout(resolve, 12_000));
        await route.fulfill({ json: { buildings: buildings3D } });
      });
      await page.locator('#mode-3d-toggle').click();
      await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });

      const hint = page.locator('#map-feedback-stack .three-view-hint');
      const statusText = page.locator('#floating-status-text');
      const status = page.locator('#floating-status');
      await expect(hint).toBeVisible({ timeout: 20_000 });
      await expect(statusText).not.toBeEmpty();
      await expect(status).toBeVisible();
      await expect(status).not.toHaveClass(/is-idle/);

      await expect(page.locator('#map-shell-bottom-right')).toBeHidden();
      const layout = await page.evaluate(() => {
        const feedback = document.getElementById('map-feedback-stack')!.getBoundingClientRect();
        const hint = document.querySelector('.three-view-hint')!.getBoundingClientRect();
        const status = document.getElementById('floating-status')!.getBoundingClientRect();
        return { feedbackBottom: feedback.bottom, hintBottom: hint.bottom, statusTop: status.top, viewportHeight: innerHeight };
      });
      expect(layout.hintBottom).toBeLessThanOrEqual(layout.statusTop);
      expect(layout.feedbackBottom).toBeLessThanOrEqual(layout.viewportHeight);
    });
  }

  test('the click stack clears the clicked parcel on desktop, omits View in 3D, and stays in the 320px viewport', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openCity(page);
    await clickMapPoint(page, 15.9822, 45.80025);
    const menu = page.locator('#click-stack');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.click-stack__section[data-kind="parcels"] #parcel-info-panel')).toBeVisible();
    await expect(menu.locator('[data-command="parcel.view3d"]')).toHaveCount(0);
    const desktop = await page.evaluate(geometry => {
      const map = (window as any).map;
      const mapBox = map.getContainer().getBoundingClientRect();
      const points = geometry.coordinates[0].map(([lng, lat]: number[]) => {
        const point = map.latLngToContainerPoint([lat, lng]);
        return { x: mapBox.left + point.x, y: mapBox.top + point.y };
      });
      const parcel = {
        left: Math.min(...points.map((point: any) => point.x)), right: Math.max(...points.map((point: any) => point.x)),
        top: Math.min(...points.map((point: any) => point.y)), bottom: Math.max(...points.map((point: any) => point.y))
      };
      const rect = document.getElementById('click-stack')!.getBoundingClientRect();
      const menu = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      return { parcel, menu };
    }, PARCEL_GEOMETRY);
    const overlaps = desktop.menu.left < desktop.parcel.right && desktop.menu.right > desktop.parcel.left
      && desktop.menu.top < desktop.parcel.bottom && desktop.menu.bottom > desktop.parcel.top;
    expect(overlaps, 'the desktop click stack should leave the clicked parcel clear when room is available').toBe(false);

    await page.setViewportSize({ width: 320, height: 780 });
    await openCity(page);
    await clickMapPoint(page, 15.9822, 45.80025);
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    if (!box) throw new Error('Mobile click stack has no visible bounds');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(780);
    await expect(menu.locator('[data-command="parcel.view3d"]')).toHaveCount(0);
  });

  test('Plan stats stays disabled for an empty plan, then opens after an applied building is created', async ({ mockApi: page }) => {
    await openCity(page);
    const actions = page.locator('#proposal-list-actions');
    const openActionsIfNeeded = async () => {
      if (!(await actions.isVisible())) await page.locator('#proposals-button').click();
    };
    await openActionsIfNeeded();
    const statsButton = page.locator('#planStatsButton');
    await expect(statsButton).toBeDisabled();
    await page.locator('#proposals-button').click();

    await createBuilding(page);
    await openActionsIfNeeded();
    await expect(statsButton).toBeEnabled();
    await statsButton.click();
    const modal = page.locator('#plan-stats-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-plan-stat="scope"]')).toContainText('1 applied');
    await modal.getByRole('button', { name: 'Close applied design stats' }).click();
    await expect(modal).toBeHidden();
  });

  for (const kind of ['road', 'track'] as const) {
    test(`${kind} drawing keeps 3D, photo, and AI modes locked through its nested cross-section editor`, async ({ mockApi: page }) => {
      await openCity(page);
      await openParcel(page, 'proposals');
      await page.locator(`.parcel-transport-btn--${kind}`).click();
      if (kind === 'track') await page.locator('#track-speed-confirm-btn').click();
      await expect(page.locator('#road-drawing-controls')).toBeVisible();
      for (const selector of MODES) await expect(page.locator(selector)).toBeDisabled();

      await page.locator('#editRoadCrossSectionButton').click();
      const crossSection = page.locator('#corridor-editor-overlay');
      await expect(crossSection.locator('.on-map-editor__panel')).toBeVisible();
      await crossSection.locator('.on-map-editor__header .close-circle-btn').click();
      await expect(crossSection).toHaveCount(0);
      await expect(page.locator('#road-drawing-controls')).toBeVisible();
      for (const selector of MODES) await expect(page.locator(selector)).toBeDisabled();

      if (kind === 'road') {
        await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
      } else {
        await clickMapPoint(page, 15.98195, 45.80025);
        await clickMapPoint(page, 15.98245, 45.80025);
        await page.locator('#finishRoadButton').click();
      }
      await expect(page.locator('#road-drawing-controls')).toBeHidden();
      await expect(page.locator('#mode-3d-toggle')).toBeEnabled();
    });
  }

  for (const kind of ['block', 'single', 'detached', 'row'] as const) {
    test(`${kind} editor stays right-docked in 2D and model 3D with its preview intact`, async ({ mockApi: page }) => {
      if (kind === 'row') await installLayerDatasets(page);
      // The broad layer fixture must precede the more specific 3D building route.
      const sceneRequests = await mockBuildingScene(page);
      await openCity(page);
      await enableGdiContext(page);
      const editor = await openEditor(page, kind);
      const root = page.locator(editor.root);
      await expect(page.locator(editor.done)).toBeEnabled({ timeout: 20_000 });
      if (kind === 'single') {
        // The freeform land-take summary refines its initial placement preview asynchronously.
        await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
      }
      await expectEditorDockedRight(page, editor.root);
      const preview = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).OnMapEditor.getPreview())));
      expect(preview).toBeTruthy();

      await page.locator('#mode-3d-toggle').click();
      await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
      await page.waitForFunction(() => !!(window as any).getThreeModeInternals?.()?.scene);
      await expectEditorDockedRight(page, editor.root);
      await expect.poll(() => page.evaluate(() => (window as any).OnMapEditor.getPreview())).toEqual(preview);
      await expect.poll(() => sceneRequests.length).toBeGreaterThan(0);
      await expect.poll(() => nearbyBuildingMeshCount(page)).toBeGreaterThan(0);
      await closeDesignEditor(page, editor.root, editor.cancel);
    });
  }

  test('320px block editor resizes through its shared handle without moving the preview', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await openCity(page);
    await enableGdiContext(page);
    await openParcel(page, 'proposals');
    await openBlockEditor(page);
    const root = page.locator('#blockify-modal');
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    const before = await page.evaluate(() => ({
      preview: JSON.parse(JSON.stringify((window as any).OnMapEditor.getPreview())),
      center: (() => { const center = (window as any).map.getCenter(); return { lat: center.lat, lng: center.lng }; })(),
      zoom: (window as any).map.getZoom()
    }));
    const panel = root.locator('.on-map-editor__panel');
    const handle = panel.locator(':scope > .mobile-dock-sheet-handle');
    await expect(handle).toBeVisible();
    await expect(root.locator('.on-map-editor__toggle')).toBeHidden();
    await expect(root.locator('.on-map-editor__header .close-circle-btn')).toHaveCSS('clip-path', 'inset(50%)');
    await expect(root.locator('.on-map-editor__body')).toBeVisible();

    const expandedHeight = (await panel.boundingBox())!.height;
    await handle.focus();
    await page.keyboard.press('Home');
    const compactBox = await panel.boundingBox();
    expect(compactBox).not.toBeNull();
    expect(compactBox!.height).toBeLessThan(expandedHeight);
    await expect(root.locator('.on-map-editor__body')).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).OnMapEditor.getPreview()))).toBe(JSON.stringify(before.preview));
    const compactState = await page.evaluate(() => {
      const center = (window as any).map.getCenter();
      return { center: { lat: center.lat, lng: center.lng }, zoom: (window as any).map.getZoom() };
    });
    expect(compactState.center).toEqual(before.center);
    expect(compactState.zoom).toBe(before.zoom);

    for (const selector of ['#btn-blockify-done', '#btn-blockify-freeform']) {
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
      const box = await page.locator(selector).boundingBox();
      expect(box, `${selector} should remain reachable at compact height`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.y + box!.height).toBeLessThanOrEqual(780);
    }

    await handle.focus();
    await page.keyboard.press('End');
    const fullBox = await panel.boundingBox();
    expect(fullBox).not.toBeNull();
    expect(fullBox!.height).toBeGreaterThan(compactBox!.height);
    await expect(root.locator('.on-map-editor__body')).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).OnMapEditor.getPreview()))).toBe(JSON.stringify(before.preview));
    const expanded = await page.evaluate(() => {
      const center = (window as any).map.getCenter();
      return { center: { lat: center.lat, lng: center.lng }, zoom: (window as any).map.getZoom() };
    });
    expect(expanded.center).toEqual(before.center);
    expect(expanded.zoom).toBe(before.zoom);
    await closeDesignEditor(page, '#blockify-modal', '#blockify-modal .on-map-editor__header .close-circle-btn');
  });
});
