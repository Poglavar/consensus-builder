// Verify the proposal comparison pickers through their visible effects.
import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

test('comparison pickers update both proposal geometries and their side-by-side details', async ({ mockApi: page }) => {
  await openCity(page);
  const ids = await page.evaluate(({ parcelId, geometry }) => {
    const ring = (geometry as any).coordinates[0] as number[][];
    const center = ring.reduce((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0]);
    const scaled = (factor: number) => ({
      type: 'Polygon', coordinates: [ring.map(([x, y]) => [center[0] + (x - center[0]) * factor, center[1] + (y - center[1]) * factor])]
    });
    const w = window as any;
    return [
      w.proposalStorage.addProposal({ title: 'Full park plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry: scaled(0.9), structureProposal: { kind: 'park', geometry: scaled(0.9), applied: true } }),
      w.proposalStorage.addProposal({ title: 'Medium square plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry: scaled(0.65), structureProposal: { kind: 'square', geometry: scaled(0.65), applied: true } }),
      w.proposalStorage.addProposal({ title: 'Small park plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], geometry: scaled(0.4), structureProposal: { kind: 'park', geometry: scaled(0.4), applied: true } }),
    ];
  }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });

  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(page.locator('#parcel-menu')).toBeVisible();
  await page.locator('#parcel-menu [data-command="parcel.compare"]').click();
  const compare = page.locator('#parcel-compare-dialog');
  const pickerA = compare.locator('.parcel-compare__picker--a select');
  const pickerB = compare.locator('.parcel-compare__picker--b select');
  const pathA = compare.locator('.parcel-compare-svg__take--a');
  const pathB = compare.locator('.parcel-compare-svg__take--b');
  const firstA = await pathA.getAttribute('d');
  const firstB = await pathB.getAttribute('d');

  await selectNativeOption(pickerA, ids[2]);
  await expect(pickerA).toHaveValue(ids[2]);
  await expect.poll(() => pathA.getAttribute('d')).not.toBe(firstA);
  const structureRow = compare.getByRole('row').filter({ hasText: 'Park / square / lake' });
  await expect(structureRow.locator('.parcel-compare__cell--a')).toContainText('Park');

  await selectNativeOption(pickerB, ids[0]);
  await expect(pickerB).toHaveValue(ids[0]);
  await expect.poll(() => pathB.getAttribute('d')).not.toBe(firstB);
  await expect(structureRow.locator('.parcel-compare__cell--b')).toContainText('Park');
  await expect(compare).toContainText('Small park plan');
  await expect(compare).toContainText('Full park plan');
});
