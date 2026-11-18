import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, expandStackSection, openCity, PARCEL_ID } from '../helpers/runtime';

test('Design leads from a map click to a saved park in Lists', async ({ mockApi: page }) => {
  await openCity(page);
  await page.getByRole('button', { name: 'Design', exact: true }).press('Enter');
  const start = page.getByRole('dialog', { name: 'Start a design' });
  await expect(start).toBeFocused();
  await expect(start).toContainText('Select a parcel on the map');
  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(start).toBeHidden();
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
  await page.getByRole('button', { name: 'Lists', exact: true }).click();
  await expect(page.locator('#proposal-list-host .lists-item').first()).toContainText(title);
});

test('Design keeps the phone map reachable and opens the local guide and map search', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/?city=zg&lang=hr&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  const design = page.getByRole('button', { name: 'Dizajn', exact: true });
  await design.press('Enter');
  const start = page.getByRole('dialog', { name: 'Započni dizajn' });
  await expect(page.getByRole('button', { name: 'Popisi', exact: true })).toBeVisible();
  const box = await start.boundingBox();
  expect(box!.y).toBeGreaterThan(300);
  expect(box!.width).toBeLessThanOrEqual(360);
  const guide = start.locator('[data-user-guide]');
  const guideOpened = page.waitForEvent('popup');
  await guide.press('Enter');
  const help = await guideOpened;
  await expect(help).toHaveURL(/\/kako-koristiti\.html$/);
  await expect(help.locator('#tijek')).toContainText('Upotrijebi ovu česticu');
  await help.close();
  await start.getByRole('button', { name: 'Pretraži kartu' }).press('Enter');
  await expect(start).toBeHidden();
  await expect(page.locator('#map-search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await design.press('Enter');
  await page.keyboard.press('Escape');
  await expect(start).toBeHidden();
  await expect(design).toBeFocused();
});
