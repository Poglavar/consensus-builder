// Shift+drag on the map draws a box that adds every parcel it touches to the multi-parcel selection
// (js/parcels/ui/box-select.js); plain clicks then add or remove single parcels.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, publishOn, PARCEL_ID, showSelectionDesignTab, selectionSection, parcelTab } from '../helpers/runtime';

async function parcelBox(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(parcelId => {
    const w = window as any;
    const bounds = w.ParcelPresenter.getLayer(parcelId).getBounds();
    w.map.fitBounds(bounds.pad(1.5), { animate: false });
    const rect = w.map.getContainer().getBoundingClientRect();
    const a = w.map.latLngToContainerPoint(bounds.getSouthWest()), b = w.map.latLngToContainerPoint(bounds.getNorthEast());
    return { x1: rect.left + Math.min(a.x, b.x) + 4, y1: rect.top + Math.min(a.y, b.y) + 4, x2: rect.left + Math.max(a.x, b.x) - 4, y2: rect.top + Math.max(a.y, b.y) - 4 };
  }, id);
}

test.describe('Shift+drag box selection @core', () => {
  test('selects the parcels in the box without zooming, then a click deselects one', async ({ mockApi: page }) => {
    const publishedCid = await publishOn(page, PARCEL_ID);
    await openCity(page);
    const box = await parcelBox(page, PARCEL_ID);
    const zoom = await page.evaluate(() => (window as any).map.getZoom());
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x1, box.y1);
    await page.mouse.down();
    await page.mouse.move((box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2);
    await page.mouse.move(box.x2, box.y2);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect.poll(() => page.evaluate(id => (window as any).multiParcelSelection.selectedParcels.has(id), PARCEL_ID)).toBe(true);
    expect(await page.evaluate(() => (window as any).map.getZoom())).toBe(zoom);
    await expect(selectionSection(page)).toBeVisible();
    await expect(page.locator('#click-stack')).toBeVisible();

    // The selection's Proposals tab totals what stands on its parcels, published ones included.
    await showSelectionDesignTab(page);
    await expect(page.locator('#propose-tab')).toBeVisible();
    await parcelTab(page, 'proposals-tab').click();
    const row = page.locator(`#proposals-content [data-server-id="${publishedCid}"]`);
    await expect(row).toContainText('Published park');
    // The row is an object-list item: its name outlines the design and stays pressed, opening nothing;
    // only its arrow opens it.
    await row.locator('[data-proposal-pick]').click();
    await expect(row.locator('[data-proposal-pick]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).ensureProposalOverlayGroups().inspection.getLayers().length)).toBeGreaterThan(0);
    await expect(page.locator('#proposal-details-panel')).toBeHidden();
    await expect(row.getByRole('button', { name: 'Open Published park' })).toBeVisible();

    const center = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).getBounds().getCenter(), PARCEL_ID);
    await clickMapPoint(page, center.lng, center.lat);
    await expect.poll(() => page.evaluate(id => (window as any).multiParcelSelection.selectedParcels.has(id), PARCEL_ID)).toBe(false);
  });
});
