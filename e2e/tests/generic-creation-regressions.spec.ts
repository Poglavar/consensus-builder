import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, expectStatusLogged } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const ids = sampleParcels.features.slice(0, 2).map(f => f.properties.parcelId);
async function openGeneric(page: Page, one = false) {
  const features = structuredClone(sampleParcels.features.slice(0, one ? 1 : 2));
  if (!one) features[1].geometry.coordinates[0].forEach(p => { if (p[0] === 15.9826) p[0] = 15.9825; });
  await page.route('**/parcels**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/\/parcels(?:\/parcelIds)?$/.test(url.pathname)) return route.continue();
    const requested = url.searchParams.get('ids')?.split(',');
    return route.fulfill({ json: { type:'FeatureCollection', features: features.filter(f => !requested || requested.includes(f.properties.parcelId)) } });
  });
  await openCity(page);
  await page.evaluate(async selected => (window as any).CadastralParcelRepository.ensureIds(selected), one ? [ids[0]] : ids);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Creation regression tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await openParcel(page, 'info', one ? ids[0] : ids[1]);
  await page.locator('#layers-button').click();
  const section = page.locator('#layers-sheet details.accordion-section[data-section="blocks"]');
  if (!(await section.evaluate((el: HTMLDetailsElement) => el.open))) await section.locator('> summary').click();
  await section.locator('[onclick="animateFloodfillFromSelected()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBe(one ? 1 : 2);
  await section.locator('[onclick="countBlocks()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBeGreaterThan(0);
  await page.locator('#showBlockListButton').click();
  await page.locator('#blocks-content .block-item').first().click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name:'Create design', exact:true }).click();
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
}
for (const [typology, root, done] of [
  ['block', '#blockify-modal', '#btn-blockify-done'], ['row', '#rowhouse', '#btn-rowhouse-done'],
  ['parcelBased', '#parcelbased', '#btn-parcelbased-done']
] as const) {
  test(`generic ${typology} saves selected site and reopens geometry`, async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    await openGeneric(page);
    const form = page.locator('.create-proposal-modal:visible');
    await form.locator('.proposal-radio:has(input[name="proposalLandUse"][value="urban-rule"])').click();
    await form.locator(`[data-proposal-typology="${typology}"]`).click();
    await form.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
    await expect(page.locator(root).locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator(done)).toBeEnabled({timeout:30_000});
    await page.locator(done).click();
    const proceed = page.getByRole('button', {name:'Proceed anyway'});
    await expect.poll(async () => await form.isVisible() || await proceed.isVisible()).toBe(true);
    if (await proceed.isVisible()) await proceed.click();
    await expect(form).toBeVisible();
    await form.locator('#createProposalSubmitButton').click();
    await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((p: any) => p.buildingProposal?.typologyType === kind)?.proposalId, typology), {timeout:30_000}).toBeTruthy();
    const saved = await page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((p: any) => p.buildingProposal?.typologyType === kind), typology);
    expect(saved.site?.type).toMatch(/Polygon/);
    expect(saved.cadastreParcelIds.slice().sort()).toEqual(ids.slice().sort());
    await page.evaluate(id => (window as any).showProposalDetails(id), saved.proposalId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    await expect(page.locator(root).locator('.on-map-editor__panel')).toBeVisible({timeout:20_000});
    await expect(page.locator(done)).toBeEnabled({timeout:20_000});
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).site, saved.proposalId)).toEqual(saved.site);
  });
}
test('specific third-party recipient requires an address and accepts a retry', async ({ mockApi: page }) => {
  test.setTimeout(90_000); await openGeneric(page);
  const form = page.locator('.create-proposal-modal:visible');
  await form.locator('.proposal-radio:has(input[name="proposalOwnership"][value="third-party"])').click();
  await form.locator('.proposal-radio:has(input[name="proposalRecipientScope"][value="specific"])').click();
  await form.locator('#proposalName').fill('Recipient regression');
  await form.locator('#createProposalSubmitButton').click();
  const alert = page.getByRole('alertdialog');
  await expect(alert).toContainText('Enter a recipient name or address.');
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
  await alert.getByRole('button', {name:'OK'}).click();
  await form.locator('#proposalRecipientAddress').fill('0x0000000000000000000000000000000000000001');
  await form.locator('#createProposalSubmitButton').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.title === 'Recipient regression')?.ownershipTransferProposal?.recipientAddress)).toBe('0x0000000000000000000000000000000000000001');
});
test('generic Row refuses a one-parcel selection', async ({ mockApi: page }) => {
  test.setTimeout(90_000); await openGeneric(page, true);
  const form = page.locator('.create-proposal-modal:visible');
  await form.locator('.proposal-radio:has(input[name="proposalLandUse"][value="urban-rule"])').click();
  await form.locator('[data-proposal-typology="row"]').click();
  await form.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
  await expectStatusLogged(page, 'Row houses need at least two parcels.');
  await expect(page.locator('#rowhouse .on-map-editor__panel')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
});
