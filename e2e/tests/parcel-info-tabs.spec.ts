import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, publishOn, clickMapPoint, stackSection, parcelTab, PARCEL_ID } from '../helpers/runtime';

async function openDetails(page: any) {
  await openCity(page);
  await openParcel(page);
  await expect(page.locator('#info-tab')).toBeVisible();
}

const tab = (page: any, id: string) => page.locator(`#parcel-info-panel .parcel-tab-btn[data-parcel-tab-id="${id}"]`);

// Info · Propose (the build palette) · Proposals (what already stands here, with a count) · Tools (an icon).
test.describe('Parcel info panel tabs @core', () => {
  test('Info tab is active by default and ends with the collapsed History section', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#info-tab')).toBeVisible();
    for (const id of ['propose-tab', 'proposals-tab', 'tools-tab']) await expect(page.locator(`#${id}`)).toBeHidden();
    const history = page.locator(`#parcel-history-section details[data-parcel-history="${PARCEL_ID}"]`);
    await expect(history).toBeVisible();
    await expect(history).not.toHaveAttribute('open', '');
  });

  test('Propose holds the palette and Proposals the list, never both', async ({ mockApi: page }) => {
    await openDetails(page);
    await tab(page, 'propose-tab').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    // 14 tools: the Ownership group's Offer went with owner offers (M2).
    await expect(page.locator('#propose-content .parcel-build-btn')).toHaveCount(14);
    await tab(page, 'proposals-tab').click();
    await expect(page.locator('#proposals-tab')).toBeVisible();
    await expect(page.locator('#proposals-content .parcel-build-btn')).toHaveCount(0);
  });

  test('an empty Proposals tab says so and its Propose here opens the palette', async ({ mockApi: page }) => {
    await openDetails(page);
    await tab(page, 'proposals-tab').click();
    await expect(page.locator('#proposals-content .parcel-proposals-empty')).toContainText('No proposals on this parcel yet.');
    await expect(tab(page, 'proposals-tab').locator('.parcel-tab-count')).toBeHidden();
    await page.locator('#proposals-content .parcel-proposals-empty-btn').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    await expect(page.locator('#propose-content .parcel-build-palette')).toBeVisible();
  });

  test('the Proposals tab counts and lists the proposals on the parcel', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    // Off the map the park stays stored and declared on the parcel, whose own layer returns.
    await page.evaluate(id => (window as any).removeProposalFromMap(id), parkId);
    await expect.poll(() => page.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), PARCEL_ID)).toBe(true);
    await expect.poll(() => page.evaluate(id => !(window as any).isProposalApplied((window as any).getProposalByIdOrHash(id)), parkId)).toBe(true);
    await page.evaluate(() => (window as any).hideProposalDetailsPanel?.(true));
    await openParcel(page);
    await expect(tab(page, 'proposals-tab').locator('.parcel-tab-count')).toHaveText('1');
    await tab(page, 'proposals-tab').click();
    await expect(page.locator('#proposals-content .proposal-item')).toHaveCount(1);
    await expect(page.locator('#proposals-content .parcel-proposals-empty')).toHaveCount(0);
  });

  test('proposals published on the parcel are counted and listed without being in this browser', async ({ mockApi: page }) => {
    const publishedCid = await publishOn(page, PARCEL_ID);
    await openDetails(page);
    await expect(tab(page, 'proposals-tab').locator('.parcel-tab-count')).toHaveText('1');
    await tab(page, 'proposals-tab').click();
    await expect(page.locator(`#proposals-content [data-server-id="${publishedCid}"]`)).toContainText('Published park');
    await expect(page.locator('#proposals-content .parcel-proposals-empty')).toBeHidden();
  });

  test('the Tools icon tab shows claim controls', async ({ mockApi: page }) => {
    await openDetails(page);
    await page.locator('#parcel-info-panel').getByRole('tab', { name: 'Tools', exact: true }).click();
    await expect(page.locator('#tools-tab')).toBeVisible();
    await expect(page.locator('#claimButton')).toBeDisabled();
    await expect(page.locator('#mintAndClaimButton')).toBeDisabled();
  });

  test('switching back restores Info content', async ({ mockApi: page }) => {
    await openDetails(page);
    await tab(page, 'proposals-tab').click();
    await expect(page.locator('#proposals-tab')).toBeVisible();
    await tab(page, 'info-tab').click();
    await expect(page.locator('#info-tab')).toBeVisible();
    await expect(page.locator('#info-content')).toBeVisible();
  });

  test('multi-select checkbox is available in Info content', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#multiSelectCheckboxInfo')).toHaveAttribute('type', 'checkbox');
  });
});

// The click stack's parcel section carries the Proposals action: it counts what stands on the
// parcel, the designs index's published ones included, and opens the panel's Proposals tab on them.
test.describe('Parcel section proposals @features', () => {
  test('the parcel section counts the proposals here, published ones included, and opens the Proposals tab', async ({ mockApi: page }) => {
    const cid = await publishOn(page, PARCEL_ID);
    await openCity(page);
    const center = await page.evaluate((id: string) => {
      const w = window as any;
      const c = w.ParcelPresenter.getLayer(id).getBounds().getCenter();
      w.map.panTo(c, { animate: false });
      return { lng: c.lng, lat: c.lat };
    }, PARCEL_ID);
    await clickMapPoint(page, center.lng, center.lat);
    await expect(stackSection(page, 'parcels').locator('#parcel-info-panel')).toBeVisible();
    const item = parcelTab(page, 'proposals-tab');
    await expect(item.locator('.parcel-tab-count')).toHaveText('1');
    await item.click();
    await expect(page.locator('#proposals-tab')).toBeVisible();
    await expect(page.locator('#proposals-content .parcel-set-proposal')).toHaveCount(1);
    await expect(page.locator(`#proposals-content [data-server-id="${cid}"]`)).toContainText('Published park');
  });
});
