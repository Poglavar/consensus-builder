// Exercise proposal action buttons and assert the resulting UI and stored state: related-design and
// activity links, the grain-score Repeat control, and Share publishing a design (POST /pins, /designs).
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, PARCEL_ID } from '../helpers/runtime';
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
  test('parcel-set related proposal and activity links navigate to the selected scope', async ({ mockApi: page }) => {
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
    await expect(page.locator('#planning-inspector')).toContainText('Related plan');
    await showExpandedProposal(page, relatedId);

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    const proposalActivity = page.locator('#proposal-details-content .activity-scope-link[data-activity-scope="proposalId"]');
    await proposalActivity.click();
    const activity = page.locator('.game-log-modal');
    await expect(activity).toBeVisible();
    await expect(activity.locator('[data-activity-scope-chip]')).toContainText(sourceId);
    await activity.getByRole('button', { name: 'Clear scope' }).click();
    await expect(activity.locator('[data-activity-scope-chip]')).toBeHidden();
    await activity.locator('.game-log-modal-close').click();
    await expect(activity).toBeHidden();

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    await page.locator('#proposal-details-content .activity-scope-link[data-activity-scope="parcelSet"]').click();
    await expect(activity.locator('[data-activity-scope-chip]')).toContainText(/Land:/);
  });

  test('the grain-score Repeat control runs another inspection and returns to its result', async ({ mockApi: page }) => {
    await openCity(page);
    await createSpace(page, 'park');
    await page.locator('#proposals-button').click();
    await page.locator('#proposal-list-actions > summary').click();
    await page.locator('#roosterScoreButton').click();

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

  test('Share in the footer publishes the design and copies its link, and the applied-designs panel highlights it as published', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const proposalId = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showExpandedProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();

    // Share pins and indexes the design under its CID and copies its /designs link.
    const index = pageIndex(page);
    await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
    const [cid] = [...index.designs.keys()];
    const link = `${new URL(page.url()).origin}/designs/${cid}?city=zg&3d&lang=en`;
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    expect(index.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/pins', '/designs']);
    await expect(page.locator(`#proposal-details-content [data-proposal-published-cid="${cid}"]`)).toBeAttached();

    // The whole applied plan: its row is already published, and the selection's link is the same.
    await page.locator('#proposals-button').click();
    const actions = page.locator('#proposal-list-actions');
    if (!(await actions.evaluate(element => (element as HTMLDetailsElement).open))) await actions.locator(':scope > summary').click();
    await page.locator('#shareAppliedProposalsButton').click();
    const plan = page.locator('.share-plan-panel');
    await expect(plan).toBeVisible({ timeout: 30000 });
    await expect(plan.locator('.share-plan-progress')).toHaveCount(0, { timeout: 30000 });
    const row = plan.locator('.share-plan-row').filter({ hasText: /park/i });
    await expect(row.locator('.share-plan-row__published')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Publish', exact: true })).toBeHidden();
    await expect(plan.locator('.share-plan-link__input')).toHaveValue(link);

    const publishedMode = plan.getByRole('button', { name: 'Published', exact: true });
    await publishedMode.click();
    await expect(publishedMode).toHaveAttribute('aria-pressed', 'true');
    const pendingMode = plan.getByRole('button', { name: 'Not published yet', exact: true });
    await pendingMode.click();
    await expect(pendingMode).toHaveAttribute('aria-pressed', 'true');
    await expect(publishedMode).toHaveAttribute('aria-pressed', 'false');
    await plan.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(plan).toBeHidden();
    // Publishing went through Share alone: the panel sent nothing.
    expect(index.requests.filter(request => request.method === 'POST')).toHaveLength(2);
  });
});
