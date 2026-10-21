// Verify proposal download actions through their browser effects.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

test.describe('proposal button controls fourth pass @features', () => {
  test('map search Cancel declines a remote download and Download imports and opens it', async ({ mockApi: page }) => {
    let detailRequests = 0;
    await page.route('**/proposals/summary?*', route => route.fulfill({ json: {
      proposals: [{ id: '777', proposalId: 'remote-proposal-777', title: 'Remote proposal', author: 'Tester', goal: 'park' }],
    } }));
    await page.route('**/proposals/777', route => {
      detailRequests += 1;
      return route.fulfill({ json: {
        id: '777', proposalId: 'remote-proposal-777', title: 'Remote proposal', author: 'Tester', goal: 'park',
        lifecycleStatus: 'Active', cityId: 'zagreb', cadastreParcelIds: [PARCEL_ID], geometry: PARCEL_GEOMETRY,
      } });
    });
    await openCity(page);

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
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toBeHidden();
    expect(detailRequests).toBe(0);

    await chooseRemoteProposal();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(confirm).toBeHidden();
    const importedId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.serverProposalId === '777')?.proposalId);
    expect(importedId).toBeTruthy();
    await showProposal(page, importedId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-title')).toHaveText('Remote proposal');
    expect(detailRequests).toBe(1);
  });
});
