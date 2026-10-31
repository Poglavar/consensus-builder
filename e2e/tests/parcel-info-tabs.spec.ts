import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, publishOn, parcelTab, stackSection, PARCEL_ID } from '../helpers/runtime';

async function openDetails(page: any) {
  await openCity(page);
  await openParcel(page);
  await parcelTab(page, 'info-tab').click();
  await expect(page.locator('#info-tab')).toBeVisible();
}

// In the click stack the parcel panel promotes its native tabs. A single parcel has no selected-
// parcels page, and the stack controls folding and closing instead of the panel's − and ×.
test.describe('Parcel info panel tabs @core', () => {
  test('Info tab ends with the collapsed History section', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#info-tab')).toBeVisible();
    for (const id of ['propose-tab', 'proposals-tab', 'tools-tab']) await expect(page.locator(`#${id}`)).toBeHidden();
    const history = page.locator(`#parcel-history-section details[data-parcel-history="${PARCEL_ID}"]`);
    await expect(history).toBeVisible();
    await expect(history).not.toHaveAttribute('open', '');
  });

  test('the stack promotes Actions, Info, Designs and Tools; its row folds and closes the panel', async ({ mockApi: page }) => {
    await openDetails(page);
    const panel = page.locator('#parcel-info-panel');
    for (const id of ['propose-tab', 'info-tab', 'proposals-tab', 'tools-tab']) await expect(parcelTab(page, id)).toBeVisible();
    await expect(panel.locator('[data-parcel-tab-id="selected-parcels-tab"]')).toBeHidden();
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
    await parcelTab(page, 'propose-tab').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    // 13 tools: 8 design tiles; transport Road, Road in parcel, Track, Road station, Track station.
    await expect(page.locator('#propose-content .parcel-build-btn')).toHaveCount(13);
  });

  test('a parcel with no proposals keeps an empty Designs tab', async ({ mockApi: page }) => {
    await openDetails(page);
    await parcelTab(page, 'proposals-tab').click();
    await expect(page.locator('#proposals-content')).toContainText('No designs');
    await page.locator('.parcel-proposals-empty-btn').click();
    await expect(parcelTab(page, 'propose-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.parcel-build-btn--park')).toBeVisible();
  });

  test('the native Designs tab keeps type, author and status when a proposal is on open ground', async ({ mockApi: page }) => {
    await openCity(page);
    const parkId = await createSpace(page, 'park');
    // Off the map the park stays stored and declared on the parcel, whose own layer returns.
    await page.evaluate(id => (window as any).removeProposalFromMap(id), parkId);
    await expect.poll(() => page.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), PARCEL_ID)).toBe(true);
    await expect.poll(() => page.evaluate(id => !(window as any).isProposalApplied((window as any).getProposalByIdOrHash(id)), parkId)).toBe(true);
    await page.evaluate(() => (window as any).hideProposalDetailsPanel?.(true));
    await openParcel(page);
    await parcelTab(page, 'proposals-tab').click();
    const designs = page.locator('#proposals-content');
    const row = designs.locator(`article[data-proposal-id="${parkId}"]`);
    await expect(row).toContainText('Park');
    await expect(row.locator('.proposal-author-value')).toBeVisible();
    await expect(row.locator('.proposal-item-badges')).toBeVisible();
    await expect(row.locator('.proposal-item-channel, .proposal-item-takes')).toHaveCount(0);
    await expect(designs.locator('.parcel-dossier-remainder')).toHaveCount(0);
    await row.getByRole('button', { name: /Open Park/i }).click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
  });

  test('a published proposal on the parcel is listed without being in this browser, and opening it imports it', async ({ mockApi: page }) => {
    const publishedCid = await publishOn(page, PARCEL_ID);
    await openDetails(page);
    await parcelTab(page, 'proposals-tab').click();
    const designs = page.locator('#proposals-content');
    const row = designs.locator(`[data-server-id="${publishedCid}"]`);
    await expect(row).toContainText('Published park');
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
    await row.getByRole('button', { name: 'Open Published park' }).click();
    await expect(page.locator('#proposal-details-panel')).toContainText('Published park');
    await expect.poll(() => page.evaluate(cid => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.published?.cid === cid), publishedCid)).toBe(true);
  });

  test('the Tools icon tab shows claim controls', async ({ mockApi: page }) => {
    await openDetails(page);
    await parcelTab(page, 'tools-tab').click();
    await expect(page.locator('#tools-tab')).toBeVisible();
    await expect(page.locator('#claimButton')).toBeDisabled();
    await expect(page.locator('#mintAndClaimButton')).toBeDisabled();
  });

  test('switching back restores Info content', async ({ mockApi: page }) => {
    await openDetails(page);
    await parcelTab(page, 'propose-tab').click();
    await expect(page.locator('#propose-tab')).toBeVisible();
    await parcelTab(page, 'info-tab').click();
    await expect(page.locator('#info-tab')).toBeVisible();
    await expect(page.locator('#info-content')).toBeVisible();
  });

  test('manual selection mode remains available above the tabs', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#parcel-manual-selection')).toHaveAttribute('aria-pressed', 'false');
  });
});
