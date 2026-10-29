// The Building use of a Freeform building (js/building-use.js): chosen in the editor, saved on the
// building, shown again on reopening, and read by Plan stats (no apartments in an office building).
import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, stubBasemapTiles, showProposal } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';

test('a Freeform building saves its use, reopens with it, and an office counts no apartments', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  const use = page.locator('#single-building-use');
  // A drawn building starts as housing.
  await expect(use).toHaveValue('residential');
  await selectNativeOption(use, 'office');
  await expect(page.locator('[data-land-status]')).toContainText('m²');
  await page.locator('#single-building-confirm').click();
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.goal === 'single' && p.applied).length), { timeout: 20_000 }).toBe(1);
  const saved = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals().find((p: any) => p.goal === 'single' && p.applied))));
  expect(saved.geometry.buildings[0].properties.use).toBe('office');

  await showProposal(page, saved.proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator('#single-building-use')).toHaveValue('office');

  // Plan stats over the same building: an office is work, so no apartments and some jobs.
  const totals = await page.evaluate(record => {
    const w = window as any;
    return w.__planYield.planYield([{ ...record, applied: true }], { appliedOnly: true }).total;
  }, saved);
  expect(totals.apartments).toBe(0);
  expect(totals.jobs).toBeGreaterThan(0);
});
