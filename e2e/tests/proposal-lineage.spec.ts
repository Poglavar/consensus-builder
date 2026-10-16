// Purpose: an original proposal lists the counterproposals and forks made from it (the server's
// published ones and this browser's drafts), each opens from the list, and a fork whose source was
// never published says so instead of showing a dead name.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';
import type { Page } from '@playwright/test';

const square = [[[15.9819, 45.8], [15.9821, 45.8], [15.9821, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]]];

async function seed(page: Page, record: Record<string, unknown>): Promise<string> {
  return page.evaluate(({ record, parcel, coordinates }) => (window as any).proposalStorage.addProposal({
    goal: 'single-building', lifecycleStatus: 'Active', cadastreParcelIds: [parcel], acceptedParcelIds: [],
    geometry: { type: 'Polygon', coordinates }, ...record
  }), { record, parcel: PARCEL_ID, coordinates: square });
}

const lineage = (page: Page) => page.locator('#proposal-details-panel [data-proposal-lineage]');

test('the original lists its counterproposals, each opens, and an unpublished source is named as a draft', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await page.route('**/proposals/879/lineage', route => route.fulfill({ json: {
    id: 879, proposalId: 'c2-original',
    source: { published: false, proposalId: 'p-draft', title: 'First sketch' },
    derived: [{ id: 901, proposalId: 'c2-published-fork', title: 'Published counterproposal', author: 'Owner C', status: 'Active', landFork: true }]
  } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const original = await seed(page, { proposalId: 'c2-original', serverProposalId: '879', title: 'Original plan',
    sourceProposalId: 'p-draft', copiedFromName: 'First sketch' });
  await seed(page, { title: 'Local counterproposal', sourceProposalId: original, copiedFromName: 'Original plan' });

  await showProposal(page, original);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(lineage(page)).toBeVisible();
  await expect(lineage(page)).toContainText('Counterproposals and forks (2)');
  await expect(lineage(page).locator('li')).toHaveText([
    'Published counterproposal Owner C · on different land',
    'Local counterproposal only in this browser'
  ]);
  // The source this browser never had is reported by the server as a draft that was never shared.
  await expect(page.locator('#proposal-details-panel .proposal-based-on-row'))
    .toContainText('First sketch (a draft that was never published)');

  await lineage(page).getByRole('button', { name: 'Local counterproposal' }).click();
  await expect(page.locator('#proposal-details-panel')).toContainText('Local counterproposal');
  // The fork links back to the original it was made from.
  await expect(page.locator('#proposal-details-panel .proposal-based-on-link')).toHaveText('Original plan');
});
