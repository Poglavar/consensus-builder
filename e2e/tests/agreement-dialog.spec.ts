// Purpose: agreements over applied designs (plan-design-agreement.md; docs/agreement-editor.md, the
// plan-first editor) from the screen: a saved plan of an applied parcel layout opens the agreement
// editor, with the land it derives, one recipient per piece and the decision rule; the agreement
// panel in the click stack (status, Before / after, Edit in the editor), the Lists panel's
// Agreements tab (open, remove from this browser), an agreement whose design left the map, and an
// editor with no saved plan.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, stubBasemapTiles, PARCEL_ID } from '../helpers/runtime';
import { fillNativeDateTime, selectNativeOption } from '../helpers/controls';
import {
  OWNER, applyLayout, agreementPanel, storedAgreements, createFromPlan, openStackAgreement, openAgreementsList, agreementListItem, openListedAgreement,
  closeAgreementPanel, panelStatus, editorOpen, editorClosed, editorSave, editorCancel, editorClose,
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

test('an agreement over an applied parcel layout is created from its plan, compared, edited, listed and removed @core', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  const { layoutId, partyKey } = await applyLayout(page);

  // A parcel layout is shared on its own like any design, and its details offer no agreement of
  // their own, since an agreement starts from a saved plan.
  await showProposal(page, layoutId);
  const primary = page.locator('#proposal-details-panel .proposal-primary-actions');
  await expect(primary.locator('.btn-share-proposal')).toBeEnabled();
  await expect(page.locator('#proposal-publish-later-note')).toHaveCount(0);
  await expect(primary.locator('.btn-create-agreement')).toHaveCount(0);
  const editor = await createFromPlan(page, layoutId, 'Block 1234 plan');
  // The plan fixes the designs: the editor lists them and offers no design to choose.
  await expect(editor.locator('input[data-agreement-design]')).toHaveCount(0);
  await expect(editor.locator(`[data-agreement-plan-designs] [data-agreement-object-id="${layoutId}"]`)).toBeVisible();

  // The land is derived, never typed: the parcel the layout took, its owner from the ownership
  // rights (the local owner record), and its two plots.
  await expect(editor.locator(`[data-agreement-input="${PARCEL_ID}"]`)).toContainText(`${OWNER} 100%`);
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  const recipients = editor.locator('select[data-agreement-allocation]');
  await expect(recipients).toHaveCount(2);
  const hashes = await recipients.evaluateAll(selects => selects.map(select => String(select.getAttribute('data-agreement-allocation'))));
  for (const hash of hashes) expect(hash).toMatch(/^piece1-sha256:[0-9a-f]{64}$/);

  // Each piece goes to exactly one recipient: back to its parcel's party (the default), the
  // proposer or the public. The party is the parcel's owners, never a named person.
  const allocation = editor.locator(`select[data-agreement-allocation="${hashes[0]}"]`);
  await expect(allocation).toHaveValue(`party:${partyKey}`);
  expect(await allocation.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['', 'proposer', `party:${partyKey}`, 'public']);
  await expect(allocation.locator(`option[value="party:${partyKey}"]`)).toHaveText(`Owner(s) of parcel ${PARCEL_ID}`);
  await selectNativeOption(allocation, 'public');
  await expect(allocation).toHaveValue('public');
  // Cash follows from the rules and the allocations; nobody types it per person.
  await expect(editor.locator('[data-agreement-cash]')).toHaveCount(0);

  // The rule: the owners under the approval form, a non-binding vote until the author ticks Binding;
  // a community vote never binds.
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  const owners = editor.locator('input[name="agreement-electorate"][value="owners"]');
  const community = editor.locator('input[name="agreement-electorate"][value="community"]');
  const binding = editor.locator('[data-agreement-binding]');
  const ruleForm = editor.locator('[data-agreement-rule-form]');
  await expect(owners).toBeChecked();
  await expect(binding).not.toBeChecked();
  await expect(ruleForm.locator('select[data-approval-regime]')).toBeVisible();
  await binding.check();
  await community.check();
  await expect(binding).toBeDisabled();
  await expect(binding).not.toBeChecked();
  await expect(ruleForm).toBeHidden();
  // Back to the owners: their rules return, and binding them again takes a new explicit tick.
  await owners.check();
  await expect(binding).toBeEnabled();
  await expect(binding).not.toBeChecked();
  await binding.check();
  await expect(binding).toBeChecked();
  await expect(ruleForm.locator('select[data-approval-regime]')).toBeVisible();
  await community.check();
  await expect(binding).toBeDisabled();
  await expect(binding).not.toBeChecked();

  await editor.locator('[data-agreement-title]').fill(TITLE);
  const deadline = editor.locator('[data-agreement-deadline]');
  await fillNativeDateTime(deadline, '2030-12-31');
  await expect(deadline).toHaveValue('2030-12-31');

  // Save stores it; the plan keeps the click stack, and the stack's Agreements row opens the new agreement.
  await editorSave(editor).click();
  await editorClosed(page);
  await openStackAgreement(page);
  await expect(page.locator('body')).toHaveClass(/\bagreement-panel-open\b/);
  await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);
  const body = agreementPanel(page).locator('[data-agreement-region="body"]');
  await expect(body.locator(`[data-agreement-design="${layoutId}"]`)).toBeEnabled();
  // Switching to a community consultation clears the settlement terms authored above.
  await expect(body.locator('[data-agreement-piece]')).toHaveCount(0);
  await expect(body).toContainText('Decided by a community vote · Non-binding');
  await expect(body).toContainText(/Deadline: .*2030/);

  // What was stored is the record the editor described.
  const [saved] = await storedAgreements(page);
  expect(saved).toMatchObject({
    schema: 'agreement/v1',
    title: TITLE,
    designs: [{ proposalId: layoutId, goal: 'parcel-layout' }],
    allocations: [],
    money: { currency: 'EUR', lines: [] },
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

  // Edit opens the editor on the stored terms over the panel; Cancel keeps them.
  await body.locator('[data-agreement-action="edit"]').click();
  await editorOpen(page, 'Edit agreement');
  await expect(editor.locator('[data-agreement-input]')).toHaveCount(1, { timeout: 30_000 });
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('[data-agreement-title]')).toHaveValue(TITLE);
  await expect(community).toBeChecked();
  await expect(binding).toBeDisabled();
  await expect(deadline).toHaveValue('2030-12-31');
  // A community vote allocates nothing: its recipients cannot be chosen.
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  await expect(editor.locator(`select[data-agreement-allocation="${hashes[0]}"]`)).toBeDisabled();
  // A change that is cancelled is not kept.
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-title]').fill('Not kept');
  await editorCancel(editor).click();
  await editorClosed(page);
  await panelStatus(page, 'current');
  await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);
  expect(await storedAgreements(page)).toEqual([saved]);

  // Escape closes the click stack and the panel with it; the Lists panel's Agreements tab opens it again.
  await closeAgreementPanel(page);
  await expect(page.locator('body')).not.toHaveClass(/\bagreement-panel-open\b/);
  const list = await openAgreementsList(page);
  await expect(list.locator('.lists-item')).toHaveCount(1);
  const item = agreementListItem(list, saved.id);
  await expect(item).toContainText(TITLE);
  await expect(item).toContainText('Decided by a community vote · Non-binding');
  await openListedAgreement(list, saved.id);
  await expect(list).toBeHidden();
  await panelStatus(page, 'current');
  await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);

  // Remove from browser asks first; the agreement goes, its design stays on the map.
  await closeAgreementPanel(page);
  await openAgreementsList(page);
  await item.getByRole('button', { name: 'Remove from browser', exact: true }).click();
  const confirm = page.locator('.cb-dialog').filter({ hasText: TITLE });
  await confirm.getByRole('button', { name: 'Remove from browser', exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(await storedAgreements(page)).toEqual([]);
  expect(await isLayoutApplied(page, layoutId)).toBe(true);
  await expect(list.locator('.lists-item')).toHaveCount(0);
});

test('an agreement whose design is taken off the map warns that it does not match, and Apply plan designs restores it', async ({ mockApi: page }) => {
  test.setTimeout(150_000);
  const { layoutId } = await applyLayout(page);
  const editor = await createFromPlan(page, layoutId);
  // Enter in a text field saves, as the form's submit.
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-title]').press('Enter');
  await editorClosed(page);
  await openStackAgreement(page);
  // Untitled, the agreement is named by its date.
  await expect(page.locator('#agreement-panel-title')).toHaveText(/^Agreement of /);
  const stored = await storedAgreements(page);
  expect(stored).toHaveLength(1);

  // Unapplied from its details, the layout no longer stands on the map, and the stored agreement no
  // longer matches it.
  await closeAgreementPanel(page);
  await showProposal(page, layoutId);
  await page.locator(`#proposal-details-panel [id="proposal-action-btn-${layoutId}"]`).click();
  await expect.poll(() => isLayoutApplied(page, layoutId), { timeout: 30_000 }).toBe(false);
  const layoutTitle = await page.evaluate(id => String((window as any).proposalStorage.getProposal(id).title), layoutId);
  const list = await openAgreementsList(page);
  await openListedAgreement(list, stored[0].id);
  const stale = await panelStatus(page, 'stale');
  await expect(stale.locator('.agreement-panel-status-text'))
    .toHaveText(`Does not match the map: a design is not applied (${layoutTitle}). Propose and Before / after need it to match.`);
  await expect(agreementPanel(page).locator('[data-agreement-action="compare"]')).toBeDisabled();
  expect(await storedAgreements(page)).toHaveLength(1);

  // Edit cannot read the plan's land while its design is off the map: it offers Apply plan designs,
  // and Save waits for it.
  await agreementPanel(page).locator('[data-agreement-action="edit"]').click();
  await editorOpen(page, 'Edit agreement');
  await expect(editor.locator('[data-agreement-action="apply-plan"]')).toBeVisible({ timeout: 30_000 });
  await expect(editorSave(editor)).toBeDisabled();
  await editorCancel(editor).click();
  await editorClosed(page);
  await panelStatus(page, 'stale');

  // The warning's Apply plan designs puts the design back; the warning goes and Before / after returns.
  await agreementPanel(page).locator('[data-agreement-action="apply-designs"]').click();
  await expect.poll(() => isLayoutApplied(page, layoutId), { timeout: 30_000 }).toBe(true);
  await panelStatus(page, 'current');
  await expect(agreementPanel(page).locator('[data-agreement-action="compare"]')).toBeEnabled();
});

test('Create agreement with no saved plan names what is missing and saves nothing', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  // The Agreements tab offers Create, Compare, Import and Imported like every Lists tab, with the
  // file formats below.
  const list = await openAgreementsList(page);
  await expect(list.locator('.lists-item')).toHaveCount(0);
  await expect(page.locator('#lists-actions button')).toHaveText(['Create agreement', 'Compare agreements', 'Import agreement file', 'Imported agreements']);
  await expect(page.locator('#lists-actions .lists-actions__help')).toHaveText('File formats and limits');

  // Create agreement without a plan opens an editor that says to create one, and cannot save.
  await page.locator('#lists-actions').getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = await editorOpen(page, 'Create agreement');
  await expect(editor).toContainText('Create a plan first');
  await expect(editor.locator('[data-agreement-plan]')).toHaveValue('');
  await expect(editorSave(editor)).toBeDisabled();
  expect(await storedAgreements(page)).toEqual([]);
  // The header's close button cancels as the footer's does.
  await editorClose(editor).click();
  await editorClosed(page);
  await expect(agreementPanel(page)).toBeHidden();
  expect(await storedAgreements(page)).toEqual([]);
});
