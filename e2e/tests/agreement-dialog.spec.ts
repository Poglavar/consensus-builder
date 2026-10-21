// Purpose: agreements over applied designs (plan-design-agreement.md, "M1 (b) build contract") from
// the screen: Create agreement from an applied parcel layout's details, the land it derives, the
// allocation, cash and decision rule, the docked agreement panel (status, Before / after, Edit,
// Delete), the Agreements list, an agreement whose design left the map, and a dialog with nothing to bundle.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, stubBasemapTiles, PARCEL_ID } from '../helpers/runtime';
import { fillNativeDateTime, selectNativeOption } from '../helpers/controls';
import {
  OWNER, applyLayout, agreementDialog, agreementPanel, storedAgreements, landLoaded, createFromDetails, openAgreementsList, panelStatus,
} from '../helpers/agreements';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const TITLE = 'Block 1234 readjustment';
const isLayoutApplied = (page: Page, id: string) => page.evaluate(id => {
  const w = window as any;
  return !!w.isApplied(w.proposalStorage.getProposal(id));
}, id);

test('an agreement over an applied parcel layout is created from its details, compared, edited, listed and deleted @core', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  const { layoutId, ownerKey } = await applyLayout(page);

  // A parcel layout leaves the device only with its agreement: Create agreement is the main
  // action, ahead of the disabled Share.
  await showProposal(page, layoutId);
  const primary = page.locator('#proposal-details-panel .proposal-primary-actions');
  const create = primary.locator('.btn-create-agreement');
  await expect(create).toHaveClass(/\bbtn-primary\b/);
  await expect(primary.locator('.btn-share-proposal')).toBeDisabled();
  await expect(page.locator('#proposal-publish-later-note')).toHaveText('A parcel layout is published with its agreement. Propose an agreement that includes it.');
  expect(await primary.locator('.btn-create-agreement, .btn-share-proposal').evaluateAll(buttons => buttons
    .map(button => (button.classList.contains('btn-create-agreement') ? 'create agreement' : 'share')))).toEqual(['create agreement', 'share']);
  await create.click();

  const dialog = agreementDialog(page);
  await expect(dialog.locator('.cb-dialog__title')).toHaveText('Create agreement');
  const design = dialog.locator(`input[data-agreement-design="${layoutId}"]`);
  await expect(design).toBeChecked();
  await landLoaded(dialog);
  // Unchoosing the one design leaves no land to settle; choosing it again reads the land again.
  await design.uncheck();
  await expect(dialog.locator('[data-agreement-land] tr[data-agreement-input]')).toHaveCount(0);
  await expect(dialog.locator('select[data-agreement-allocation]')).toHaveCount(0);
  await design.check();
  await landLoaded(dialog);

  // The land is derived, never typed: the parcel the layout took, with its owner, and its two plots.
  await expect(dialog.locator(`tr[data-agreement-input="${PARCEL_ID}"]`)).toContainText(`${OWNER} 100%`);
  const outputs = dialog.locator('table[data-agreement-outputs] tr[data-agreement-output]');
  await expect(outputs).toHaveCount(2);
  const hashes = await outputs.evaluateAll(rows => rows.map(row => String(row.getAttribute('data-agreement-output'))));
  for (const hash of hashes) expect(hash).toMatch(/^piece1-sha256:[0-9a-f]{64}$/);
  await expect(outputs.first()).toContainText(OWNER);

  // Each piece goes to its current holders (the default), the one input party, or the public.
  const allocation = dialog.locator(`select[data-agreement-allocation="${hashes[0]}"]`);
  await expect(allocation).toHaveValue('holders');
  expect(await allocation.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['holders', `party:${ownerKey}`, 'public']);
  await selectNativeOption(allocation, 'public');
  await expect(allocation).toHaveValue('public');

  // Cash in euros, + receives: the sponsor's line covers the difference.
  const sponsor = dialog.locator('[data-agreement-sponsor]');
  await expect(sponsor).toHaveAttribute('data-agreement-sponsor', 'balanced');
  await dialog.locator(`input[data-agreement-cash="${ownerKey}"]`).fill('2500');
  await expect(sponsor).toHaveAttribute('data-agreement-sponsor', 'funds');
  await expect(sponsor).toContainText(/Sponsor funds .*2,500/);

  // The rule: the owners under the approval form, binding unless unticked; a community vote never binds.
  const owners = dialog.locator('input[name="agreement-electorate"][value="owners"]');
  const community = dialog.locator('input[name="agreement-electorate"][value="community"]');
  const binding = dialog.locator('[data-agreement-binding]');
  const ruleForm = dialog.locator('[data-agreement-rule-form]');
  await expect(owners).toBeChecked();
  await expect(binding).toBeChecked();
  await expect(ruleForm.locator('select[data-approval-regime]')).toBeVisible();
  await binding.uncheck();
  await community.check();
  await expect(binding).toBeDisabled();
  await expect(binding).not.toBeChecked();
  await expect(ruleForm).toBeHidden();
  // Back to the owners: their rules return, and their decision binds again.
  await owners.check();
  await expect(binding).toBeEnabled();
  await expect(binding).toBeChecked();
  await expect(ruleForm.locator('select[data-approval-regime]')).toBeVisible();
  await community.check();
  await expect(binding).toBeDisabled();
  await expect(binding).not.toBeChecked();

  await dialog.locator('[data-agreement-title]').fill(TITLE);
  const deadline = dialog.locator('[data-agreement-deadline]');
  await fillNativeDateTime(deadline, '2030-12-31');
  await expect(deadline).toHaveValue('2030-12-31');

  await dialog.locator('[data-action-id="save"]').click();
  await expect(dialog).toHaveCount(0);
  await panelStatus(page, 'current');
  await expect(page.locator('body')).toHaveClass(/\bagreement-panel-open\b/);
  await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);
  const body = agreementPanel(page).locator('[data-agreement-region="body"]');
  await expect(body.locator(`[data-agreement-design="${layoutId}"]`)).toBeEnabled();
  await expect(body.locator(`[data-agreement-piece="${hashes[0]}"]`)).toContainText('Public');
  await expect(body.locator(`[data-agreement-piece="${hashes[1]}"]`)).toContainText(`Current holders (${OWNER} 100%)`);
  await expect(body).toContainText('Decided by a community vote · Non-binding');
  await expect(body).toContainText(/Deadline: .*2030/);

  // What was stored is the record the dialog described.
  const [saved] = await storedAgreements(page);
  expect(saved).toMatchObject({
    schema: 'agreement/v1',
    title: TITLE,
    designs: [{ proposalId: layoutId, goal: 'parcel-layout' }],
    allocations: [{ output: hashes[0], to: { kind: 'public' } }],
    money: { currency: 'EUR', lines: [{ ownerKey, amountCents: 250_000 }] },
    rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
  });
  expect(saved.id).toMatch(/^ag-[0-9a-f]{32}$/);
  // A design is named by its content CID (js/design-record.js), the identity the index files it under.
  expect(saved.designs[0].cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
  expect(saved.designs[0].cid).toBe(await page.evaluate(id => {
    const w = window as any;
    return w.DesignRecord.cidOf(w.proposalStorage.getProposal(id));
  }, layoutId));
  expect(saved.designs[0]).not.toHaveProperty('fingerprint');
  expect(saved.inputs.parcels.map((parcel: any) => parcel.parcelId)).toEqual([PARCEL_ID]);
  expect(saved.outputs.map((output: any) => output.hash)).toEqual(hashes);

  // Before / after over the agreement's input parcels, on and off.
  const compare = body.locator('[data-agreement-action="compare"]');
  const beforeMap = page.locator('#map .map-compare__before');
  await expect(compare).toHaveAttribute('aria-pressed', 'false');
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await expect(beforeMap).toBeVisible();
  await compare.click();
  await expect(compare).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
  await expect(beforeMap).toHaveCount(0);

  // Edit opens the dialog on the stored terms; Cancel keeps them.
  await body.locator('[data-agreement-action="edit"]').click();
  await expect(dialog.locator('.cb-dialog__title')).toHaveText('Edit agreement');
  await landLoaded(dialog);
  await expect(dialog.locator('[data-agreement-title]')).toHaveValue(TITLE);
  await expect(dialog.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
  await expect(dialog.locator(`select[data-agreement-allocation="${hashes[0]}"]`)).toHaveValue('public');
  await expect(dialog.locator(`input[data-agreement-cash="${ownerKey}"]`)).toHaveValue('2500');
  await expect(community).toBeChecked();
  await expect(binding).toBeDisabled();
  await expect(deadline).toHaveValue('2030-12-31');
  await dialog.locator('[data-action-id="cancel"]').click();
  await expect(dialog).toHaveCount(0);
  await panelStatus(page, 'current');
  expect(await storedAgreements(page)).toEqual([saved]);

  // The panel's close button takes it off the dock; the Agreements list opens it again.
  await agreementPanel(page).locator('[data-agreement-action="close"]').click();
  await expect(agreementPanel(page)).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/\bagreement-panel-open\b/);
  let list = await openAgreementsList(page);
  const item = list.locator('.agreement-item');
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute('data-agreement-id', saved.id);
  await expect(item).toContainText(TITLE);
  await expect(item).toContainText('1 design · Decided by a community vote · Non-binding');
  await item.click();
  await expect(list).toHaveCount(0);
  await panelStatus(page, 'current');
  await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);

  // Delete asks first; the agreement goes, its design stays on the map.
  await agreementPanel(page).locator('[data-agreement-action="delete"]').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Delete this agreement? Its designs stay on the map.');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(agreementPanel(page)).toBeHidden();
  expect(await storedAgreements(page)).toEqual([]);
  expect(await isLayoutApplied(page, layoutId)).toBe(true);
  list = await openAgreementsList(page);
  await expect(list.locator('.agreement-item')).toHaveCount(0);
  await expect(list.locator('[data-agreement-list-rows]')).toContainText('No agreements yet');
  await list.locator('.cb-dialog__header .close-circle-btn').click();
  await expect(list).toHaveCount(0);
});

test('an agreement whose design is taken off the map no longer matches it, and cannot be compared', async ({ mockApi: page }) => {
  test.setTimeout(150_000);
  const { layoutId } = await applyLayout(page);
  const dialog = await createFromDetails(page, layoutId);
  await dialog.locator('[data-action-id="save"]').click();
  await expect(dialog).toHaveCount(0);
  await panelStatus(page, 'current');
  // Untitled, the agreement is named by its date.
  await expect(page.locator('#agreement-panel-title')).toHaveText(/^Agreement of /);

  // A design row selects the design: its details take the right dock.
  await agreementPanel(page).locator(`[data-agreement-design="${layoutId}"]`).click();
  await expect(agreementPanel(page)).toBeHidden();
  const details = page.locator('#proposal-details-panel');
  const inspector = page.locator('#planning-inspector');
  await expect.poll(async () => await details.isVisible() || await inspector.isVisible()).toBe(true);
  if (await inspector.isVisible()) await inspector.getByRole('button', { name: 'Proposal actions', exact: true }).click();
  await expect(details.locator('.btn-create-agreement')).toBeVisible();

  // Unapplied, the layout offers no agreement, and the stored one no longer matches the map.
  await details.locator(`[id="proposal-action-btn-${layoutId}"]`).click();
  await expect.poll(() => isLayoutApplied(page, layoutId), { timeout: 30_000 }).toBe(false);
  await showProposal(page, layoutId);
  await expect(details.locator('.btn-share-proposal')).toBeVisible();
  await expect(details.locator('.btn-create-agreement')).toHaveCount(0);
  const layoutTitle = await page.evaluate(id => String((window as any).proposalStorage.getProposal(id).title), layoutId);
  const list = await openAgreementsList(page);
  await list.locator('.agreement-item').click();
  const stale = await panelStatus(page, 'stale');
  await expect(stale).toContainText('No longer matches the map');
  await expect(stale).toContainText(`a design is no longer applied (${layoutTitle})`);
  await expect(agreementPanel(page).locator('[data-agreement-action="compare"]')).toBeDisabled();
  expect(await storedAgreements(page)).toHaveLength(1);
});

test('Create agreement with no applied design names what is missing and saves nothing', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const list = await openAgreementsList(page);
  await expect(list.locator('[data-agreement-list-rows]')).toContainText('No agreements yet');
  await list.locator('[data-agreement-action="create"]').click();
  await expect(list).toHaveCount(0);

  const dialog = agreementDialog(page);
  await expect(dialog.locator('.cb-dialog__title')).toHaveText('Create agreement');
  await expect(dialog.locator('[data-agreement-empty]')).toHaveText('No applied designs. Apply a design first.');
  await expect(dialog.locator('input[data-agreement-design]')).toHaveCount(0);
  await expect(dialog.locator('[data-agreement-errors] li')).toHaveCount(0);
  await dialog.locator('[data-action-id="save"]').click();
  await expect(dialog.locator('[data-agreement-errors] li[data-agreement-issue="no-designs"]')).toHaveText('Choose at least one design.');
  await expect(dialog).toBeVisible();
  expect(await storedAgreements(page)).toEqual([]);
  await dialog.locator('[data-action-id="cancel"]').click();
  await expect(dialog).toHaveCount(0);
  expect(await storedAgreements(page)).toEqual([]);
});
