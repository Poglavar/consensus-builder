// The Agent city (js/agent-city.js): executed agent agreements of the city, read from the page's
// index (mocks/shared-server.ts), drawn on the map as they stood at an execution day without being
// applied, and stepped through by day. Opened from the Activity sheet.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { cidOfObject, fileDesign, pageIndex } from '../helpers/mocks/shared-server';

// A building of 20 m by 20 m near the fixture parcels.
function building(lng: number, lat: number, floors: number) {
  const dLat = 10 / 110540, dLng = 10 / (111320 * Math.cos(lat * Math.PI / 180));
  return { type: 'Feature', properties: { floors, height: floors * 3, type: 'proposedBuildingSingle' },
    geometry: { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] } };
}

function fileExecuted(index: any, { title, lng, parcelId, executedAt }: { title: string; lng: number; parcelId: string; executedAt: string }) {
  const designCid = fileDesign(index, { schema: 'design/v1', goal: 'buildings', title, description: null, author: 'builder-02', city: 'zagreb',
    site: null, toleranceM: null, origin: null, authoredAt: executedAt, geometry: { buildings: [building(lng, 45.8, 4)] } });
  const cid = cidOfObject({ schema: 'agreement/v1', title, designCid, executedAt });
  index.agreements.set(cid, { cid, city: 'zagreb', title, author: 'builder-02', planCid: null, designCids: [designCid], inputParcelIds: [parcelId],
    parcelSourceId: null, deadline: null, status: 'executed', content: {}, createdAt: executedAt,
    onchain: { status: 'executed', executedAt, account: `acct-${parcelId}`, cluster: 'devnet' } });
}

test.describe('Agent city @features', () => {
  test('draws executed agent designs by day without applying them, and closes clean', async ({ mockApi: page }) => {
    const index = pageIndex(page);
    fileExecuted(index, { title: 'First building', lng: 15.96, parcelId: 'HR-1', executedAt: '2026-10-27T10:00:00.000Z' });
    fileExecuted(index, { title: 'Second building', lng: 15.961, parcelId: 'HR-2', executedAt: '2026-10-29T10:00:00.000Z' });
    await openCity(page);
    const appliedBefore = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);

    await page.evaluate(() => (window as any).openActivityPanel());
    await page.locator('#activity-agent-city').click();
    const card = page.locator('#agent-city');
    await expect(card).toBeVisible();
    await expect(page.locator('#activity-sheet')).toBeHidden();
    await expect(card.locator('[data-agent-city-source="server"]')).toHaveAttribute('aria-pressed', 'true');
    const summary = page.locator('#agent-city-summary');
    await expect(summary).toHaveText('Designs standing: 2 · executed 2 of 2');
    await expect(page.locator('path.design-display--building')).toHaveCount(2);

    // A day back: only the first execution stands.
    await page.locator('#agent-city-back').click();
    await expect(summary).toHaveText('Designs standing: 1 · executed 1 of 2');
    await expect(page.locator('path.design-display--building')).toHaveCount(1);
    await expect(page.locator('#agent-city-back')).toBeDisabled();
    await page.locator('#agent-city-forward').click();
    await expect(summary).toHaveText('Designs standing: 2 · executed 2 of 2');

    // This simulation has executed nothing yet.
    await card.locator('[data-agent-city-source="simulation"]').click();
    await expect(summary).toContainText('No design of this simulation has been executed yet');
    await expect(page.locator('path.design-display')).toHaveCount(0);

    // Nothing was imported or applied; closing removes the drawing.
    await card.locator('[data-agent-city-source="server"]').click();
    await expect(page.locator('path.design-display--building')).toHaveCount(2);
    await page.locator('#agent-city-close').click();
    await expect(card).toBeHidden();
    await expect(page.locator('path.design-display')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(appliedBefore);
  });
});
