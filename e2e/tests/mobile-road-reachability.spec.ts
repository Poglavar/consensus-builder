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

async function startRoadDraft(page: any): Promise<void> {
  await openCity(page);
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

test('road header and cross-section actions stay reachable at 320px before the first point', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await startRoadDraft(page);

  const minimize = page.locator('#road-panel-minimize');
  await expectCenterHitTarget(page, '#road-panel-minimize');
  await minimize.click();
  await expect(minimize).toHaveAttribute('aria-expanded', 'false');
  await minimize.click();
  await expect(minimize).toHaveAttribute('aria-expanded', 'true');

  const crossSection = page.locator('#editRoadCrossSectionButton');
  await expectCenterHitTarget(page, '#editRoadCrossSectionButton');
  const initialStrips = await page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length);
  await crossSection.click();
  const editor = page.locator('#corridor-editor-overlay');
  await expect(editor).toBeVisible();

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
  await expectCenterHitTarget(page, '#corridor-editor-overlay .corridor-editor-cancel');
  await editor.locator('.corridor-editor-cancel').click();
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips);

  await crossSection.click();
  await expect(editor).toBeVisible();
  await addSidewalk(page, editor);
  await expectCenterHitTarget(page, '#corridor-editor-overlay .corridor-editor-close');
  await editor.locator('.corridor-editor-close').click();
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips);

  await crossSection.click();
  await expect(editor).toBeVisible();
  await addSidewalk(page, editor);
  await expectCenterHitTarget(page, '#corridor-editor-overlay .corridor-editor-save');
  await editor.locator('.corridor-editor-save').click();
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips + 1);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);

  // Header Close cancels the still-empty road draft and does not create a proposal.
  const headerClose = page.locator('#road-info-panel .road-panel-actions .close-button');
  await expectCenterHitTarget(page, '#road-info-panel .road-panel-actions .close-button');
  await headerClose.click();
  await expect(page.locator('#road-info-panel')).toBeHidden();
  await expect(page.locator('#road-drawing-controls')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});

test('2D, model, and aerial mode buttons receive real clicks during a 320px road draft, then drawing undo and discard work', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await mockBuildingScene(page);
  const photoTiles = await mockPhotoTiles(page);
  await startRoadDraft(page);

  const model = page.locator('#mode-3d-toggle');
  await expectCenterHitTarget(page, '#mode-3d-toggle');
  await model.click();
  await expect(model).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);

  const aerial = page.locator('#mode-realistic-toggle');
  await expectCenterHitTarget(page, '#mode-realistic-toggle');
  await aerial.click();
  await expect(aerial).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(photoTiles.requests, { timeout: 20000 }).toBeGreaterThan(0);
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);

  const mapMode = page.locator('#mode-2d-toggle');
  await expectCenterHitTarget(page, '#mode-2d-toggle');
  await mapMode.click();
  await expect(mapMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('#map')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);

  // Minimize the phone dock to expose the map, then draw, undo, and discard through visible controls.
  await page.locator('#road-panel-minimize').click();
  await expect(page.locator('#road-info-panel')).toHaveClass(/is-minimized/);
  await clickMapPoint(page, 15.98195, 45.8001);
  await clickMapPoint(page, 15.98215, 45.8001);
  await clickMapPoint(page, 15.9824, 45.8001);
  const beforeUndo = await page.locator('#road-length').innerText();
  expect(beforeUndo).not.toBe('0 m');
  await page.locator('#undoRoadButton').click();
  await expect.poll(() => page.locator('#road-length').innerText()).not.toBe(beforeUndo);
  await clickMapPoint(page, 15.9824, 45.8001);

  await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel' }).click();
  const choice = page.locator('.cb-confirm-dialog');
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Discard the drawing', exact: true }).click();
  await expect(choice).toBeHidden();
  await expect(page.locator('#road-drawing-controls')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});
