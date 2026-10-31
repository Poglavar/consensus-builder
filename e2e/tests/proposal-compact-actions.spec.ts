// These browser regressions exercise the proposal reader from its actual Proposals list entry.
// They cover compact-card actions and the narrow mobile footer, where a visible button must remain
// reachable and complete its real UI transition rather than merely exist in the rendered markup.
import { test, expect } from '../helpers/fixtures';
import { openCity, proposalState, showProposal, PARCEL_GEOMETRY, PARCEL_ID, showProposalTab } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';

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

// Share publishes the design into the page's index and copies its /designs/<cid> link.
async function expectSharedAsDesign(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await expect.poll(() => pageIndex(page).designs.size, { timeout: 30_000 }).toBe(1);
  const [cid] = [...pageIndex(page).designs.keys()];
  expect(await page.evaluate(id => (window as any).DesignSync.publishedCid((window as any).proposalStorage.getProposal(id)), proposalId)).toBe(cid);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`/designs/${cid}?`);
}

async function openCompactFromProposalList(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await page.locator('#proposals-button').click();
  const list = page.locator('#proposals-sheet #proposal-list-host');
  const row = list.locator(`.lists-item[data-list-id="${proposalId}"]`);
  await expect(row).toBeVisible();
  // This is the actual list action that opens proposal details (Lists: the row's Open),
  // not a direct JS call to the panel.
  await row.locator('.lists-item__open').click();
  await expect(page.locator('#planning-inspector')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/is-hosted/);
  await expect(panel.locator('#proposal-details-minimize')).toBeHidden();
  await page.locator('#click-stack [data-page="actions"]').click();
}

test.describe('compact proposal card actions @features', () => {
  test('the real list opens a compact card whose Duplicate, Edit, Share and Map buttons perform their actions', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page, 'Compact action author');
    const proposalId = await addLocalEditableProposal(page, 'actions');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const sourceBefore = await proposalState(page, proposalId);
    await openCompactFromProposalList(page, proposalId);

    const panel = page.locator('#proposal-details-panel');
    const footer = panel.locator('#proposal-details-footer');
    await expect(footer.locator('.btn-duplicate-design')).toBeVisible();
    await expect(footer.locator('.btn-edit-geometry')).toBeVisible();
    await expect(footer.locator('.btn-share-proposal')).toBeVisible();
    await expect(page.locator('#click-stack [data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('[data-proposal-tab="details"]')).toHaveCount(0);
    const mapButton = footer.locator(`#proposal-action-btn-${proposalId}`);
    await expect(mapButton).toBeVisible();

    await footer.locator('.btn-duplicate-design').click();
    await expect(page.locator('#design-duplicate-editor .on-map-editor__panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#design-duplicate-editor')).toHaveCount(0);
    expect((await proposalState(page, proposalId)).title).toBe(sourceBefore.title);

    // Duplication closes the compact details card; reopen it through the real Proposals list before
    // exercising the next footer action.
    await openCompactFromProposalList(page, proposalId);
    await footer.locator('.btn-share-proposal').click();
    await expectSharedAsDesign(page, proposalId);

    await footer.locator('.btn-edit-geometry').click();
    const editor = page.locator('#structure-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
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

  test('the Info tab and mobile 320px actions keep Share and Copy usable', async ({ mockApi: page }) => {
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
    const infoTab = page.locator('#click-stack [data-page="design-overview"]');
    await share.scrollIntoViewIfNeeded();
    await expect(share).toBeInViewport({ ratio: 1 });
    await infoTab.scrollIntoViewIfNeeded();
    await expect(infoTab).toBeInViewport({ ratio: 0.95 });
    const dimensions = await page.evaluate(() => {
      const footer = document.querySelector('#proposal-details-footer') as HTMLElement;
      return { scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth };
    });
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await share.scrollIntoViewIfNeeded();
    await share.click();
    await expectSharedAsDesign(page, proposalId);

    await showProposalTab(page, 'overview');
    await expect(infoTab).toHaveAttribute('aria-selected', 'true');
    const record = panel.locator('#proposal-details-content details[data-proposal-section="record"]');
    await record.scrollIntoViewIfNeeded();
    if (!(await record.evaluate(element => (element as HTMLDetailsElement).open))) {
      await record.locator(':scope > summary').click();
    }
    const copy = record.locator('.proposal-id-copy');
    await copy.scrollIntoViewIfNeeded();
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAccessibleName('Copy local ID');
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(proposalId);
  });
});
