// Verify the map search's published-design download through its browser effects: the design index
// answers GET /designs?q=, Cancel keeps it off this device and Download imports and opens it.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, PARCEL_GEOMETRY } from '../helpers/runtime';
import { cidOfObject, pageIndex } from '../helpers/mocks/shared-server';

test.describe('proposal button controls fourth pass @features', () => {
  test('map search Cancel declines a remote download and Download imports and opens it', async ({ mockApi: page }) => {
    // A park published by someone else: its design/v1 object, filed in the index under its CID, in
    // the shape this app publishes a park (blockName is part of a structure payload).
    const content = {
      schema: 'design/v1', goal: 'park', title: 'Remote proposal', description: null, author: 'Tester', city: 'zagreb',
      site: null, toleranceM: null, geometry: PARCEL_GEOMETRY, origin: null, authoredAt: '2026-10-12T10:00:00.000Z',
      structureProposal: { kind: 'park', geometry: PARCEL_GEOMETRY, blockName: null },
    };
    const cid = cidOfObject(content);
    const index = pageIndex(page);
    index.designs.set(cid, {
      cid, city: 'zagreb', goal: 'park', title: 'Remote proposal', author: 'Tester', originCid: null,
      binding: { parcels: [], touched: [], toleranceM: 0, coverage: 'complete', unsurveyedM2: 0, siteM2: 0, source: 'server:e2e-fixture-cadastre' },
      content, screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null, createdAt: '2026-10-12T10:00:00.000Z',
    });
    await openCity(page);
    const localId = `design-${cid}`;
    const held = () => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), localId);

    const search = page.getByRole('combobox', { name: 'Search the map' });
    const results = page.locator('.map-search__results [role="option"]');
    const confirm = page.locator('.cb-dialog-overlay--confirm');
    const chooseRemoteProposal = async () => {
      if (await search.isHidden()) await page.locator('.map-search__icon-button').click();
      await search.fill('Remote proposal');
      const result = results.filter({ hasText: 'Remote proposal' }).first();
      await expect(result).toBeVisible();
      await result.click();
    };

    await chooseRemoteProposal();
    expect(index.requests.some(request => request.method === 'GET' && request.path.startsWith('/designs?q=Remote'))).toBe(true);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toBeHidden();
    expect(await held()).toBe(false);

    await chooseRemoteProposal();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect.poll(held).toBe(true);
    const imported = await page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(id);
      return { title: record.title, cid: w.DesignSync.publishedCid(record), applied: !!w.isApplied(record) };
    }, localId);
    // Imported as published, parked: downloading never applies it.
    expect(imported).toEqual({ title: 'Remote proposal', cid, applied: false });
    await showProposal(page, localId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-title')).toHaveText('Remote proposal');
  });
});
