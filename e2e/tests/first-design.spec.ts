import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, expandStackSection, openCity, PARCEL_ID } from '../helpers/runtime';

test('a phone map click leads to a saved park at the top of Designs', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await expect(page.locator('#map-shell-bottom-right').getByRole('button')).toHaveCount(3);
  await clickMapPoint(page, 15.9822, 45.80025);
  await expandStackSection(page, 'parcels');
  const park = page.locator('#click-stack').getByRole('button', { name: 'Park', exact: true });
  await park.click();
  await page.getByRole('button', { name: 'Use this parcel', exact: true }).press('Enter');
  const localPark = () => page.evaluate(() => (window as any).proposalStorage?.getAllProposals()
    .find((record: any) => record.structureProposal?.kind === 'park'));
  await expect.poll(localPark).toMatchObject({ applied: true, cadastreParcelIds: [PARCEL_ID] });
  const { proposalId, title } = await localPark();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(localPark).toMatchObject({ proposalId, applied: true });
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Lists', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create plan', exact: true })).toBeVisible();
  await expect(page.locator('#proposal-list-host .lists-item').first()).toContainText(title);
});
