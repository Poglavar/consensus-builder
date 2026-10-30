import { openPlanActions } from '../helpers/plan-actions';
// Exercise proposal action buttons and assert the resulting UI and stored state: the related-design
// link, the grain-score Repeat control, and Share publishing a design (POST /designs).
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, PARCEL_ID, showProposalTab } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

async function addProposal(page: import('@playwright/test').Page, proposal: Record<string, unknown>): Promise<string> {
  return page.evaluate(record => (window as any).proposalStorage.addProposal(record), proposal);
}

async function showExpandedProposal(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(panel.locator('.panel-body')).toBeVisible();
}

async function openLandSection(page: import('@playwright/test').Page): Promise<void> {
  await showProposalTab(page, 'details');
  const section = page.locator('#proposal-details-content details[data-proposal-section="land"]');
  if (!(await section.evaluate(element => (element as HTMLDetailsElement).open))) {
    await section.locator(':scope > summary').click();
  }
  await expect(section).toHaveJSProperty('open', true);
}

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal action tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

test.describe('proposal detail button controls @features', () => {
  test('a parcel-set related design link selects that design', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const parcelSource = { sourceId: 'hr-cadastre', snapshotId: null };
    const sourceId = await addProposal(page, {
      title: 'Source plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      parcelSet: { setHash: 'e2e-parcel-set-hash', parcelSource },
    });
    const relatedId = await addProposal(page, {
      title: 'Related plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      parcelSet: { parcelSource },
    });

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    const relatedButton = page.locator(`#proposal-details-content [data-related-proposal-id="${relatedId}"]`);
    await expect(relatedButton).toBeVisible();
    await relatedButton.click();
    await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getSelected()?.proposalId)).toBe(relatedId);
    await expect(page.locator('#proposal-details-panel')).toContainText('Related plan');
    await showExpandedProposal(page, relatedId);
    await openLandSection(page);
    // The related design lists the source design back.
    await expect(page.locator(`#proposal-details-content [data-related-proposal-id="${sourceId}"]`)).toBeVisible();
    // Activity is an agreement's (M3): a design's land section offers no activity scope of its own.
    await expect(page.locator('#proposal-details-content .proposal-parcel-set-card .activity-scope-link')).toHaveCount(0);
  });

  test('the grain-score Repeat control runs another inspection and returns to its result', async ({ mockApi: page }) => {
    await openCity(page);
    await createSpace(page, 'park');
    await page.locator('#proposals-button').click();
    await (await openPlanActions(page)).getByRole('button', { name: 'Urban rooster', exact: true }).click();

    const panel = page.locator('#grain-score-panel');
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    const firstScore = await panel.locator('[data-grain-role="totalScore"]').innerText();
    const repeat = panel.locator('[data-grain-action="repeat"]');
    await expect(repeat).toBeVisible();
    await repeat.click();
    await expect(page.locator('#grain-score-overlay')).toBeVisible();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    await expect(panel.locator('[data-grain-role="totalScore"]')).toHaveText(firstScore);
  });

  test('design Share publishes one design; saved-plan composition stays local until Share plan', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const proposalId = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showExpandedProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();

    // Share publishes one design and copies its /designs link.
    const index = pageIndex(page);
    await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
    const [cid] = [...index.designs.keys()];
    const link = `${new URL(page.url()).origin}/designs/${cid}?city=zg&3d&lang=en`;
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    const individualLink = new URL(link);
    expect(individualLink.pathname).toBe('/designs/' + cid);
    expect(index.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/designs']);
    await expect(page.locator(`#proposal-details-content [data-proposal-published-cid="${cid}"]`)).toBeAttached();

    // A plan is composed locally from published designs, then published from its own actions.
    await page.locator('#proposals-button').click();
    const sheet = page.locator('#proposals-sheet');
    await sheet.locator('#shareAppliedProposalsButton').click();
    // Lists (01268caee): the Plans tab's Create plan sits in #lists-actions; the saved plan opens in
    // the click stack's Plan section, which holds Share plan. Create plan ticks the designs in
    // Lists → Designs; Continue opens the composer listing them.
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Create plan', exact: true }).click();
    const selection = sheet.locator('#lists-actions .lists-selection-count');
    const next = sheet.locator('#lists-actions [data-lists-continue]');
    await expect(selection).toHaveText('0 selected');
    await expect(next).toBeDisabled();
    await sheet.locator('#proposal-list-host input[type="checkbox"]').first().check();
    await expect(selection).toHaveText('1 selected');
    await expect(next).toBeEnabled();
    await next.click();
    const composer = page.locator('.plan-composer');
    await expect(composer.locator('.plan-dialog__count')).toHaveText('1 selected');
    await expect(composer.locator('.plan-dialog__members li')).toHaveCount(1);
    const save = composer.getByRole('button', { name: 'Create plan', exact: true });
    await expect(save).toBeDisabled();
    await composer.getByLabel('Plan name', { exact: true }).fill('Garden plan');
    await expect(save).toBeEnabled();
    const beforeSave = index.requests.filter(request => request.method === 'POST').length;
    await save.click();
    const details = page.locator('#click-stack .click-stack__section[data-kind="plans"]');
    await expect(details).toContainText('Garden plan');
    expect(index.requests.filter(request => request.method === 'POST')).toHaveLength(beforeSave);
    await details.getByRole('button', { name: 'Share plan', exact: true }).click();
    const planShare = page.locator('.plan-share');
    await expect(planShare.locator('.plan-dialog__members li')).toHaveText(['Park · parcel 1234']);
    const beforePlanShare = index.requests.filter(request => request.method === 'POST').length;
    await planShare.getByRole('button', { name: 'Publish and copy link', exact: true }).click();
    const planLink = planShare.getByLabel('Plan link', { exact: true });
    await expect(planLink).toBeVisible();
    const planUrl = new URL(await planLink.inputValue());
    expect(planUrl.pathname).toMatch(/^\/plans\//);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(planUrl.toString());
    const planPosts = index.requests.filter(request => request.method === 'POST').slice(beforePlanShare);
    expect(planPosts.map(request => request.path)).toContain('/plans');
    expect(planPosts.some(request => request.path === '/designs')).toBe(false);
    expect(planPosts.some(request => request.path === '/agreements')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(planShare).toBeHidden();
    await expect(sheet).toBeHidden();
  });
});
