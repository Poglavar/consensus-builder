// Agreements from the screen, shared by the agreement specs: a parcel layout applied over one owned
// parcel (the design an agreement settles), the Create agreement dialog over it, the docked agreement
// panel and the Agreements list (frontend/js/agreement-dialog.js, agreement-panel.js).
import { expect, Locator, Page } from '@playwright/test';
import { openCity, openParcel, showProposal, PARCEL_ID } from './runtime';

export const OWNER = 'Ana Owner';

// Parcel 1234 held by one local owner, laid out into two equal plots and applied: the design an
// agreement settles. The owner record is written first, so the layout carries it over to the plots.
export async function applyLayout(page: Page): Promise<{ layoutId: string; ownerKey: string }> {
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

export const agreementDialog = (page: Page) => page.locator('.agreement-dialog-overlay');
export const agreementPanel = (page: Page) => page.locator('section#agreement-panel');
export const storedAgreements = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).AgreementStore.list())));

// The land under the chosen designs, once it is read: input parcels and the pieces standing on them.
export async function landLoaded(dialog: Locator): Promise<void> {
  await expect(dialog.locator('table[data-agreement-inputs] tr[data-agreement-input]').first()).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('[data-agreement-land-loading]')).toHaveCount(0);
  await expect(dialog.locator('table[data-agreement-outputs] tr[data-agreement-output]').first()).toBeVisible();
}

// The details panel's Create agreement opens the dialog over that one design.
export async function createFromDetails(page: Page, layoutId: string): Promise<Locator> {
  await showProposal(page, layoutId);
  await page.locator('#proposal-details-panel .btn-create-agreement').click();
  const dialog = agreementDialog(page);
  await expect(dialog.locator('.cb-dialog__title')).toHaveText('Create agreement');
  await expect(dialog.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
  await landLoaded(dialog);
  return dialog;
}

// The Agreements button sits in the Proposals sheet, under Proposal tools.
export async function openAgreementsList(page: Page): Promise<Locator> {
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
export async function panelStatus(page: Page, status: 'current' | 'stale'): Promise<Locator> {
  await expect(agreementPanel(page)).toBeVisible();
  const badge = agreementPanel(page).locator(`[data-agreement-status="${status}"]`);
  await expect(badge).toBeVisible({ timeout: 30_000 });
  return badge;
}
