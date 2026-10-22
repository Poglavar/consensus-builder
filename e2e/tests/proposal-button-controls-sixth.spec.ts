// Additional proposal-control coverage for editor and sharing actions uses local external boundaries:
// the design index's Download, the create dialog's and details' geometry tools, the lens editor and
// the copy-by-hand link of a published design.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, showProposal, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { cidOfObject, pageIndex } from '../helpers/mocks/shared-server';
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

async function openFreshProposalFromBlock(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[1]);
  await page.locator('#layers-button').click();
  const tools = page.locator('#layers-sheet details.layer-actions:has(> summary[data-i18n-key="mapShell.reorg.blockData"])');
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

// App handlers remain intact; only the API boundary is local.

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal sixth-pass tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

// A park published by someone else, filed in the page's design index under its CID, in the shape
// this app publishes a park (blockName is part of a structure payload): the row the proposal list's
// Server tab lists (GET /designs) and Download reads (GET /designs/:cid).
function indexPublishedPark(page: import('@playwright/test').Page, title: string): string {
  const content = {
    schema: 'design/v1', goal: 'park', title, description: null, author: 'Fixture author', city: 'zagreb',
    site: null, toleranceM: null, geometry: PARCEL_GEOMETRY, origin: null, authoredAt: '2026-10-12T10:00:00.000Z',
    structureProposal: { kind: 'park', geometry: PARCEL_GEOMETRY, blockName: null },
  };
  const cid = cidOfObject(content);
  pageIndex(page).designs.set(cid, {
    cid, city: 'zagreb', goal: 'park', title, author: 'Fixture author', originCid: null,
    binding: { parcels: [{ parcelId: PARCEL_ID, overlapM2: 100, intrusionM: 10 }], touched: [], toleranceM: 0, coverage: 'complete', unsurveyedM2: 0, siteM2: 100, source: 'server:e2e-fixture-cadastre' },
    content, screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null, createdAt: '2026-10-12T10:00:00.000Z',
  });
  return cid;
}

test.describe('proposal button controls sixth pass @features', () => {
  test('server design Download imports the selected record into this browser', async ({ mockApi: page }) => {
    const cid = indexPublishedPark(page, 'Downloadable design');
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    // Neither a local key equal to the CID nor a stale publication mark (content edited after
    // publishing) makes a local record the published design.
    const localIds = await page.evaluate(({ parcelId, cid }) => {
      const w = window as any;
      const store = w.proposalStorage;
      return [
        store.addProposal({ proposalId: cid, title: 'Unrelated local key', goal: 'as-is', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId] }),
        store.addProposal({ proposalId: 'p-stale-mark', title: 'Edited after publishing', goal: 'as-is', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
          published: { cid, publishedAt: '2026-10-12T10:00:00.000Z', apiBase: w.DesignSync.apiBase() } }),
      ];
    }, { parcelId: PARCEL_ID, cid });
    await page.locator('#proposals-button').click();
    const list = page.locator('#proposals-sheet .proposal-list-modal');
    await expect(list.locator(`.proposal-list-item[data-proposal-id="${cid}"]`)).toContainText('Draft');
    await expect(list.locator('.proposal-list-item[data-proposal-id="p-stale-mark"]')).toContainText('Draft');
    await list.locator('.proposal-source-btn[data-source="server"]').click();
    const row = list.locator('.proposal-list-item').filter({ hasText: 'Downloadable design' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-cid', cid);
    await expect(row.locator('.proposal-download-btn')).toBeEnabled();
    await row.locator('.proposal-download-btn').click();
    await expect(row.locator('.proposal-download-btn')).toBeDisabled();
    const importedId = `design-${cid}`;
    await expect.poll(() => page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(id);
      return record ? { title: record.title, cid: w.DesignSync.publishedCid(record), applied: !!w.isApplied(record) } : null;
    }, importedId)).toEqual({ title: 'Downloadable design', cid, applied: false });
    expect(pageIndex(page).requests.some(request => request.method === 'GET' && request.path === `/designs/${cid}`)).toBe(true);
    await row.getByRole('button', { name: 'Details', exact: true }).click();
    await showProposal(page, importedId);
    await expect(page.locator('#proposal-details-panel')).toContainText('Downloadable design');
    expect(await page.evaluate(ids => ids.map(id => (window as any).proposalStorage.getProposal(id).title), localIds))
      .toEqual(['Unrelated local key', 'Edited after publishing']);
  });

  test('create-dialog geometry Edit launches the selected urban-rule geometry tool', async ({ mockApi: page }) => {
    await installProposalBlockGround(page);
    await openCity(page);
    await openFreshProposalFromBlock(page);
    const create = page.locator('.create-proposal-modal:visible');
    await create.locator('.proposal-radio:has(input[name="proposalLandUse"][value="urban-rule"])').click();
    const edit = create.locator('#proposalGeometryButtons [data-geometry-action="edit"]');
    await expect(edit).toBeVisible();
    await edit.click();
    await expect.poll(() => page.evaluate(() => (window as any).getSelectedProposalTool?.())).toBe('buildings');
    const editor = page.locator('#blockify-modal');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await expect(editor.locator('#btn-blockify-done')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const features = (window as any).OnMapEditor?.getPreview?.()?.draftPreview?.features;
      return Array.isArray(features) ? features.filter((feature: any) => feature?.geometry).length : 0;
    })).toBeGreaterThan(0);
  });

  test('details Edit geometry opens the existing proposal geometry tool', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    const edit = page.locator('#proposal-details-footer .btn-edit-geometry');
    await expect(edit).toBeVisible();
    await edit.click();
    await expect(page.locator('#structure-geometry-editor').locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#structure-geometry-editor [data-action="save"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft()?.sourceLocalProposalId)).toBeTruthy();
  });

  test('lens editor Add creates a real address row and Close saves the cleaned list', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-counterpropose-proposal').click();
    const create = page.locator('.create-proposal-modal:visible');
    await expect(create).toBeVisible();
    await create.locator('[data-lens-pattern]').click();
    const lens = page.locator('.lens-modal-overlay');
    await expect(lens).toBeVisible();
    const addressRows = lens.locator('.lens-address-input');
    const before = await addressRows.count();
    await lens.locator('#lens-add-btn').click();
    await expect(addressRows).toHaveCount(before + 1);
    await addressRows.last().fill('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    await lens.locator('.lens-close-btn').click();
    await expect(lens).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).getLensEntries?.().some((entry: any) => entry.address === '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'))).toBe(true);
  });

  test('a published design whose link the clipboard refuses shows it for copying by hand, and both closes dismiss it', async ({ mockApi: page }) => {
    // The operating-system boundary: this clipboard refuses every write.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new DOMException('Clipboard write refused by the test', 'NotAllowedError'); } },
      });
    });
    await openCity(page);
    await establishLocalProfile(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    const index = pageIndex(page);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();

    const modal = page.locator('.share-modal-overlay');
    await expect(modal).toBeVisible({ timeout: 30000 });
    await expect(modal).toContainText('Design published');
    await expect(modal).toContainText('The link could not be copied automatically. Copy it from here:');
    const [cid] = [...index.designs.keys()];
    const link = `${new URL(page.url()).origin}/designs/${cid}?city=zg&3d&lang=en`;
    const input = modal.locator('.design-link__input');
    await expect(input).toHaveValue(link);
    await expect(input).toBeFocused();
    expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, link.length]);
    await modal.locator('.share-modal .close-circle-btn').click();
    await expect(modal).toBeHidden();

    // Shared again, the design is already published: the same link, nothing sent again.
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.design-link__input')).toHaveValue(link);
    await modal.locator('.share-modal .cb-dialog__footer .btn-primary').click();
    await expect(modal).toBeHidden();
    expect(index.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/pins', '/designs']);
  });
});
