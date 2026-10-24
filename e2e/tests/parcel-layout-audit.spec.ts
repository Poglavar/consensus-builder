// Purpose: audit the parcel-layout editor's Before / after divider (mouse, keyboard and touch, and its
// cleanup on close and reopen at desktop and phone widths) and its GeoJSON import, where a file the
// layout cannot use changes nothing.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import type { Locator, Page, TestInfo } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

// Parcel 1234 as a third and two thirds.
const UNEQUAL_LAYOUT = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { label: 'One-third plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9819, 45.8], [15.9821, 45.8], [15.9821, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]]] } },
    { type: 'Feature', properties: { label: 'Two-thirds plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9821, 45.8], [15.9825, 45.8], [15.9825, 45.8005], [15.9821, 45.8005], [15.9821, 45.8]]] } },
  ],
};

async function openLayoutEditor(page: Page): Promise<Locator> {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const editor = page.locator('.on-map-reparcellization');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return editor;
}

async function uploadGeoJson(editor: Locator, name: string, value: string | object) {
  await editor.locator('[data-reparcel-upload]').setInputFiles({
    name,
    mimeType: 'application/geo+json',
    buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: '390px', width: 390, height: 844 }]) {
  test(`the before/after divider drags, and cleans up on close and reopen at ${size.name}`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const editor = await openLayoutEditor(page);
    await editor.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
    await uploadGeoJson(editor, 'comparison.geojson', UNEQUAL_LAYOUT);
    await expect(editor.locator('[data-reparcel-newplots-table] .reparcel-newplot-row')).toHaveCount(2);
    await expect(editor.locator('[data-reparcel-compare]')).toBeVisible();
    await editor.locator('[data-reparcel-compare]').click();
    const map = page.locator('#map-container');
    const handle = map.locator('.map-compare__handle');
    await expect(map.locator('.map-compare__before')).toBeVisible();
    const initial = await handle.evaluate(node => Number.parseFloat((node as HTMLElement).style.left));
    const gripBox = await handle.locator('.map-compare__grip').boundingBox();
    const mapBox = await map.boundingBox();
    if (!gripBox || !mapBox) throw new Error('Compare grip or parcel-layout map has no visible bounds');
    const gripX = gripBox.x + gripBox.width / 2;
    const gripY = gripBox.y + gripBox.height / 2;
    await page.mouse.move(gripX, gripY);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + mapBox.width * 0.72, gripY, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => handle.evaluate(node => Number.parseFloat((node as HTMLElement).style.left))).not.toBe(initial);
    await attachScreenshot(page, testInfo, `${size.name}-comparison-drag.png`);

    await editor.locator('[data-reparcel-compare]').click();
    await expect(map.locator('.map-compare__before')).toHaveCount(0);
    await expect(map.locator('.map-compare__handle')).toHaveCount(0);
    await editor.locator('[data-reparcel-compare]').click();
    await expect(map.locator('.map-compare__before')).toBeVisible();
    const reopenedPosition = Number.parseFloat(await map.locator('.map-compare__handle').evaluate(node => (node as HTMLElement).style.left));
    expect(reopenedPosition).toBeCloseTo(mapBox.width / 2, 0);

    await editor.locator('[data-reparcel-cancel]').click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.map-compare__before, .map-compare__handle, .map-compare__label')).toHaveCount(0);
    // Reopen through the parcel action so the cleanup assertion covers the editor lifecycle too.
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcel-layout').click();
    const reopened = page.locator('.on-map-reparcellization');
    await expect(reopened.locator('.on-map-editor__panel')).toBeVisible();
    await expect(reopened.locator('.map-compare__before, .map-compare__handle, .map-compare__label')).toHaveCount(0);
    await attachScreenshot(page, testInfo, `${size.name}-reopened-clean.png`);
  });
}

test('the before/after divider handle is keyboard accessible and responds to arrow keys', async ({ mockApi: page }) => {
  const editor = await openLayoutEditor(page);
  await editor.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
  await uploadGeoJson(editor, 'keyboard.geojson', UNEQUAL_LAYOUT);
  await editor.locator('[data-reparcel-compare]').click();
  const slider = page.locator('#map-container [role="slider"]');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('tabindex', '0');
  await expect(slider).toHaveAttribute('aria-label', /before.*after|comparison/i);
  const before = await slider.evaluate(node => Number.parseFloat((node as HTMLElement).style.left));
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => slider.evaluate(node => Number.parseFloat((node as HTMLElement).style.left))).toBeGreaterThan(before);
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuenow', '100');
  await page.keyboard.press('PageDown');
  await expect(slider).toHaveAttribute('aria-valuenow', '90');
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(() => slider.evaluate(node => {
    const handle = node as HTMLElement;
    return Number.parseFloat(handle.style.left) / handle.parentElement!.clientWidth;
  })).toBeCloseTo(0.9, 2);
});

test('a GeoJSON file the layout cannot use changes nothing, and a partial one keeps the rest of the pool as a plot', async ({ mockApi: page }) => {
  const editor = await openLayoutEditor(page);
  const rows = () => editor.locator('[data-reparcel-newplots-table] tbody tr').allInnerTexts();
  const status = editor.locator('[data-reparcel-status]');
  await expect.poll(async () => (await rows()).length).toBe(2);
  const layout = await rows();

  await uploadGeoJson(editor, 'broken.geojson', '{ this is not JSON');
  await expect(status).toHaveText('Failed to parse GeoJSON file.');
  expect(await rows()).toEqual(layout);

  await uploadGeoJson(editor, 'empty.geojson', { type: 'FeatureCollection', features: [] });
  await expect(status).toHaveText('Uploaded file contains no polygon features.');
  expect(await rows()).toEqual(layout);

  await uploadGeoJson(editor, 'elsewhere.geojson', { type: 'Feature', properties: {}, geometry: {
    type: 'Polygon', coordinates: [[[15.99, 45.81], [15.991, 45.81], [15.991, 45.811], [15.99, 45.811], [15.99, 45.81]]],
  } });
  await expect(status).toHaveText('Uploaded polygons do not overlap with selected parcels.');
  expect(await rows()).toEqual(layout);
  await expect(editor.locator('input[name="reparcel-algorithm"][value="equal"]')).toBeChecked();

  // A file covering the western third: the land it leaves out stays one plot, so the layout still
  // tiles the pool and Done stays available.
  await uploadGeoJson(editor, 'partial.geojson', { type: 'FeatureCollection', features: [UNEQUAL_LAYOUT.features[0]] });
  await expect(status).toHaveText('Loaded 1 polygons from file.');
  await expect.poll(async () => (await rows()).length).toBe(2);
  expect(await rows()).not.toEqual(layout);
  await expect(editor.locator('input[name="reparcel-algorithm"][value="manual"]')).toBeChecked();
  await expect(editor.locator('[data-reparcel-coverage]')).toContainText('The plots cover the whole pool');
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled();
});

// Real browser touch input exercises the pointer controller and its touch-cancel cleanup.
test.describe('touch before/after comparison', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('the before/after divider follows a touch drag and ignores movement after cancellation', async ({ mockApi: page }, testInfo) => {
    const editor = await openLayoutEditor(page);
    await editor.locator('[data-reparcel-compare]').click();
    // The comparison handle is attached to the shared map, not nested inside the editor dock.
    const slider = page.locator('#map .map-compare__handle[role="slider"][aria-label="Before and after comparison"]');
    const map = page.locator('#map-container');
    const box = await map.boundingBox();
    const grip = await slider.locator('.map-compare__grip').boundingBox();
    if (!box || !grip) throw new Error('Touch comparison has no visible bounds');
    const cdp = await page.context().newCDPSession(page);
    const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: box.x + box.width * 0.75 }] });
    await expect.poll(() => slider.getAttribute('aria-valuenow').then(Number)).toBeCloseTo(75, 0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    const value = await slider.getAttribute('aria-valuenow');
    await page.mouse.move(box.x + box.width * 0.2, start.y);
    await expect(slider).toHaveAttribute('aria-valuenow', value!);
    await attachScreenshot(page, testInfo, 'touch-comparison.png');
    await cdp.detach();
  });
});
