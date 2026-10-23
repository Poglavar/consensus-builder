// Phone regressions: useful list space, direct map sharing, published layouts and absent permitted sources.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, PARCEL_ID, openOnAnotherDevice, chooseProfileName, showProposal } from '../helpers/runtime';
import { applyLayout, editorOpen, editorSave, editorClosed, landLoaded, agreementPanel, panelStatus } from '../helpers/agreements';
import { fileDesign, pageIndex } from '../helpers/mocks/shared-server';

test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

test('Designs gives most of a phone screen to cards with actions always visible', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(parcelId => {
    const w = window as any;
    for (let i = 0; i < 15; i++) w.proposalStorage.addProposal({ title: `Neighbourhood design ${i}`, goal: 'park', author: 'Test author', cadastreParcelIds: [parcelId] });
  }, PARCEL_ID);
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet.getByRole('heading', { name: 'Designs', exact: true })).toBeVisible();
  await expect(sheet.locator('.proposal-list-item')).toHaveCount(15);
  const body = await sheet.locator('.proposal-list-modal-body').boundingBox();
  expect(body!.height).toBeGreaterThan(844 * 0.55);
  await expect(sheet.locator('.proposal-list-item').first()).toBeInViewport({ ratio: 1 });
  await expect(sheet.locator('#agreementsButton')).toBeVisible();
  await expect(sheet.locator('#planStatsButton')).toBeVisible();
  await expect(sheet.locator('#proposal-list-actions summary')).toHaveCount(0);
  await expect(sheet.locator('.proposal-list-navigation-hint')).toHaveCount(0);
  await sheet.locator('.proposal-filters-toggle').click();
  await expect(sheet.locator('#proposal-filter-publication')).toHaveText(/Draft.*Published/);
  await expect(sheet.locator('#proposal-filter-lifecycle')).toHaveCount(0);
  await sheet.locator('.proposal-filters-toggle').click();
  await sheet.locator('.proposal-list-modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(sheet.locator('.proposal-list-item').last()).toBeInViewport({ ratio: 1 });
});

test('Share is one tap from an empty map and offers its location without a profile gate', async ({ mockApi: page }) => {
  await openCity(page);
  const at = await page.evaluate(() => { const w = window as any; const c = w.map.getCenter(); return [c.lat, c.lng, w.map.getZoom()].join(','); });
  await page.locator('#shareAppliedProposalsButton').click();
  const input = page.locator('.share-modal .share-plan-link__input');
  await expect(input).toBeVisible();
  const url = new URL(await input.inputValue());
  expect(url.searchParams.get('at')).toBe(at);
  expect(url.searchParams.has('3d')).toBe(false);
  await expect(page.locator('#proposals-sheet')).toBeHidden();
});

test('a published parcel layout starts checked and produces its existing link; an unpublished layout explains the agreement path', async ({ mockApi: page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const { layoutId } = await applyLayout(page);
  await page.locator('#shareAppliedProposalsButton').click();
  const panel = page.locator('.share-plan-panel');
  const row = panel.locator('.share-plan-row');
  await expect(row.locator('input')).toBeChecked();
  await expect(row.locator('input')).toBeEnabled();
  await expect(row.locator('.share-plan-row__refusal')).toBeVisible();
  await expect(panel.locator('.share-plan-create-agreement')).toBeVisible();
  await expect(panel.locator('.share-plan-link')).toBeHidden();
  await panel.locator('.close-circle-btn').click();
  const content = await page.evaluate(id => (window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)), layoutId);
  const cid = fileDesign(pageIndex(page), content);
  await page.evaluate(({ id, cid }) => {
    const w = window as any;
    w.DesignSync.markPublished(w.proposalStorage.getProposal(id), { cid, apiBase: w.resolveBackendBaseUrl(), publishedAt: new Date().toISOString() });
  }, { id: layoutId, cid });
  await page.locator('#shareAppliedProposalsButton').click();
  await expect(row.locator('input')).toBeChecked();
  await expect(row.locator('input')).toBeEnabled();
  await expect(row.locator('.share-plan-row__published')).toBeVisible();
  await expect(row.locator('.share-plan-row__refusal')).toHaveCount(0);
  await expect(row).not.toHaveClass(/is-excluded/);
  const link = panel.locator('.share-plan-link__input');
  await expect(link).toBeVisible();
  const url = new URL(await link.inputValue());
  expect(url.pathname).toBe(`/designs/${cid}`);
  const receiver = await openOnAnotherDevice(browser, url.pathname + url.search, pageIndex(page), baseURL);
  try {
    await expect.poll(() => receiver.page.evaluate(id => {
      const w = window as any; const p = w.proposalStorage.getProposal(`design-${id}`);
      return p && w.isApplied(p) && p.parcelLayout.plots.length > 0;
    }, cid), { timeout: 60_000 }).toBe(true);
  } finally { await receiver.context.close(); }
  expect(pageIndex(page).requests.filter(request => request.method === 'POST' && request.path !== '/designs/batch')).toEqual([]);
  await panel.locator('.close-circle-btn').click();
  await showProposal(page, layoutId);
  await expect(page.locator('#proposal-details-panel .btn-share-proposal')).toBeEnabled();
  await expect(page.locator('#proposal-publish-later-note')).toHaveCount(0);
});

test('2D massing puts Permitted first and disables it cleanly when there is no source', async ({ mockApi: page }) => {
  await page.route('**/planning/sources?**', route => route.fulfill({ json: { city: 'zagreb', sources: [] } }));
  await openCity(page);
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  await expect(panel.locator('.planning-map-context')).toHaveText('Compare building footprints and massing on the 2D map.');
  const rows = panel.locator('.planning-layer-row');
  await expect(rows.first().locator('[data-role-label]')).toHaveAttribute('data-role-label', 'permitted');
  await expect(rows.nth(1).locator('[data-role-label]')).toHaveAttribute('data-role-label', 'existing');
  await expect(rows.first()).toHaveAttribute('aria-disabled', 'true');
  await expect(rows.first().locator('[data-planning-setting="permitted"]')).toBeDisabled();
  await expect(rows.nth(1).locator('[data-planning-setting="existing"]')).toBeEnabled();
  await expect(panel.locator('.planning-source-select')).toBeHidden();
  await expect(panel.locator('.planning-source-note').last()).toBeHidden();
  await expect(panel.locator('.planning-coverage')).toBeHidden();
  await expect(panel.locator('.planning-view-status')).toBeHidden();
});


test('a blocked layout can create and publish its agreement, then Share includes it without deselecting', async ({ mockApi: page }) => {
  test.setTimeout(150_000);
  await applyLayout(page);
  await page.locator('#shareAppliedProposalsButton').click();
  const share = page.locator('.share-plan-panel');
  await expect(share.locator('.share-plan-status')).toContainText('or deselect it');
  await share.locator('.share-plan-create-agreement').click();
  const editor = await editorOpen(page, 'Create agreement');
  await landLoaded(editor);
  await editor.locator('input[name="agreement-electorate"][value="community"]').check();
  await editor.locator('[data-agreement-title]').fill('Neighbourhood agreement');
  await editorSave(editor).click();
  await editorClosed(page);
  await panelStatus(page, 'current');
  const agreement = agreementPanel(page);
  const box = await agreement.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(844 / 2 + 1);
  await expect(agreement.locator('.agreement-panel-kind')).toHaveText('Agreement');
  await expect(agreement.locator('[data-agreement-action="close"]')).toBeHidden();
  await expect(agreement.getByRole('button', { name: 'Remove from this device', exact: true })).toBeVisible();
  await agreement.locator('[data-agreement-action="propose"]').click();
  await chooseProfileName(page, 'Neighbourhood author');
  await agreement.locator('[data-agreement-action="propose"]').click();
  await expect(agreement.locator('code.agreement-panel-cid')).toBeVisible({ timeout: 30_000 });
  await agreement.locator('.mobile-dock-sheet-handle').click();
  await expect(agreement).toBeHidden();
  await page.locator('#shareAppliedProposalsButton').click();
  await expect(share.locator('.share-plan-row input')).toBeChecked();
  await expect(share.locator('.share-plan-row__published')).toBeVisible();
  await expect(share.locator('.share-plan-link__input')).toBeVisible();
});

test('wrong-city choices have equal touch areas on a phone', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => { void (window as any).promptCityMismatchForProposal('birmingham'); });
  const prompt = page.locator('.city-switch-dialog');
  await expect(prompt).toBeVisible();
  const stay = await prompt.locator('[data-action-id="stay"]').boundingBox();
  const open = await prompt.locator('[data-action-id="switch"]').boundingBox();
  expect(stay!.width).toBeCloseTo(open!.width, 0);
  expect(stay!.height).toBeCloseTo(open!.height, 0);
  expect(stay!.height).toBeGreaterThanOrEqual(44);
  expect(open!.y).toBeGreaterThanOrEqual(stay!.y + stay!.height);
  await prompt.locator('[data-action-id="stay"]').click();
});
