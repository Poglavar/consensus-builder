// The bottom row's three sheets (Proposals, Bets, Activity) share one frame: the same box on a wide
// map, and on a phone the whole screen above the bar, translucent. Since a phone's list then hides
// the map, a row tap there goes to the proposal (compact card) instead of previewing it behind.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity } from '../helpers/runtime';

const SHEETS = ['proposals', 'bets', 'activity'];

async function sheetBox(page: import('@playwright/test').Page, id: string) {
  const button = page.locator(`#${id}-button`);
  const sheet = page.locator(`#${id}-sheet`);
  await button.click();
  await expect(sheet).toBeVisible();
  const box = await sheet.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(el).backgroundColor };
  });
  await button.click();
  await expect(sheet).toBeHidden();
  return box;
}

test.describe('Dock sheets', () => {
  test('open in one frame on a wide map, whichever button opens them', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await openCity(page);
    const boxes = [];
    for (const id of SHEETS) boxes.push(await sheetBox(page, id));
    expect(boxes[0].w).toBe(560);
    for (const box of boxes.slice(1)) expect(box).toEqual(boxes[0]);
  });

  test('fill a phone screen above the bar, with the map showing through', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCity(page);
    const bar = await page.locator('#map-shell-bottom-right').boundingBox();
    expect(bar).not.toBeNull();
    for (const id of SHEETS) {
      const box = await sheetBox(page, id);
      expect(box, id).toMatchObject({ x: 0, y: 0, w: 390 });
      // The bar's 1px top border is not in --map-shell-dock-height: the sheet may tuck under it by that.
      expect(Math.abs(box.y + box.h - bar!.y), id).toBeLessThanOrEqual(1);
      expect(box.bg, id).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
    }
  });

  test('a phone list tap opens the proposal compact on the map and closes the list', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    await page.evaluate(() => (window as any).hideProposalDetailsPanel?.(true));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#proposals-button').click();
    const row = page.locator(`#proposals-sheet .proposal-list-item[data-proposal-id="${parkId}"]`);
    await row.locator('.proposal-list-title').click();
    await expect(page.locator('#proposals-sheet')).toBeHidden();
    const panel = page.locator('#proposal-details-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(row).not.toHaveClass(/is-previewing/);
    expect(await page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(parkId);
  });
});
