// Audits current land-readjustment UX and persisted parcel ownership through visible app controls.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import type { Page, TestInfo } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

const fullUnequalLayout = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { label: 'One-third plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9819,45.8],[15.9821,45.8],[15.9821,45.8005],[15.9819,45.8005],[15.9819,45.8]]] } },
    { type: 'Feature', properties: { label: 'Two-thirds plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9821,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9821,45.8005],[15.9821,45.8]]] } },
  ],
};

async function openReadjustment(page: Page) {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--reparcellization').click();
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return modal;
}

async function uploadGeoJson(page: Page, name: string, value: string | object) {
  const modal = page.locator('.on-map-reparcellization');
  await modal.locator('[data-reparcel-upload]').setInputFiles({
    name,
    mimeType: 'application/geo+json',
    buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: '390px', width: 390, height: 844 }]) {
  test(`readjustment before/after comparison drags and cleans up on close/reopen at ${size.name}`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const modal = await openReadjustment(page);
    await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
    await uploadGeoJson(page, 'comparison.geojson', fullUnequalLayout);
    await expect(modal.locator('[data-reparcel-compare]')).toBeVisible();
    await modal.locator('[data-reparcel-compare]').click();
    const map = page.locator('#map-container');
    const handle = map.locator('.map-compare__handle');
    await expect(map.locator('.map-compare__before')).toBeVisible();
    const initial = await handle.evaluate(node => Number.parseFloat((node as HTMLElement).style.left));
    const handleBox = await handle.boundingBox();
    const mapBox = await map.boundingBox();
    if (!handleBox || !mapBox) throw new Error('Compare slider or readjustment map has no visible bounds');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + mapBox.width * 0.72, handleBox.y + handleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => handle.evaluate(node => Number.parseFloat((node as HTMLElement).style.left))).not.toBe(initial);
    await attachScreenshot(page, testInfo, `${size.name}-comparison-drag.png`);

    await modal.locator('[data-reparcel-compare]').click();
    await expect(map.locator('.map-compare__before')).toHaveCount(0);
    await expect(map.locator('.map-compare__handle')).toHaveCount(0);
    await modal.locator('[data-reparcel-compare]').click();
    await expect(map.locator('.map-compare__before')).toBeVisible();
    const reopenedPosition = Number.parseFloat(await map.locator('.map-compare__handle').evaluate(node => (node as HTMLElement).style.left));
    expect(reopenedPosition).toBeCloseTo(mapBox.width / 2, 0);

    await modal.locator('[data-reparcel-cancel]').click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.map-compare__before, .map-compare__handle, .map-compare__label')).toHaveCount(0);
    // Re-open through the parcel action so the cleanup assertion covers the editor lifecycle too.
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const reopened = page.locator('.on-map-reparcellization');
    await expect(reopened.locator('.on-map-editor__panel')).toBeVisible();
    await expect(reopened.locator('.map-compare__before, .map-compare__handle, .map-compare__label')).toHaveCount(0);
    await attachScreenshot(page, testInfo, `${size.name}-reopened-clean.png`);
  });
}

test('before/after comparison handle is keyboard accessible and responds to arrow keys', async ({ mockApi: page }) => {
  await openReadjustment(page);
  const modal = page.locator('.on-map-reparcellization');
  await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
  await uploadGeoJson(page, 'keyboard.geojson', fullUnequalLayout);
  await modal.locator('[data-reparcel-compare]').click();
  const slider = page.locator('#map-container [role="slider"]');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('tabindex', '0');
  await expect(slider).toHaveAttribute('aria-label', /before.*after|comparison/i);
  const before = await slider.evaluate(node => Number.parseFloat((node as HTMLElement).style.left));
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => slider.evaluate(node => Number.parseFloat((node as HTMLElement).style.left))).toBeGreaterThan(before);
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuenow', '100');
  await page.keyboard.press('PageDown');
  await expect(slider).toHaveAttribute('aria-valuenow', '90');
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(() => slider.evaluate(node => {
    const handle = node as HTMLElement;
    return Number.parseFloat(handle.style.left) / handle.parentElement!.clientWidth;
  })).toBeCloseTo(0.9, 2);
});

test('invalid GeoJSON changes nothing and partial coverage keeps Done disabled', async ({ mockApi: page }) => {
  const modal = await openReadjustment(page);
  await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
  // Draw freely starts from the complete automatic layout, so Done stays available until an edit
  // leaves land unassigned.
  const rows = () => modal.locator('.reparcel-newplots-list tbody tr').allInnerTexts();
  await expect.poll(async () => (await rows()).length).toBeGreaterThan(1);
  const layout = await rows();

  await uploadGeoJson(page, 'broken.geojson', '{ this is not JSON');
  await expect(modal.locator('[data-reparcel-status]')).toContainText(/parse|invalid/i);
  expect(await rows()).toEqual(layout);

  const partial = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[15.9819,45.8],[15.9821,45.8],[15.9821,45.8005],[15.9819,45.8005],[15.9819,45.8]]] } }],
  };
  await uploadGeoJson(page, 'partial.geojson', partial);
  await expect(modal.locator('[data-reparcel-status]')).toContainText(/Loaded 1 polygons/);
  await expect(modal.locator('[data-reparcel-coverage]')).toContainText(/unassigned/i);
  await expect(modal.locator('[data-reparcel-commit]')).toBeDisabled();
});

test('joint imported ownership survives apply and reload, then unapply restores the input parcel', async ({ mockApi: page }, testInfo) => {
  await page.route('**/parcels**', route => {
    if (!['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
    const data = JSON.parse(JSON.stringify(sampleParcels));
    const input = data.features.find((feature: any) => feature.properties.parcelId === PARCEL_ID);
    input.properties.owners = [{ name: 'Joint owner A', share: '1/2' }, { name: 'Joint owner B', share: '1/2' }];
    input.properties.ownershipDetails = { owners: [
      { name: 'Joint owner A', ownerLabel: 'Joint owner A', percentageShare: 50, actualShareText: '50%' },
      { name: 'Joint owner B', ownerLabel: 'Joint owner B', percentageShare: 50, actualShareText: '50%' },
    ] };
    return route.fulfill({ json: data });
  });
  await page.route('**/parcel-ownership/**', route => route.fulfill({ json: {
    contract: 'parcel-ownership/1',
    owners: [
      { name: 'Joint owner A', shareText: '1/2', sharePercent: 50, ownerType: 'private individual' },
      { name: 'Joint owner B', shareText: '1/2', sharePercent: 50, ownerType: 'private individual' },
    ],
  } }));
  const modal = await openReadjustment(page);
  await modal.locator('input[name="reparcel-algorithm"][value="manual"]').check({ force: true });
  await uploadGeoJson(page, 'unequal-plots.geojson', fullUnequalLayout);
  const rows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
  await expect(rows).toHaveCount(2);

  await modal.locator('[data-reparcel-assign]').click();
  // Reparcellization output now renders in its dedicated Leaflet pane, outside the generic overlay pane.
  await page.locator('#map .leaflet-reparcelPlots-pane path.leaflet-interactive').first().click();
  const popup = page.locator('.reparcel-owner-popup');
  await expect(popup).toBeVisible();
  await popup.locator('.reparcel-owner-popup__row').filter({ hasText: 'Owner B' }).locator('input').check();
  await popup.locator('.reparcel-owner-popup__close').click();
  await modal.locator('[data-reparcel-commit]').click();
  await expect(modal).toHaveCount(0);

  const plan = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.applied && proposal.reparcellization))));
  expect(plan.reparcellization.polygons).toHaveLength(2);
  const jointPlot = plan.reparcellization.polygons.find((plot: any) => plot.owners?.length === 2);
  expect(jointPlot).toBeTruthy();
  expect(jointPlot.owners.map((owner: any) => owner.displayName).sort()).toEqual(['Owner A', 'Owner B']);
  expect(jointPlot.owners.reduce((sum: number, owner: any) => sum + owner.share, 0)).toBeCloseTo(1, 8);
  const outputOwners = () => page.evaluate(({ inputId, proposalId }) => (window as any).LiveParcelFabric.entriesForCadastre([inputId])
    .filter((feature: any) => String(feature.properties?.producedByProposalId) === proposalId)
    .map((feature: any) => feature.properties?.ownershipDetails?.owners)
    .filter(Boolean), { inputId: PARCEL_ID, proposalId: plan.proposalId });
  await expect.poll(outputOwners).toHaveLength(2);
  const jointOutput = (await outputOwners()).find((owners: any[]) => owners.length === 2);
  // Soft assertions keep the reload/unapply checks running even when current apply loses owners.
  expect.soft(jointOutput, 'The applied joint plot must retain both recipients').toBeTruthy();
  if (jointOutput) expect.soft(jointOutput.reduce((sum: number, owner: any) => sum + owner.percentageShare, 0)).toBeCloseTo(100, 6);
  const soleOwnerOutput = (await outputOwners()).find((owners: any[]) => owners.length === 1 && owners[0].name === 'Owner B');
  expect(soleOwnerOutput).toBeTruthy();
  expect.soft(soleOwnerOutput[0].percentageShare, 'A sole recipient owns the whole output plot').toBeCloseTo(100, 6);
  await attachScreenshot(page, testInfo, 'joint-ownership-applied.png');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).ProposalManager?._initialReapplyDone === true);
  await expect.poll(outputOwners).toHaveLength(2);
  const reloadedJoint = (await outputOwners()).find((owners: any[]) => owners.length === 2);
  expect.soft(reloadedJoint, 'Reload must restore both recipients').toBeTruthy();
  if (reloadedJoint) expect.soft(reloadedJoint).toEqual(jointOutput);
  expect.soft((await outputOwners()).find((owners: any[]) => owners.length === 1 && owners[0].name === 'Owner B')?.[0].percentageShare).toBeCloseTo(100, 6);

  await page.locator('#proposals-button').click();
  const item = page.locator(`#proposals-sheet .proposal-list-item[data-proposal-id="${plan.proposalId}"]`);
  await item.locator('.proposal-list-details-btn').click();
  const inspector = page.locator('#planning-inspector');
  await expect(inspector).toBeVisible();
  // The proposal action menu is opened from the current Planning inspector.
  await inspector.getByRole('button', { name: 'Proposal actions', exact: true }).click();
  await expect(page.locator('#proposal-details-panel')).toBeVisible();
  await page.locator(`#proposal-details-footer [id="proposal-action-btn-${plan.proposalId}"]`).click();
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.applied, plan.proposalId)).toBe(false);
  await expect.poll(outputOwners).toHaveLength(0);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
});

// Real browser touch input exercises the pointer controller and its touch-cancel cleanup.
test.describe('touch before/after comparison', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('before/after divider follows a touch drag and ignores movement after cancellation', async ({ mockApi: page }, testInfo) => {
    const modal = await openReadjustment(page);
    await modal.locator('[data-reparcel-compare]').click();
    // The comparison handle is attached to the shared map, not nested inside the editor dock.
    const slider = page.locator('#map .map-compare__handle[role="slider"][aria-label="Before and after comparison"]');
    const map = page.locator('#map-container');
    const box = await map.boundingBox();
    const grip = await slider.locator('.map-compare__grip').boundingBox();
    if (!box || !grip) throw new Error('Touch comparison has no visible bounds');
    const cdp = await page.context().newCDPSession(page);
    const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, x: box.x + box.width * 0.75 }] });
    await expect.poll(() => slider.getAttribute('aria-valuenow').then(Number)).toBeCloseTo(75, 0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    const value = await slider.getAttribute('aria-valuenow');
    await page.mouse.move(box.x + box.width * 0.2, start.y);
    await expect(slider).toHaveAttribute('aria-valuenow', value!);
    await attachScreenshot(page, testInfo, 'touch-comparison.png');
    await cdp.detach();
  });
});

test('cash-only edits retain cents and require confirmation before discarding', async ({ mockApi: page }) => {
  const modal = await openReadjustment(page);
  const cash = modal.locator('.cash-offer-input').first();
  await cash.fill('12.34');
  await expect(cash).toHaveValue('12.34');
  await modal.locator('[data-reparcel-cancel]').click();
  await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((record: any) => record.reparcellization).length)).toBe(0);
});
