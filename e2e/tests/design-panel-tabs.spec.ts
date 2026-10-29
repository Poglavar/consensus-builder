// The design panel's tabs: a parcel layout has Overview, Input parcels (n) and Output parcels (n), and
// hovering the parcel it replaced lights that parcel's old outline only, never the plots now on it;
// every other design keeps Overview and Details.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, showProposalTab, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { layOutParcel } from '../helpers/agreements';
import { Page } from '@playwright/test';

const panel = (page: Page) => page.locator('#proposal-details-panel');

// The parcel's own outline on screen, as a box in page pixels.
const parcelScreenBox = (page: Page) => page.evaluate(geometry => {
  const w = window as any;
  const bounds = w.L.geoJSON(geometry).getBounds();
  const box = w.map.getContainer().getBoundingClientRect();
  const nw = w.map.latLngToContainerPoint(bounds.getNorthWest());
  const se = w.map.latLngToContainerPoint(bounds.getSouthEast());
  return { left: box.left + nw.x, top: box.top + nw.y, right: box.left + se.x, bottom: box.top + se.y };
}, PARCEL_GEOMETRY);

test('a parcel layout lists its input and output parcels on their own tabs; hovering the replaced input lights its old outline', async ({ mockApi: page }) => {
  await openCity(page);
  const layoutId = await layOutParcel(page, PARCEL_ID);
  const outputs = await page.evaluate(id => {
    const w = window as any;
    return w.LiveParcelFabric.all?.().filter?.((f: any) => (f.properties?.formedByProposalIds || []).map(String).includes(String(id))).length ?? null;
  }, layoutId);
  await showProposal(page, layoutId);
  await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized?.(false));

  const tabs = panel(page).getByRole('tab');
  await expect(tabs).toHaveText(['Overview', 'Input parcels (1)', /^Output parcels \(\d+\)$/]);
  const outputCount = Number((await tabs.nth(2).textContent())?.match(/\((\d+)\)/)?.[1]);
  expect(outputCount).toBeGreaterThanOrEqual(2);
  if (outputs !== null) expect(outputCount).toBe(outputs);
  await expect(panel(page).locator('[data-proposal-tab="details"]')).toHaveCount(0);
  await expect(panel(page).locator('[data-proposal-tab="overview"]')).toHaveAttribute('aria-selected', 'true');

  await showProposalTab(page, 'outputs');
  await expect(panel(page).locator('[data-proposal-tabpanel="overview"]')).toBeHidden();
  await expect(panel(page).locator('#proposal-descendants-list .descendant-item[data-descendant-type="parcel"]')).toHaveCount(outputCount);

  await showProposalTab(page, 'inputs');
  await expect(panel(page).locator('[data-proposal-tabpanel="outputs"]')).toBeHidden();
  const input = panel(page).locator(`[data-proposal-tabpanel="inputs"] .proposal-parcel-item[data-parcel-id="${PARCEL_ID}"]`);
  await expect(input).toHaveCount(1);
  await expect(input).toHaveAttribute('data-parcel-replaced', 'true');

  // Hovering the replaced input draws one outline: the parcel as it was, not the plots now on it.
  const hover = page.locator('#map path.proposal-hover-outline');
  await expect(hover).toHaveCount(0);
  await input.hover();
  await expect(hover).toHaveCount(1);
  const drawn = await hover.evaluate(path => { const r = path.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
  const parcel = await parcelScreenBox(page);
  // The stroke is a few pixels wide; the outline must match the parcel's box within it.
  for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(drawn[side] - parcel[side])).toBeLessThan(6);
  await page.mouse.move(5, 5);
  await expect(hover).toHaveCount(0);
});

test('a design that is not a parcel layout keeps Overview and Details', async ({ mockApi: page }) => {
  await openCity(page);
  const parkId = await createSpace(page, 'park');
  await showProposal(page, parkId);
  await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized?.(false));
  await expect(panel(page).getByRole('tab')).toHaveText(['Overview', 'Details']);
  await showProposalTab(page, 'details');
  await expect(panel(page).locator('[data-proposal-tabpanel="details"] details[data-proposal-section="land"]')).toHaveCount(1);
  await expect(panel(page).locator('[data-proposal-tab="inputs"], [data-proposal-tab="outputs"]')).toHaveCount(0);
});
