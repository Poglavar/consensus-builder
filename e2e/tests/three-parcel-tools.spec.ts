// A parcel selected in the 3D model view offers the map's own design tools. Choosing one opens
// the 2D map on that parcel and starts the tool there.
import { test, expect } from '../helpers/fixtures';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { clickMapPoint, expandStackSection, openCity, PARCEL_ID } from '../helpers/runtime';

test('a tool chosen on a 3D parcel starts on the 2D map for that parcel', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await mockBuildingScene(page);
  await openCity(page);

  // The map's tools for this parcel are the reference: the scene must list the same ones.
  await clickMapPoint(page, 15.9822, 45.80025);
  await expandStackSection(page, 'parcels');
  const mapTools = await page.locator('#click-stack .parcel-build-btn').allInnerTexts();
  expect(mapTools.map(label => label.trim())).toContain('Park');

  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
  await page.evaluate(id => (window as any).showThreeModeParcel(id), PARCEL_ID);
  const parcel = page.locator('#three-click-stack .click-stack__section[data-kind="parcels"]');
  await expect(parcel).toHaveClass(/is-expanded/);

  // Actions leads, as on the map, and nothing sends the person away to find the tools.
  await expect(parcel.locator('[data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
  const tools = parcel.locator('.three-parcel-tools');
  await expect(tools.locator('.parcel-build-btn')).toHaveText(mapTools.map(label => label.trim()));
  await expect(parcel.getByRole('button', { name: 'Open actions in 2D', exact: true })).toHaveCount(0);

  await tools.getByRole('button', { name: 'Park', exact: true }).click();
  await page.getByRole('button', { name: 'Use this parcel', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__mapModeState?.desired)).toBe('2d');
  const localPark = () => page.evaluate(() => (window as any).proposalStorage?.getAllProposals()
    .find((record: any) => record.structureProposal?.kind === 'park'));
  await expect.poll(localPark).toMatchObject({ applied: true, cadastreParcelIds: [PARCEL_ID] });
  await expect(page.locator('#click-stack .click-stack__section[data-kind="designs"]')).toBeVisible();
});
