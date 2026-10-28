import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, publishOn, stackSection, PARCEL_ID } from '../helpers/runtime';

async function openDetails(page: any) {
  await openCity(page);
  await openParcel(page);
  await expect(page.locator('#info-tab')).toBeVisible();
}

const tab = (page: any, id: string) => page.locator(`#parcel-info-panel .parcel-tab-btn[data-parcel-tab-id="${id}"]`);

// In the click stack the parcel panel shows Info · Propose (the build palette) · Tools (an icon);
// the parcel's proposals are the stack's Designs section, so its Proposals tab, − and × are hidden.
test.describe('Parcel info panel tabs @core', () => {
  test('Info tab ends with the collapsed History section', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#info-tab')).toBeVisible();
    for (const id of ['propose-tab', 'proposals-tab', 'tools-tab']) await expect(page.locator(`#${id}`)).toBeHidden();
    const history = page.locator(`#parcel-history-section details[data-parcel-history="${PARCEL_ID}"]`);
    await expect(history).toBeVisible();
    await expect(history).not.toHaveAttribute('open', '');
  });

  test('in the stack the panel has no Proposals tab, − or ×; the stack folds and closes it', async ({ mockApi: page }) => {
    await openDetails(page);
    const panel = page.locator('#parcel-info-panel');
    await expect(tab(page, 'info-tab')).toBeVisible();
    await expect(tab(page, 'propose-tab')).toBeVisible();
    await expect(tab(page, 'tools-tab')).toBeVisible();
    await expect(tab(page, 'proposals-tab')).toBeHidden();
    await expect(panel.locator('#parcel-info-minimize')).toBeHidden();
    await expect(panel.locator('.panel-header .close-button')).toBeHidden();
    // The section's row folds the parcel; Escape closes the spot.
    await stackSection(page, 'parcels').locator('.click-stack__row').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#click-stack')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#click-stack')).toBeHidden();
  });

  test('Design holds the palette', async ({ mockApi: page }) => {
    await openDetails(page);
    await tab(page, 'propose-tab').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    // 13 tools: 8 design tiles; transport Road, Road in parcel, Track, Road station, Track station.
    await expect(page.locator('#propose-content .parcel-build-btn')).toHaveCount(13);
  });

  test('a parcel with no proposals has no Designs section', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(stackSection(page, 'designs')).toHaveCount(0);
  });

  test('the Designs section lists the proposals on the parcel when the click is on its open ground', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    // Off the map the park stays stored and declared on the parcel, whose own layer returns.
    await page.evaluate(id => (window as any).removeProposalFromMap(id), parkId);
    await expect.poll(() => page.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), PARCEL_ID)).toBe(true);
    await expect.poll(() => page.evaluate(id => !(window as any).isProposalApplied((window as any).getProposalByIdOrHash(id)), parkId)).toBe(true);
    await page.evaluate(() => (window as any).hideProposalDetailsPanel?.(true));
    await openParcel(page);
    // The parcel stays the open section; its proposal waits in the Designs row above it.
    const designs = stackSection(page, 'designs');
    await expect(designs.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'false');
    await expect(designs.locator('.click-stack__row-title')).toHaveText('Design');
    await designs.locator('.click-stack__row').click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(designs.locator('#proposal-details-panel')).toBeVisible();
  });

  test('a published proposal on the parcel is listed without being in this browser, and opening it imports it', async ({ mockApi: page }) => {
    const publishedCid = await publishOn(page, PARCEL_ID);
    await openDetails(page);
    const designs = stackSection(page, 'designs');
    await expect(designs.locator('.click-stack__row-detail')).toHaveText('Published park');
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
    await designs.locator('.click-stack__row').click();
    await expect(designs.locator('#proposal-details-panel')).toContainText('Published park');
    await expect.poll(() => page.evaluate(cid => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.published?.cid === cid), publishedCid)).toBe(true);
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
    await tab(page, 'propose-tab').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    await tab(page, 'info-tab').click();
    await expect(page.locator('#info-tab')).toBeVisible();
    await expect(page.locator('#info-content')).toBeVisible();
  });

  test('manual selection mode remains available above the tabs', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#parcel-manual-selection')).toHaveAttribute('aria-pressed', 'false');
  });
});
