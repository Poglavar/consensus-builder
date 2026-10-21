// These browser regressions exercise the proposal reader from its actual Proposals list entry.
// They cover compact-card actions and the narrow mobile footer, where a visible button must remain
// reachable and complete its real UI transition rather than merely exist in the rendered markup.
import { test, expect } from '../helpers/fixtures';
import { openCity, proposalState, showProposal, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

async function addLocalEditableProposal(page: import('@playwright/test').Page, key: string): Promise<string> {
  return page.evaluate(({ parcelId, geometry, key }) => {
    const proposalId = `e2e-compact-${key}`;
    return (window as any).proposalStorage.addProposal({
      proposalId,
      title: `Compact action ${key}`,
      description: 'An editable proposal used to exercise the compact details card.',
      author: 'E2E author',
      goal: 'park',
      lifecycleStatus: 'Active',
      kind: 'community-vote',
      termsConfirmed: true,
      applied: false,
      cadastreParcelIds: [parcelId],
      geometry,
      structureProposal: { kind: 'park', geometry, applied: false },
    });
  }, { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY, key });
}

async function establishLocalProfile(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeVisible();
  await welcome.locator('#username-input').fill(name);
  await welcome.locator('#welcome-submit-btn').click();
  await expect(welcome).toBeHidden();
  await expect(page.locator('#username-text')).toHaveText(name);
}

async function openCompactFromProposalList(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await page.locator('#proposals-button').click();
  const list = page.locator('#proposals-sheet .proposal-list-modal');
  const row = list.locator(`.proposal-list-item[data-proposal-id="${proposalId}"]`);
  await expect(row).toBeVisible();
  // This is the actual list action that opens proposal details, not a direct JS call to the panel.
  await row.locator('.proposal-list-details-btn').click();
  await expect(page.locator('#planning-inspector')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  await expect(panel).toBeVisible();
  const toggle = panel.locator('#proposal-details-minimize');
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  await expect(panel).toHaveClass(/is-minimized/);
}

test.describe('compact proposal card actions @features', () => {
  test('the real list opens a compact card whose Fork, Edit, Share and Map buttons perform their actions', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page, 'Compact action author');
    const proposalId = await addLocalEditableProposal(page, 'actions');
    const sourceBefore = await proposalState(page, proposalId);
    await openCompactFromProposalList(page, proposalId);

    const panel = page.locator('#proposal-details-panel');
    const footer = panel.locator('#proposal-details-footer');
    await expect(footer.locator('.btn-counterpropose-proposal')).toBeVisible();
    await expect(footer.locator('.btn-edit-geometry')).toBeVisible();
    await expect(footer.locator('.btn-share-proposal')).toBeVisible();
    await expect(footer.locator('.btn-proposal-details')).toBeVisible();
    const mapButton = footer.locator(`#proposal-action-btn-${proposalId}`);
    await expect(mapButton).toBeVisible();

    await footer.locator('.btn-counterpropose-proposal').click();
    const forkDialog = page.locator('.create-proposal-modal:visible');
    await expect(forkDialog).toBeVisible();
    await expect(forkDialog.locator('#proposalName')).toHaveValue(sourceBefore.title);
    await forkDialog.locator('.proposal-modal-close').click();
    await expect(forkDialog).toBeHidden();
    expect((await proposalState(page, proposalId)).title).toBe(sourceBefore.title);

    // Forking closes the compact details card; reopen it through the real Proposals list before
    // exercising the next footer action.
    await openCompactFromProposalList(page, proposalId);
    await footer.locator('.btn-share-proposal').click();
    const shareDialog = page.locator('.share-modal-overlay');
    await expect(shareDialog).toBeVisible();
    await shareDialog.locator('.share-modal .close-circle-btn').click();
    await expect(shareDialog).toBeHidden();

    await footer.locator('.btn-edit-geometry').click();
    const editor = page.locator('#structure-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await editor.locator('button[data-action="cancel"]').click();
    await expect(editor).toHaveCount(0);
    expect((await proposalState(page, proposalId)).title).toBe(sourceBefore.title);

    // The footer survives the editor transition; Map applies the same proposal on the real fabric.
    const reopenedFooter = page.locator('#proposal-details-footer');
    const reopenedMapButton = reopenedFooter.locator(`#proposal-action-btn-${proposalId}`);
    await expect(reopenedMapButton).toBeVisible();
    await reopenedMapButton.click();
    await expect.poll(async () => (await proposalState(page, proposalId)).applied).toBe(true);
    await expect(reopenedFooter.locator(`#proposal-action-btn-${proposalId}`)).toContainText(/Remove|Unapply/i);
  });

  test('Details expands the compact card and the mobile 320px footer keeps Share and Copy usable', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await establishLocalProfile(page, 'Compact mobile author');
    const proposalId = await addLocalEditableProposal(page, 'mobile');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await openCompactFromProposalList(page, proposalId);

    const panel = page.locator('#proposal-details-panel');
    const footer = panel.locator('#proposal-details-footer');
    const share = footer.locator('.btn-share-proposal');
    const details = footer.locator('.btn-proposal-details');
    await expect(share).toBeInViewport();
    await expect(details).toBeInViewport();
    const dimensions = await page.evaluate(() => {
      const footer = document.querySelector('#proposal-details-footer') as HTMLElement;
      return { scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth };
    });
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await share.click();
    const shareDialog = page.locator('.share-modal-overlay');
    await expect(shareDialog).toBeVisible();
    await shareDialog.locator('.share-modal .close-circle-btn').click();
    await expect(shareDialog).toBeHidden();

    await details.click();
    await expect(panel).not.toHaveClass(/is-minimized/);
    await expect(panel.locator('.panel-body')).toBeVisible();
    const record = panel.locator('details[data-proposal-section="record"]');
    await record.locator('summary').click();
    const copy = record.locator('.proposal-id-copy');
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAccessibleName('Copy local ID');
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(proposalId);
  });
});
