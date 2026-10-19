// Purpose: an original proposal lists the counterproposals and forks made from it (the server's
// published ones and this browser's drafts), each opens from the list, and a fork whose source was
// never published says so instead of showing a dead name.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';
import type { Page } from '@playwright/test';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

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
  const server = createSharedProposalServer();
  server.records.set('901', {
    id: 901, proposalId: 'c2-published-fork', title: 'Published counterproposal', goal: 'single-building',
    lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID], geometry: { type: 'Polygon', coordinates: square },
  });
  await attachSharedProposalServer(page, server);
  await page.route('**/proposals/879/lineage', route => route.fulfill({ json: {
    id: 879, proposalId: 'c2-original',
    source: { published: false, proposalId: 'p-draft', title: 'First sketch' },
    derived: [{ id: 901, proposalId: 'c2-published-fork', title: 'Published counterproposal', author: 'Owner C', status: 'Active', landFork: true }]
  } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const original = await seed(page, { proposalId: 'c2-original', serverProposalId: '879', title: 'Original plan',
    sourceProposalId: 'p-draft', copiedFromName: 'First sketch' });
  await seed(page, { proposalId: '901', title: 'Local counterproposal', sourceProposalId: original, copiedFromName: 'Original plan' });

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
  await showProposal(page, original);
  if (await expand.isVisible()) await expand.click();
  await lineage(page).getByRole('button', { name: 'Published counterproposal' }).click();
  await expect(page.locator('#proposal-details-title')).toHaveText('Published counterproposal');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('901').title)).toBe('Local counterproposal');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposalByServerRowId('901').title)).toBe('Published counterproposal');
});

// A server-resolved source replaces any ambiguous local link and opens only the explicitly linked
// published copy, even when other local keys equal its row ID or authored ID.
test('a published source link selects its explicit row copy despite local key collisions', async ({ mockApi: page }) => {
  const server = createSharedProposalServer();
  server.records.set('880', {
    id: 880, proposalId: 'c2-published-source', title: 'Published source', goal: 'single-building',
    lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID], geometry: { type: 'Polygon', coordinates: square },
  });
  await attachSharedProposalServer(page, server);
  await page.route('**/proposals/902/lineage', route => route.fulfill({ json: {
    id: 902, proposalId: 'c2-fork',
    source: { published: true, id: 880, proposalId: 'c2-published-source', title: 'Published source' },
    derived: []
  } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const fork = await seed(page, { proposalId: 'c2-fork', serverProposalId: '902', title: 'Fork of a published source',
    sourceProposalId: 'c2-published-source', copiedFromName: 'Published source' });
  await seed(page, { proposalId: '880', title: 'Unrelated numeric local record' });
  await seed(page, { proposalId: 'c2-published-source', title: 'Local authored-key collision' });
  await seed(page, { proposalId: 'p-actual-source-copy', serverProposalId: '880', title: 'Published source' });

  await showProposal(page, fork);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const link = page.locator('#proposal-details-panel .proposal-based-on-link');
  await expect(link).toHaveText('Published source');
  await link.click();
  await expect(page.locator('#proposal-details-title')).toHaveText('Published source');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('880').title)).toBe('Unrelated numeric local record');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('c2-published-source').title)).toBe('Local authored-key collision');
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .some((p: any) => String(p.serverProposalId) === '880'))).toBe(true);
});
