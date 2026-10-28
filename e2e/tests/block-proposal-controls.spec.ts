import { openLayerSection } from '../helpers/layers';
import { selectNativeOption } from '../helpers/controls';
// Exercise all proposal kinds in the block inspector against one consistent cadastral fixture.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, drawCorridor, proposalState } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

// Keep the authored proposal and block on the same cadastral ground throughout the test.
const ids = ['HR-335754-1234', 'HR-335754-1235'];

async function installBlockGround(page: Page) {
  const features = structuredClone(sampleParcels.features.slice(0, 2));
  features[1].geometry.coordinates[0].forEach(point => { if (point[0] === 15.9826) point[0] = 15.9825; });
  await page.route('**/parcels**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/\/parcels(?:\/parcelIds)?$/.test(url.pathname)) return route.continue();
    const requested = url.searchParams.get('ids')?.split(',');
    return route.fulfill({ json: { type: 'FeatureCollection', features: features.filter(feature => !requested || requested.includes(feature.properties.parcelId)) } });
  });
}

async function openBlock(page: Page) {
  // Applying a proposal replaces its host parcel. The unchanged neighbour remains a valid seed
  // for detecting the current block instead of reopening a stale block from before the mutation.
  await openParcel(page, 'info', ids[1]);
  await page.locator('#layers-button').click();
  const tools = page.locator('#layers-sheet details.accordion-section[data-section="blocks"]');
  if (!(await tools.evaluate((element: HTMLDetailsElement) => element.open))) await tools.locator('> summary').click();
  await tools.locator('[onclick="animateFloodfillFromSelected()"]').click();
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels])).toContain(ids[1]);
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await tools.locator('[onclick="countBlocks()"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBeGreaterThan(0);
  await page.locator('#showBlockListButton').click();
  await page.locator('#blocks-content .block-item').first().click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
  await expect(page.locator('#block-info-panel')).toBeVisible();
  await expect(page.locator('#parcel-info-panel')).toBeHidden();
  return page.evaluate(() => JSON.parse(document.querySelector('#block-info-title')!.getAttribute('data-i18n-params')!).name);
}

async function createBlockFixture(page: Page, kind: 'road' | 'building' | 'park') {
  if (kind === 'road') return drawCorridor(page, 'road');
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind === 'building' ? 'buildings' : kind}`).click();
  // This fixture has an adjacent parcel, so the app correctly asks which extent to author.
  await page.getByRole('alertdialog').getByRole('button', { name: 'No, just this parcel', exact: true }).click();
  if (kind === 'building') {
    await selectNativeOption(page.locator('#blockify-ruletype-select'), 'exact');
    await expect(page.locator('#btn-blockify-done')).toBeEnabled();
    await page.locator('#btn-blockify-done').click();
  }
  await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals()
    .some((proposal: any) => proposal.applied && (kind === 'building' ? proposal.geometry?.buildings?.length : proposal.structureProposal?.kind === kind)), kind)).toBe(true);
  return page.evaluate(kind => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => kind === 'building' ? proposal.geometry?.buildings?.length : proposal.structureProposal?.kind === kind).proposalId, kind);
}

for (const kind of ['road', 'building', 'park'] as const) {
  test(`block proposal ${kind} Apply, Remove, and Delete change the saved proposal and map`, async ({ mockApi: page }) => {
    await installBlockGround(page);
    await openCity(page);
    await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), ids);
    const id = await createBlockFixture(page, kind);
    await page.locator('#proposals-button').click();
    await page.locator(`#proposals-sheet .proposal-list-item[data-proposal-id="${id}"] .proposal-list-details-btn`).click();
    // The current list action opens the Planning inspector first; use its explicit action to
    // reach proposal map controls while preserving the list-navigation path under test.
    const inspector = page.locator('#planning-inspector');
    if (await inspector.isVisible()) await inspector.getByRole('button', { name: 'Proposal actions', exact: true }).click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    const action = page.locator(`#proposal-details-footer [id="proposal-action-btn-${id}"]`);
    // Keep the selected record identity explicit through the details action; the trace confirms
    // the action key is the same canonical ID returned by proposalStorage.addProposal().
    await expect(action).toHaveAttribute('id', `proposal-action-btn-${id}`);
    await action.click();
    await expect.poll(async () => (await proposalState(page, id)).applied).toBe(false);
    const closeDetails = page.locator('#proposal-details-close');
    if (await closeDetails.isVisible()) await closeDetails.click();

    const name = await openBlock(page);
    // Associate the authored fixture with the detected block; application and removal stay real.
    await page.evaluate(({ id, name }) => {
      const storage = (window as any).proposalStorage;
      const proposal = storage.getProposal(id);
      if (proposal.buildingProposal) proposal.buildingProposal.blockName = name;
      else if (proposal.structureProposal) proposal.structureProposal.blockName = name;
      else proposal.properties = { ...proposal.properties, block: name };
      storage.save();
    }, { id, name });
    // The inspector rendered before this fixture metadata was assigned. Open it from the list
    // again, as a user would when revisiting a block, so it reads the updated stored record.
    await page.locator('#block-info-panel .close-button').click();
    await openLayerSection(page, 'blocks');
    await page.locator('#blocks-content .block-item').first().click();
    await expect(page.locator('#layers-sheet')).toBeHidden();
    await page.locator('#block-proposals-tab-button').click();
    const row = page.locator(`#block-proposals-content .proposal-list-item[data-proposal-id="${id}"]`);
    await row.getByRole('button', { name: /Apply to map$/ }).click();
    await expect.poll(async () => (await proposalState(page, id)).applied).toBe(true);
    // The inspector refreshes its own row after applying; the inverse action must be usable here.
    await expect(row.getByRole('button', { name: /Remove from map$/ })).toBeVisible();
    await row.locator('button[onclick*="removeProposalFromMap"]').click();
    await expect.poll(async () => (await proposalState(page, id)).applied).toBe(false);
    await expect(row.locator('button[onclick*="applyProposalToMap"]')).toBeVisible();
    await row.getByTitle('Delete design', { exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    if (await confirmation.isVisible()) await confirmation.getByRole('button', { name: /Delete|Yes/i }).click();
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), id)).toBe(false);
    await expect(row).toHaveCount(0);
  });
}

test('block Create design opens a design for every parcel of the chosen block', async ({ mockApi: page }) => {
  await installBlockGround(page);
  await openCity(page);
  await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), ids);
  const name = await openBlock(page);
  const expected = await page.evaluate(name => [...(window as any).blockStorage.blocks.get(name).parcelIds].sort(), name);
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name: 'Create design', exact: true }).click();
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
  expect(await page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual(expected);
  await expect(page.locator('.create-proposal-modal:visible .proposal-parcel-item')).toHaveCount(expected.length);
});
