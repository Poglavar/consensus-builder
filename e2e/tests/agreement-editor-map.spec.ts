// Plan-first agreement editing: tabs preserve the fixed plan, single allocations drive derived
// money, abstract owners work without a rights import, and advanced controls stay in dialogs.
import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles, showProposal } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, storedAgreements } from '../helpers/agreements';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });
async function create(page: Page, layoutId: string) {
  await page.evaluate(id => { const w = window as any; void w.PlanDialog.create({ members: [w.proposalStorage.getProposal(id)] }); }, layoutId);
  const composer = page.locator('.plan-dialog');
  await composer.locator('input[type="text"]').fill('Block agreement plan');
  await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
  await page.locator('.plan-dialog').getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-agreement-input]')).toHaveCount(1);
  return editor;
}

test('creation belongs to the saved plan; four tabs preserve exact membership and save', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  await showProposal(page, layoutId);
  await expect(page.locator('#proposal-details-panel .btn-create-agreement')).toHaveCount(0);
  const editor = await create(page, layoutId);
  await expect(editor.locator('[role="tab"]')).toHaveText(['Rules', 'Input parcels', 'Output parcels', 'Persons']);
  await expect(editor.locator('[data-agreement-design]')).toHaveCount(0);
  const planCid = await editor.locator('[data-agreement-plan]').inputValue();
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  const recipients = editor.locator('[data-agreement-allocation]');
  await expect(recipients).toHaveCount(2);
  expect(await recipients.first().locator('option').allTextContents()).not.toContain('Current holders');
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  await expect(editor.locator('.agreement-persons-table')).toContainText('Ana Owner');
  await expect(editor.locator('[data-agreement-cash]')).toHaveCount(0);
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [record] = await storedAgreements(page);
  expect(record.plan.cid).toBe(planCid);
  expect(record.designs.map((row: any) => row.proposalId)).toEqual([layoutId]);
  expect(record.allocations).toHaveLength(2);
  expect(record.money.lines).toEqual([]);
});

test('public allocation updates compensation, rate and sponsor tally without editable person cash', async ({ mockApi: page }) => {
  const { layoutId, ownerKey } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  await editor.locator('[data-agreement-allocation]').first().selectOption('public');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-rate]').fill('150');
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  await expect(editor.locator('.agreement-persons-table')).toContainText('Sponsor');
  await expect(editor.locator('[data-agreement-persons]')).toContainText('150');
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  const publicArea = saved.outputs.find((o: any) => saved.allocations.some((a: any) => a.output === o.hash && a.to.kind === 'public')).areaM2;
  expect(saved.money.lines).toEqual([{ ownerKey, amountCents: Math.round(publicArea * 15000) }]);
});

test('unnamed parcel owners work and ownership/lens settings open separate dialogs', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  await page.evaluate(() => {
    const w = window as any;
    w.PersistentStorage.forEach((_raw: string, key: string) => { if (/^parcel_.*_owner$/.test(key)) w.PersistentStorage.removeItem(key); });
  });
  const editor = await create(page, layoutId);
  await expect(editor.locator('[data-agreement-land]')).toContainText('Owner(s) of parcel');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('[data-approval-file]')).toHaveCount(0);
  await expect(editor.locator('[data-approval-lens]')).toHaveCount(0);
  await editor.locator('[data-agreement-action="rights"]').click();
  const rights = page.locator('.cb-dialog').filter({ hasText: 'Parcel ownership rights' });
  await expect(rights.locator('[data-approval-file]')).toBeVisible();
  await rights.getByRole('button', { name: 'Close', exact: true }).last().click();
  await editor.locator('[data-agreement-action="lens"]').click();
  await expect(page.locator('.cb-dialog [data-approval-lens]')).toBeVisible();
});

test('a saved private plan can apply its unpublished members before agreement authoring', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  const planCid = await editor.locator('[data-agreement-plan]').inputValue();
  await editor.locator('.panel-header [data-agreement-action="cancel"]').click();
  await page.evaluate(async ({ layoutId, planCid }) => {
    const w = window as any;
    await w.ProposalManager.unapplyProposal(layoutId);
    const plan = w.NamedPlans.list().find((row: any) => row.cid === planCid);
    void w.AgreementDialog.open({ plan });
  }, { layoutId, planCid });
  await expect(agreementEditor(page).locator('[data-agreement-action="apply-plan"]')).toBeVisible();
  await agreementEditor(page).locator('[data-agreement-action="apply-plan"]').click();
  await expect(agreementEditor(page).locator('[data-agreement-input]')).toHaveCount(1);
  await expect(editorSave(agreementEditor(page))).toBeEnabled();
  expect(await agreementEditor(page).locator('[data-agreement-plan]').inputValue()).toBe(planCid);
});

test('phone layout shows tabs without horizontal overflow and requires a saved plan', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await applyLayout(page);
  await page.evaluate(() => { void (window as any).AgreementDialog.open(); });
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Create a plan first');
  await expect(editorSave(editor)).toBeDisabled();
  await expect(editor.locator('[data-agreement-plan]')).toHaveValue('');
  expect(await editor.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('[data-agreement-compensation]')).toBeVisible();
});
