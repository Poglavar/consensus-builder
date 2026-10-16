// Purpose: the land-readjustment layout editor works without hunting for a tool. Handles are on as
// soon as it opens; grabbing a boundary segment moves it (and turns the automatic layout into a drawn
// one); undo gives the automatic layout back and redo replays the edit; switching to Draw freely keeps
// the plots and owners that were on the map.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

async function openReadjustment(page: Page) {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--reparcellization').click();
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return modal;
}

// Rows of the New plots list: "1 123 m² Owner A …".
async function plotRows(page: Page): Promise<string[]> {
  return page.locator('.reparcel-newplots-list tbody tr').evaluateAll(rows => rows
    .map(row => (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

const algorithm = (page: Page) => page.locator('input[name="reparcel-algorithm"]:checked').inputValue();

// A point 30% along the first draggable boundary segment, in page coordinates: not its midpoint,
// where the insert handle sits.
async function segmentPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('path.geom-handle-edge').first().evaluate(element => {
    const path = element as unknown as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.3);
    const matrix = path.getScreenCTM()!;
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
}

test('a boundary segment drags straight away, undo and redo walk it back and forth, Draw freely keeps the plots', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const modal = await openReadjustment(page);
  expect(await algorithm(page)).toBe('sweep-line');
  // The handles are the editor: on from the start, with grabbable segments between plots.
  await expect(modal.locator('[data-reparcel-nodes]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path.geom-handle-edge').first()).toBeAttached();
  await expect(page.locator('.reparcel-plot-number').first()).toBeVisible();
  const automatic = await plotRows(page);
  expect(automatic.length).toBeGreaterThanOrEqual(2);

  const start = await segmentPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(start.x + step * 4, start.y);
  await page.mouse.up();

  await expect.poll(() => plotRows(page)).not.toEqual(automatic);
  const dragged = await plotRows(page);
  expect(dragged).toHaveLength(automatic.length);
  // Editing the automatic split turned it into a drawn layout with the same owners.
  expect(await algorithm(page)).toBe('manual');
  expect(dragged.map(row => row.replace(/^\d+ [\d.,]+ m² /, ''))).toEqual(automatic.map(row => row.replace(/^\d+ [\d.,]+ m² /, '')));

  await page.mouse.move(5, 400);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(page)).toEqual(automatic);
  expect(await algorithm(page)).toBe('sweep-line');
  await expect(modal.locator('[data-reparcel-redo-edit]')).toBeEnabled();

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => plotRows(page)).toEqual(dragged);
  expect(await algorithm(page)).toBe('manual');

  // Back to the automatic split, then Draw freely: the plots and owners come along.
  await modal.locator('.reparcel-alg-option', { hasText: 'Automatic' }).click();
  await expect.poll(() => plotRows(page)).toEqual(automatic);
  await modal.locator('.reparcel-alg-option', { hasText: 'Draw freely' }).click();
  await expect.poll(() => algorithm(page)).toBe('manual');
  expect(await plotRows(page)).toEqual(automatic);
  await expect(modal.locator('[data-reparcel-status]')).toContainText('Drawing freely from the current layout');
});

test('a click on a boundary offers to erase it, and Delete removes a node from its popup', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const modal = await openReadjustment(page);
  const before = await plotRows(page);

  const point = await segmentPoint(page);
  await page.mouse.click(point.x, point.y);
  const popup = page.locator('.leaflet-popup .reparcel-node-popup');
  await expect(popup).toContainText('Boundary between plot 1');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  // Escape closed only the popup, not the editor.
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();

  await page.mouse.click(point.x, point.y);
  await popup.getByRole('button', { name: 'Erase this boundary' }).click();
  await expect.poll(async () => (await plotRows(page)).length).toBe(before.length - 1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => plotRows(page)).toEqual(before);

  // A node popup: Delete removes the node, which straightens or dissolves its boundary.
  const node = page.locator('.reparcel-node-handle').first();
  await node.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(popup).toHaveCount(0);
  await expect.poll(() => plotRows(page)).not.toEqual(before);
});
