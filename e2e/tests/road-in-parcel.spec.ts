// Road in parcel (docs/road-in-parcel.md): the parcel card's Transport tile fits a road into the
// selected parcel, its land exactly that parcel, with the lanes the author picks; ground that does not
// read as a street, and ground a road already holds, are refused.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, openParcelAt, parcelTab, expectStatusLogged, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { Page } from '@playwright/test';

// 225 m × 67 m: wider than any street, so it reads as a block, not as straight streets.
const BLOCK_PARCEL_ID = 'HR-335754-1238';

const panel = (page: Page) => page.locator('#road-in-parcel');
// The section is a zero-size host; its panel is what shows.
const panelBox = (page: Page) => panel(page).locator('.on-map-editor__panel');

async function openRoadInParcel(page: Page, parcelId: string) {
  await openParcel(page, 'design', parcelId);
  await page.locator('#parcel-info-panel .parcel-transport-btn--roadInParcel').click();
  await expect(panelBox(page)).toBeVisible();
}

// Applied road designs, in their view form, with what their lanes and land are.
async function appliedRoads(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().filter((p: any) => p.roadProposal && w.isProposalApplied(p)).map((p: any) => {
      const definition = w.corridorProposalDefinition(p);
      const strips = w.corridorSegmentEntries(definition).flatMap((entry: any) => entry.profile?.strips || []);
      return {
        id: String(p.proposalId),
        mode: definition.metadata?.mode,
        site: definition.bound?.site || null,
        landM2: definition.polygon ? w.turf.area(definition.polygon) : null,
        lanes: strips.filter((strip: any) => strip.type === 'driving' || strip.type === 'bus').length,
      };
    });
  });
}

test.describe('Road in parcel @features', () => {
  test('fits a bounded road into the parcel with the chosen lanes, and its land is that parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await openRoadInParcel(page, PARCEL_ID);

    // One street along the parcel's length, previewed on the map, ready to place.
    await expect(panel(page).locator('.road-in-parcel__summary')).toHaveText('Streets: 1 · parcels: 1');
    await expect(panel(page).locator('[data-action="turn"]')).toBeHidden();
    await expect(panel(page).locator('.road-in-parcel__status')).toHaveText('');
    await expect(page.locator('#map path.road-in-parcel__site')).toHaveCount(1);
    const place = panel(page).locator('[data-action="place"]');
    await expect(place).toBeEnabled();

    // Pick lanes other than the automatic choice; the placed road must carry them.
    const lanes = panel(page).locator('select.road-in-parcel__lanes');
    await expect(lanes).toHaveCount(1);
    await expect(lanes).toHaveValue('');
    const option = lanes.locator('option').nth(1);
    const label = (await option.textContent()) || '';
    const chosenLanes = Number(label.match(/Lanes: (\d+)/)?.[1]);
    expect(chosenLanes).toBeGreaterThan(0);
    await lanes.selectOption({ index: 1 });
    await expect(lanes).toHaveValue((await option.getAttribute('value')) || 'missing');

    expect(await appliedRoads(page)).toEqual([]);
    await place.click();
    await expect(panel(page)).toHaveCount(0);
    await expectStatusLogged(page, 'Roads placed in the parcel: 1.');
    await expect(page.locator('#map path.road-in-parcel__site')).toHaveCount(0);

    const roads = await appliedRoads(page);
    expect(roads).toHaveLength(1);
    const [road] = roads;
    const parcel = sampleParcels.features.find(feature => feature.properties.parcelId === PARCEL_ID)!;
    expect(road.mode).toBe('bounded');
    expect(road.site).toEqual(parcel.geometry);
    expect(road.lanes).toBe(chosenLanes);
    // Its land is exactly the parcel: nothing beyond it is taken, nothing of it is left over.
    const parcelM2 = await page.evaluate(geometry => (window as any).turf.area(geometry), parcel.geometry);
    expect(road.landM2).not.toBeNull();
    expect(Math.abs(road.landM2! - parcelM2) / parcelM2).toBeLessThan(0.01);

    // The ground is now the road's: a second road cannot be fitted into it.
    await page.keyboard.press('Escape');
    const center = await page.evaluate(geometry => (window as any).turf.centroid(geometry).geometry.coordinates, parcel.geometry);
    await openParcelAt(page, center[0], center[1]);
    await parcelTab(page, 'propose-tab').click();
    await page.locator('#parcel-info-panel .parcel-transport-btn--roadInParcel').click();
    await expectStatusLogged(page, 'A road or track already holds this ground.');
    await expect(panel(page)).toHaveCount(0);
    expect(await appliedRoads(page)).toHaveLength(1);
  });

  test('refuses ground that does not read as straight streets, and Cancel leaves no road', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), BLOCK_PARCEL_ID);
    await openRoadInParcel(page, BLOCK_PARCEL_ID);

    await expect(panel(page).locator('.road-in-parcel__status')).toContainText('This ground does not read as straight streets.');
    await expect(panel(page).locator('.road-in-parcel__summary')).toHaveText('');
    await expect(panel(page).locator('[data-action="place"]')).toBeDisabled();

    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('#map path.road-in-parcel__site')).toHaveCount(0);
    expect(await appliedRoads(page)).toEqual([]);
  });
});
