// Purpose: agreements over applied designs (plan-design-agreement.md, "M1 (b) build contract") from
// the screen: Create agreement from an applied parcel layout's details, the land it derives, the
// allocation, cash and decision rule, the docked agreement panel (status, Before / after, Edit,
// Delete), the Agreements list, an agreement whose design left the map, and a dialog with nothing to bundle.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, PARCEL_ID } from '../helpers/runtime';
import { fillNativeDateTime, selectNativeOption } from '../helpers/controls';
import type { Locator, Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

const OWNER = 'Ana Owner';
const TITLE = 'Block 1234 readjustment';

// Parcel 1234 held by one local owner, laid out into two equal plots and applied: the design an
// agreement settles. The owner record is written first, so the layout carries it over to the plots.
async function applyLayout(page: Page): Promise<{ layoutId: string; ownerKey: string }> {
  await openCity(page);
  const ownerKey = await page.evaluate(async ({ parcelId, name }) => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const agent = w.createAgent();
    agent.name = name;
    w.agentStorage.addAgent(agent);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, agent.id);
    return String(agent.id);
  }, { parcelId: PARCEL_ID, name: OWNER });
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const editor = page.locator('.on-map-reparcellization');
  const done = editor.locator('[data-reparcel-commit]');
  await expect(done).toBeEnabled({ timeout: 15_000 });
  await done.click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout').length)).toBe(1);
  const layoutId = await page.evaluate(() => String((window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout').proposalId));
  return { layoutId, ownerKey };
}

const agreementDialog = (page: Page) => page.locator('.agreement-dialog-overlay');
const agreementPanel = (page: Page) => page.locator('section#agreement-panel');
const storedAgreements = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).AgreementStore.list())));
const isLayoutApplied = (page: Page, id: string) => page.evaluate(id => {
  const w = window as any;
  return !!w.isApplied(w.proposalStorage.getProposal(id));
}, id);

// The land under the chosen designs, once it is read: input parcels and the pieces standing on them.
async function landLoaded(dialog: Locator): Promise<void> {
  await expect(dialog.locator('table[data-agreement-inputs] tr[data-agreement-input]').first()).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-agreement-land-loading]')).toHaveCount(0);
  await expect(dialog.locator('table[data-agreement-outputs] tr[data-agreement-output]').first()).toBeVisible();
}

// The details panel's Create agreement opens the dialog over that one design.
async function createFromDetails(page: Page, layoutId: string): Promise<Locator> {
  await showProposal(page, layoutId);
  await page.locator('#proposal-details-panel .btn-create-agreement').click();
  const dialog = agreementDialog(page);
  await expect(dialog.locator('.cb-dialog__title')).toHaveText('Create agreement');
  await expect(dialog.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
  await landLoaded(dialog);
  return dialog;
}

// The Agreements button sits in the Proposals sheet, under Proposal tools.
async function openAgreementsList(page: Page): Promise<Locator> {
  const sheet = page.locator('#proposals-sheet');
  if (!(await sheet.isVisible())) await page.locator('#proposals-button').click();
  await expect(sheet).toBeVisible();
  const tools = page.locator('#proposal-list-actions');
  if (!(await tools.evaluate(element => (element as HTMLDetailsElement).open))) await tools.locator('summary').click();
  await page.locator('#agreementsButton').click();
  const list = page.locator('.agreement-list-dialog');
  await expect(list).toBeVisible();
  return list;
}

// The panel on the right dock and the status it reached against the map.
async function panelStatus(page: Page, status: 'current' | 'stale'): Promise<Locator> {
  await expect(agreementPanel(page)).toBeVisible();
  const badge = agreementPanel(page).locator(`[data-agreement-status="${status}"]`);
  await expect(badge).toBeVisible({ timeout: 30_000 });
  return badge;
}

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
  expect(saved.designs[0].fingerprint).toMatch(/^c2-/);
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
