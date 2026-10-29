// The click stack's Focus button ("Show on map") and framing of objects opened from Lists: Focus
// always brings the section's object into the map the stack leaves visible; a design opened from Lists
// is framed when it is out of view and leaves the camera alone when it is already in view.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, clickStack, stackSection } from '../helpers/runtime';
import { Page } from '@playwright/test';

// Whether the design's whole outline lies inside the map area the click stack leaves uncovered.
async function designInView(page: Page, id: string) {
  return page.evaluate(id => {
    const w = window as any;
    const features = w.MapPick.outlineOf(w.proposalStorage.getProposal(id));
    const bounds = w.L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
    const map = w.map;
    const nw = map.latLngToContainerPoint(bounds.getNorthWest());
    const se = map.latLngToContainerPoint(bounds.getSouthEast());
    const mapBox = map.getContainer().getBoundingClientRect();
    const stack = document.querySelector('#click-stack') as HTMLElement | null;
    const stackBox = stack && stack.offsetParent ? stack.getBoundingClientRect() : null;
    const right = stackBox ? Math.min(mapBox.width, stackBox.left - mapBox.left) : mapBox.width;
    return nw.x >= 0 && nw.y >= 0 && se.x <= right && se.y <= mapBox.height;
  }, id);
}

const mapCenter = (page: Page) => page.evaluate(() => {
  const c = (window as any).map.getCenter();
  return { lat: Number(c.lat.toFixed(7)), lng: Number(c.lng.toFixed(7)), zoom: (window as any).map.getZoom() };
});

async function openFromLists(page: Page, id: string) {
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator(`.lists-item[data-list-id="${id}"] .lists-item__open`).click();
  await expect(stackSection(page, 'designs').locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
}

test('Focus brings the design back into view, and Lists frames a design only when it is out of view', async ({ mockApi: page }) => {
  await openCity(page);
  const id = await createSpace(page, 'park');
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();

  // Already in view: opening it from Lists keeps the camera where it is.
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.98205], 18, { animate: false }));
  expect(await designInView(page, id)).toBe(true);
  const before = await mapCenter(page);
  await openFromLists(page, id);
  expect(await mapCenter(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(clickStack(page)).toBeHidden();

  // Out of view (a few hundred metres away): opening it from Lists frames it.
  await page.evaluate(() => (window as any).map.setView([45.8040, 15.9870], 18, { animate: false }));
  expect(await designInView(page, id)).toBe(false);
  await openFromLists(page, id);
  await expect.poll(() => designInView(page, id), { timeout: 10_000 }).toBe(true);

  // The map moves away with the stack open; Focus brings the design back.
  await page.evaluate(() => (window as any).map.setView([45.8040, 15.9870], 17, { animate: false }));
  await expect.poll(() => designInView(page, id)).toBe(false);
  const focus = stackSection(page, 'designs').locator('.click-stack__focus[data-action="focus"]');
  await expect(focus).toHaveAccessibleName('Show on map');
  await focus.click();
  await expect.poll(() => designInView(page, id), { timeout: 10_000 }).toBe(true);
  // Framed, not merely panned: a park this size fills the view at a street-level zoom.
  expect(await page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThanOrEqual(18);
});
