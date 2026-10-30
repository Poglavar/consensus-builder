// Exercise proposal modal buttons through the UI, with a local server boundary: the create dialog's
// land-use, summary and road-designation controls, the share panel's selection, Publish and Copy URL,
// and the design index's Refresh.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, showProposal } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const BLOCK_PARCEL_IDS = sampleParcels.features.slice(0, 2).map(feature => feature.properties.parcelId);

async function installProposalBlockGround(page: import('@playwright/test').Page): Promise<void> {
  const features = structuredClone(sampleParcels.features.slice(0, 2));
  features[1].geometry.coordinates[0].forEach(point => { if (point[0] === 15.9826) point[0] = 15.9825; });
  await page.route('**/parcels**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/\/parcels(?:\/parcelIds)?$/.test(url.pathname)) return route.continue();
    const requested = url.searchParams.get('ids')?.split(',');
    return route.fulfill({ json: { type: 'FeatureCollection', features: features.filter(feature => !requested || requested.includes(feature.properties.parcelId)) } });
  });
}

async function openBlockProposalDialog(page: import('@playwright/test').Page): Promise<void> {
  // The block's Create Proposal action opens a new proposal dialog without a forked editor draft,
  // so its land-use choices are not locked to a source design.
  await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[1]);
  await page.locator('#layers-button').click();
  const tools = page.locator('#layers-sheet details.accordion-section[data-section="blocks"]');
  if (!(await tools.evaluate((element: HTMLDetailsElement) => element.open))) await tools.locator('> summary').click();
  await tools.locator('[onclick="animateFloodfillFromSelected()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await tools.locator('[onclick="countBlocks()"]')!.click();
  await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBeGreaterThan(0);
  await page.locator('#showBlockListButton').click();
  await page.locator('#blocks-content .block-item').first().click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
  await expect(page.locator('#block-info-panel')).toBeVisible();
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name: 'Create design', exact: true }).click();
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
}

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Button control tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function openProposalList(page: import('@playwright/test').Page) {
  await page.locator('#proposals-button').click();
  return page.locator('#proposals-sheet');
}

test.describe('proposal button controls: modal and alternate states @features', () => {
  test('fresh proposal land-use choices update the geometry and ownership requirements, and parcels stay as they are', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await installProposalBlockGround(page);
    await openCity(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    for (const landUse of ['square', 'park', 'lake', 'single', 'as-is']) {
      await create.locator(`.proposal-radio:has(input[name="proposalLandUse"][value="${landUse}"])`).click();
      await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.landUse)).toBe(landUse);
      const ownership = landUse === 'single' ? 'to-me' : landUse === 'as-is' ? 'no-change' : 'to-city';
      await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.ownership)).toBe(ownership);
      if (landUse === 'as-is') await expect(create.locator('#proposalParcelsStatic')).toBeHidden();
      else await expect(create.locator('#proposalParcelsStatic')).toBeVisible();
    }
    // New borders are drawn with Lay out parcels: the form offers no readjustment and no per-slice owners.
    await expect(create.locator('input[name="proposalParcelsMode"]')).toHaveCount(1);
    await expect(create.locator('input[name="proposalOwnership"][value="per-slice"]')).toHaveCount(0);
    await expect(create.locator('[data-proposal-main-type="Reparcellization"]')).toHaveCount(0);
    await create.locator('.proposal-radio:has(input[name="proposalParcelsMode"][value="as-is"])').click();
    await expect(create.locator('input[name="proposalParcelsMode"][value="as-is"]')).toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as any).proposalFacets)).toMatchObject({ parcels: 'as-is', ownership: 'no-change' });
    await expect(create.locator('#proposalOwnershipStatic')).toBeHidden();
    await expect(create.locator('#createProposalSubmitButton')).toBeDisabled();
  });

  test('proposal summary expands the selected parcel details and collapses them again', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('#proposalOptionsSection > .collapsible-header').click();
    const toggle = create.locator('#proposalSummarySection > .collapsible-header');
    const content = create.locator('#proposalSummaryContent');
    await expect(content).toBeHidden();
    await toggle.click();
    await expect(content).toBeVisible();
    await expect(content.locator('.proposal-parcel-item')).toHaveCount(BLOCK_PARCEL_IDS.length);
    await toggle.click();
    await expect(content).toBeHidden();
  });

  test('plan composition starts empty, saves locally, then publishes and copies the saved plan', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const id = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showProposal(page, id);
    await page.locator('#proposal-details-panel .btn-share-proposal').click();
    await expect(page.locator('#proposal-details-panel .cb-badge--published')).toBeAttached({ timeout: 30000 });
    await openProposalList(page);
    const sheet = page.locator('#proposals-sheet');
    const shareTab = sheet.locator('#shareAppliedProposalsButton');
    await shareTab.click();
    // Lists (01268caee): the Plans tab's Create plan sits in #lists-actions and starts an empty
    // selection in Lists → Designs; Continue opens the composer listing the ticked designs.
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
    await composer.getByLabel('Plan name', { exact: true }).fill('Button control plan');
    await expect(save).toBeEnabled();
    const index = pageIndex(page);
    const beforeSave = index.requests.filter(request => request.method === 'POST').length;
    await save.click();
    // The saved plan opens in the click stack's Plan section, which holds Share plan.
    const details = page.locator('#click-stack .click-stack__section[data-kind="plans"]');
    await expect(details).toContainText('Button control plan');
    expect(index.requests.filter(request => request.method === 'POST')).toHaveLength(beforeSave);
    await details.getByRole('button', { name: 'Share plan', exact: true }).click();
    const plan = page.locator('.plan-share');
    await expect(plan).toBeVisible();
    await expect(plan.locator('.plan-dialog__members li')).toHaveCount(1);
    const baseline = index.requests.filter(request => request.method === 'POST').length;
    await plan.getByRole('button', { name: 'Publish and copy link', exact: true }).click();
    const link = plan.getByLabel('Plan link', { exact: true });
    await expect(link).toBeVisible();
    const url = new URL(await link.inputValue());
    expect(url.pathname).toMatch(/^\/plans\//);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url.toString());
    const posts = index.requests.filter(request => request.method === 'POST').slice(baseline);
    expect(posts.map(request => request.path)).toContain('/plans');
    expect(posts.some(request => request.path === '/agreements')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(plan).toBeHidden();
  });

  test('road designation close discards the draft while Done commits the selected parcel boundary', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await establishLocalProfile(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('.proposal-radio:has(input[name="proposalLandUse"][value="road-track"])').click();
    await create.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
    const modal = page.locator('.constrained-corridor-overlay');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(() => (window as any).pendingConstrainedCorridor ?? null)).toBeNull();

    await create.locator('#proposalGeometryButtons [data-geometry-action="edit"]').click();
    await expect(modal).toBeVisible();
    await modal.locator('[data-corridor-done]').click();
    await expect(modal).toBeHidden();
    const saved = await page.evaluate(() => (window as any).pendingConstrainedCorridor);
    expect(saved).toMatchObject({ mode: 'full', type: 'road', centerline: [] });
    expect(saved.parcelIds.slice().sort()).toEqual(BLOCK_PARCEL_IDS.slice().sort());
    expect(saved.polygon.type).toMatch(/Polygon/);
  });

  test('the design index Refresh recovers the published list after one failed request', async ({ mockApi: page }) => {
    let requests = 0;
    let allowRecovery = false;
    // The Server tab lists GET /designs (proposals/design-sync.js); newer than the page's index route.
    await page.route(url => /\/designs$/.test(url.pathname), async route => {
      if (route.request().method() !== 'GET' || route.request().isNavigationRequest()) return route.fallback();
      requests += 1;
      if (!allowRecovery) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary test outage' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ designs: [], count: 0 }) });
    });
    await openCity(page);
    // Lists (01268caee): the Published scope reports a failed page in #lists-status; Refresh reloads it.
    const list = await openProposalList(page);
    await expect.poll(() => requests).toBeGreaterThan(0);
    const status = list.locator('#lists-status');
    await expect(status).toHaveText('temporary test outage');
    allowRecovery = true;
    await list.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    // An empty recovered page hides the status and shows the list's empty note instead.
    await expect(status).toBeHidden();
    await expect(list.locator('#proposal-list-host')).toContainText('Nothing here yet.');
  });
});
