// Exercise proposal modal buttons through the UI, with a local server boundary: the create dialog's
// land-use, summary and road-designation controls, the share panel's selection, Publish and Copy URL,
// the epoch timeline and the design index's Retry.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, PARCEL_ID } from '../helpers/runtime';
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
  await page.locator('#layers-sheet [data-sheet-close]').click();
  await expect(page.locator('#block-info-panel')).toBeVisible();
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name: 'Create proposal', exact: true }).click();
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
  return page.locator('#proposals-sheet .proposal-list-modal');
}

test.describe('proposal button controls: modal and alternate states @features', () => {
  test('fresh proposal land-use choices update the geometry and ownership requirements, and parcels stay as they are', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await installProposalBlockGround(page);
    await openCity(page);
    await openBlockProposalDialog(page);
    const create = page.locator('.create-proposal-modal:visible');
    for (const landUse of ['square', 'lake', 'single', 'as-is']) {
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

  test('applied-design selection, row Publish and Copy URL all change the visible state', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const id = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await openProposalList(page);
    const sheet = page.locator('#proposals-sheet');
    const shareTab = sheet.getByRole('tab', { name: 'Share', exact: true });
    await shareTab.click();

    const plan = sheet.locator('#designs-share .share-plan-panel--embedded');
    await expect(plan).toBeVisible({ timeout: 30000 });
    await expect(sheet.getByRole('heading', { name: 'Designs', exact: true })).toBeVisible();
    await expect(shareTab).toHaveAttribute('aria-selected', 'true');
    await expect(plan.locator('.share-plan-progress')).toHaveCount(0, { timeout: 30000 });
    await test.info().attach('applied-design-sharing', { body: await plan.screenshot(), contentType: 'image/png' });
    const highlightAll = plan.getByRole('button', { name: 'All', exact: true });
    await plan.getByRole('button', { name: 'Not published yet', exact: true }).click();
    await highlightAll.click();
    await expect(highlightAll).toHaveAttribute('aria-pressed', 'true');
    const status = plan.locator('.share-plan-status');
    const row = plan.locator('.share-plan-row').first();
    const selected = row.locator('input[type="checkbox"]');
    await selected.focus();
    await expect(selected).toBeFocused();
    await selected.uncheck();
    await expect(status).toHaveText('Select at least one design to share.');
    await selected.check();
    await expect(status).toHaveText('Publish at least one design to get a link.');
    const link = plan.locator('.share-plan-link__input');
    await expect(link).toBeHidden();

    // Publish pins and indexes this one design; the row says Published and the link names its CID.
    const index = pageIndex(page);
    await row.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(row.locator('.share-plan-row__published')).toBeVisible({ timeout: 30000 });
    expect(index.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/pins', '/designs']);
    const [cid] = [...index.designs.keys()];
    expect(await page.evaluate(key => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(key);
      return { published: record.published.cid, current: w.DesignSync.publishedCid(record) };
    }, id)).toEqual({ published: cid, current: cid });
    const url = new URL(await link.inputValue());
    expect(url.pathname).toBe(`/designs/${cid}`);
    expect(url.searchParams.get('city')).toBe('zagreb');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('at')).toBe(await page.evaluate(() => (window as any).MapShare.capture(window).at));
    await expect(status).toHaveText('');
    await plan.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url.toString());
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('proposal list epoch buttons move the cumulative timeline and restore all years', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate((parcelId) => {
      const storage = (window as any).proposalStorage;
      storage.addProposal({ title: 'Early stage', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], epochYear: 2035 });
      storage.addProposal({ title: 'Later stage', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId], epochYear: 2045 });
    }, PARCEL_ID);
    const list = await openProposalList(page);
    const timeline = list.locator('.proposal-epoch-timeline');
    await expect(timeline).toBeVisible();
    await timeline.getByRole('button', { name: '2035.', exact: true }).click();
    await expect(timeline.getByRole('button', { name: '2035.', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(timeline).toContainText(/Cumulative to 2035/);
    await timeline.getByRole('button', { name: '2045.', exact: true }).click();
    await expect(timeline.getByRole('button', { name: '2045.', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await timeline.getByRole('button', { name: 'All', exact: true }).click();
    await expect(timeline.locator('.proposal-epoch-diff')).toHaveCount(0);
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

  test('the design index Retry recovers the proposal list after one failed request', async ({ mockApi: page }) => {
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
    const list = await openProposalList(page);
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    const retry = list.locator('.proposal-server-retry');
    await expect(retry).toBeVisible();
    allowRecovery = true;
    await retry.click();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    await expect(list.locator('.proposal-list-error')).toHaveCount(0);
  });
});
