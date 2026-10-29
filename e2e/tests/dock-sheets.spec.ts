// Designs docks right on desktop. On phones, navigation sheets fill the screen above the bar;
// a design row opens its context on the map and closes that sheet.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity } from '../helpers/runtime';

const SHEETS = ['bets', 'activity'];

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
  test('Designs docks beside the map while Bets stays anchored above navigation', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await openCity(page);
    const designs = await sheetBox(page, 'proposals');
    const bets = await sheetBox(page, 'bets');
    expect(designs.x).toBeGreaterThan(640);
    expect(designs.x + designs.w).toBeGreaterThan(1250);
    expect(designs.y).toBeLessThan(100);
    expect(bets.x).toBeLessThan(designs.x);
    expect(bets.y).toBeGreaterThan(designs.y);
  });

  test('fill a phone screen above the bar, with the map showing through', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCity(page);
    const bar = await page.locator('#map-shell-bottom-right').boundingBox();
    expect(bar).not.toBeNull();
    for (const id of ['proposals', ...SHEETS]) {
      const box = await sheetBox(page, id);
      expect(box, id).toMatchObject({ x: 0, y: 0, w: 390 });
      // The bar's 1px top border is not in --map-shell-dock-height: the sheet may tuck under it by that.
      expect(Math.abs(box.y + box.h - bar!.y), id).toBeLessThanOrEqual(1);
      expect(box.bg, id).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
    }
  });

  test('a phone list tap opens the design context on the map and closes the list', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    const title = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, parkId);
    await page.evaluate(() => (window as any).hideProposalDetailsPanel?.(true));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#proposals-button').click();
    // Lists rows (lists-panel.js, 01268caee) are keyed by data-list-id; Open selects (the title only shows it on the map).
    const row = page.locator(`#proposals-sheet .lists-item[data-list-id="${parkId}"]`);
    await row.locator('.lists-item__open').click();
    await expect(page.locator('#proposals-sheet')).toBeHidden();
    const panel = page.locator('#click-stack');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(title);
    expect(await page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(parkId);
  });
});
