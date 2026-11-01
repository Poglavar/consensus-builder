// Purpose: guard phone-width reachability for corridor header actions and map-mode controls while
// a road draft is active. These are real clicks because geometry-only assertions miss overlays.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';

async function expectCenterHitTarget(page: any, selector: string): Promise<void> {
  const hit = await page.locator(selector).evaluate((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    return {
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden',
      inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      receives: !!target && (target === element || element.contains(target)),
    };
  });
  expect(hit, `${selector} should be visible and receive a center-point click`).toEqual({
    visible: true,
    inside: true,
    receives: true,
  });
}

async function dragHandle(page: any, sheet: any, deltaY: number): Promise<void> {
  const box = await sheet.locator(':scope > .mobile-dock-sheet-handle').boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 10 });
  await page.mouse.up();
}

async function expectRoadHandle(page: any): Promise<void> {
  const handle = page.locator('#road-info-panel > .mobile-dock-sheet-handle');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expectCenterHitTarget(page, '#road-info-panel > .mobile-dock-sheet-handle');
}

async function startRoadDraft(page: any, cityReady = false): Promise<void> {
  if (!cityReady) await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-transport-btn--road').click();
  await expect(page.locator('#road-info-panel')).toBeVisible();
  await expect(page.locator('#road-drawing-controls')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
  await expect(page.locator('#road-length')).toHaveText('0 m');
}

async function addSidewalk(page: any, editor: any): Promise<void> {
  await editor.locator('.cb-lane-dropdown-toggle').click();
  await editor.locator('[data-lane-type="sidewalk"]').click();
}

test('road sheet and cross-section actions stay reachable at 320px before the first point', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await startRoadDraft(page);

  const road = page.locator('#road-info-panel');
  await expectRoadHandle(page);
  const initialHeight = (await road.boundingBox())!.height;
  const handle = road.locator(':scope > .mobile-dock-sheet-handle');
  await handle.focus();
  await page.keyboard.press('Home');
  const compactHeight = (await road.boundingBox())!.height;
  expect(compactHeight).toBeLessThan(initialHeight - 80);
  await page.keyboard.press('End');
  expect((await road.boundingBox())!.height).toBeGreaterThan(compactHeight + 80);

  const crossSection = page.locator('#editRoadCrossSectionButton');
  await expectCenterHitTarget(page, '#editRoadCrossSectionButton');
  const initialStrips = await page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length);
  await crossSection.click();
  const editor = page.locator('#corridor-editor-overlay');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

  // The standard-width reset is conditional, so create a non-standard lane width first and then
  // exercise the resulting button through the real editor UI.
  const firstWidth = await page.evaluate(() => (window as any).getRoadDrawingProfile().strips[0].width);
  const changedWidth = firstWidth + 0.25;
  const firstWidthInput = editor.locator('.corridor-lane-width').first();
  await firstWidthInput.fill(String(changedWidth));
  await firstWidthInput.press('Tab'); // Commit through the editor's real change-on-blur handler.
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips[0].width)).toBe(changedWidth);
  const resetWidth = editor.locator('[data-reset-standard="0"]');
  // The lane list has its own scroll region above a fixed footer on a phone. Scroll the row into
  // that region before checking the real hit target; a merely visible rect behind the footer is
  // not a usable control.
  await resetWidth.scrollIntoViewIfNeeded();
  await expect(resetWidth).toBeVisible();
  await expectCenterHitTarget(page, '#corridor-editor-overlay [data-reset-standard="0"]');
  await resetWidth.click();
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips[0].width)).not.toBe(changedWidth);
  await expect(editor.locator('[data-reset-standard="0"]')).toHaveCount(0);

  await addSidewalk(page, editor);
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips + 1);
  await editor.locator('.on-map-editor__panel > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Escape');
  const discard = page.getByRole('alertdialog');
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips);

  await crossSection.click();
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await addSidewalk(page, editor);
  await editor.locator('.on-map-editor__panel > .mobile-dock-sheet-handle').focus();
  await page.keyboard.press('Escape');
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips);

  await crossSection.click();
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await addSidewalk(page, editor);
  await expectCenterHitTarget(page, '#corridor-editor-overlay .corridor-editor-save');
  await editor.locator('.corridor-editor-save').click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips + 1);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);

  // Dragging the shared sheet handle down cancels the still-empty road draft.
  await expectRoadHandle(page);
  const roadHeight = (await road.boundingBox())!.height;
  await dragHandle(page, road, roadHeight - 140);
  await expect(page.locator('#road-info-panel')).toBeHidden();
  await expect(page.locator('#road-drawing-controls')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});

test('mobile mode switching works before drawing; the road draft locks modes until undo and discard', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await mockBuildingScene(page);
  const photoTiles = await mockPhotoTiles(page);
  await openCity(page);
  const model = page.locator('#mode-3d-toggle');
  await expectCenterHitTarget(page, '#mode-3d-toggle');
  await model.click();
  await expect(model).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });

  const aerial = page.locator('#mode-realistic-toggle');
  await expectCenterHitTarget(page, '#mode-realistic-toggle');
  await aerial.click();
  await expect(aerial).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(photoTiles.requests, { timeout: 20000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);

  const mapMode = page.locator('#mode-2d-toggle');
  await expectCenterHitTarget(page, '#mode-2d-toggle');
  await mapMode.click();
  await expect(mapMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('#map')).toBeVisible();

  await startRoadDraft(page, true);
  await expect(model).toBeDisabled();
  await expect(aerial).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);

  // Resize the shared phone sheet to expose the map, then draw, undo, and discard through visible controls.
  const road = page.locator('#road-info-panel');
  await expectRoadHandle(page);
  const fullHeight = (await road.boundingBox())!.height;
  const handle = road.locator(':scope > .mobile-dock-sheet-handle');
  await handle.focus();
  await page.keyboard.press('Home');
  expect((await road.boundingBox())!.height).toBeLessThan(fullHeight - 80);
  // The road's points in the middle of the map left above the sheet, clear of the status line that
  // sits on the sheet's top edge (a tap there copies the line instead of reaching the map).
  await page.evaluate(() => (window as any).map.panTo([45.8001, 15.98215], { animate: false }));
  await clickMapPoint(page, 15.98195, 45.8001);
  await clickMapPoint(page, 15.98215, 45.8001);
  await clickMapPoint(page, 15.9824, 45.8001);
  const beforeUndo = await page.locator('#road-length').innerText();
  expect(beforeUndo).not.toBe('0 m');
  await page.locator('#undoRoadButton').click();
  await expect.poll(() => page.locator('#road-length').innerText()).not.toBe(beforeUndo);
  await clickMapPoint(page, 15.9824, 45.8001);

  await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel' }).click();
  const choice = page.locator('.cb-dialog-overlay--confirm .cb-dialog');
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Discard the drawing', exact: true }).click();
  await expect(choice).toBeHidden();
  await expect(page.locator('#road-drawing-controls')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
  await expect(model).toBeEnabled();
  await expect(aerial).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});
