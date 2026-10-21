// Purpose: an original proposal lists the counterproposals and forks made from it (the server's
// published ones and this browser's drafts), each opens from the list, and a fork whose source
// is not found in this publication store says so without inventing a publication history.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, showProposal } from '../helpers/runtime';
import type { Page } from '@playwright/test';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

const square = [[[15.9819, 45.8], [15.9821, 45.8], [15.9821, 45.8005], [15.9819, 45.8005], [15.9819, 45.8]]];

async function seed(page: Page, record: Record<string, unknown>): Promise<string> {
  return page.evaluate(({ record, parcel, coordinates }) => (window as any).proposalStorage.addProposal({
    goal: 'park', lifecycleStatus: 'Active',
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    cadastreParcelIds: [parcel], acceptedParcelIds: [],
    geometry: { type: 'Polygon', coordinates }, ...record
  }), { record, parcel: PARCEL_ID, coordinates: square });
}

const lineage = (page: Page) => page.locator('#proposal-details-panel [data-proposal-lineage]');

test('the original lists its counterproposals, each opens, and a missing source stays unresolved', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await openCity(page);
  const apiBase = await page.evaluate(() => (window as any).getBackendBase());
  const server = createSharedProposalServer();
  server.records.set('901', {
    id: 901, proposalId: 'c2-published-fork', title: 'Published counterproposal', goal: 'park',
    lifecycleStatus: 'Active',
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    publicationApiBase: apiBase,
    proposalOrigin: { relation: 'copy', source: { kind: 'publication', apiBase, proposalRowId: '879' }, title: 'Original plan' },
    cadastreParcelIds: [PARCEL_ID], geometry: { type: 'Polygon', coordinates: square },
  });
  await attachSharedProposalServer(page, server);
  await page.route('**/proposals/879/lineage', route => route.fulfill({ json: {
    proposalRowId: 879, authoredProposalId: 'c2-original', publicationApiBase: apiBase,
    source: { resolution: 'not-found', reference: { kind: 'publication', apiBase, proposalRowId: '878' }, title: 'First sketch' },
    derived: [{ proposalRowId: 901, publicationApiBase: apiBase, authoredProposalId: 'c2-published-fork', title: 'Published counterproposal', author: 'Owner C', status: 'Active', landFork: true }]
  } }));
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const original = await seed(page, { proposalId: 'c2-original', serverProposalId: '879', title: 'Original plan',
    publicationApiBase: apiBase,
    proposalOrigin: { relation: 'copy', source: { kind: 'publication', apiBase, proposalRowId: '878' }, title: 'First sketch' } });
  const localCounterId = await seed(page, { proposalId: '901', title: 'Local counterproposal',
    proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: original }, title: 'Original plan' } });

  await showProposal(page, original);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(lineage(page)).toBeVisible();
  await expect(lineage(page)).toContainText('Counterproposals and forks (2)');
  await expect(lineage(page).locator('li')).toHaveText([
    'Published counterproposal Owner C · on different land',
    'Local counterproposal only in this browser'
  ]);
  // An absent lookup does not prove that the source was never published.
  await expect(page.locator('#proposal-details-panel .proposal-based-on-row'))
    .toContainText('First sketch (source not found in this publication store)');

  await lineage(page).getByRole('button', { name: 'Local counterproposal' }).click();
  await expect(page.locator('#planning-inspector')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(localCounterId);
  await showProposal(page, localCounterId);
  await expect(page.locator('#proposal-details-panel')).toContainText('Local counterproposal');
  // The fork links back to the original it was made from.
  const localOriginLink = page.locator('#proposal-details-panel .proposal-based-on-link');
  await expect(localOriginLink).toHaveText('Original plan');
  await expect(localOriginLink).toHaveAttribute('data-lineage-local-id', 'c2-original');
  await showProposal(page, original);
  if (await expand.isVisible()) await expand.click();
  await lineage(page).getByRole('button', { name: 'Published counterproposal' }).click();
  await expect(page.locator('#planning-inspector')).toContainText('Published counterproposal');
  await expect.poll(() => page.evaluate(base => {
    const selected = (window as any).PlanningViews.getSelected();
    const record = selected?.proposalId && (window as any).proposalStorage.getProposal(selected.proposalId);
    return record?.serverProposalId === '901' && record?.publicationApiBase === base;
  }, apiBase)).toBe(true);
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('901').title)).toBe('Local counterproposal');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposalByServerRowId('901', (window as any).getBackendBase()).title)).toBe('Published counterproposal');
});

// A server-resolved source replaces any ambiguous local link and opens only the explicitly linked
// published copy, even when other local keys equal its row ID or authored ID.
test('a published source link selects its explicit row copy despite local key collisions', async ({ mockApi: page }) => {
  await openCity(page);
  const apiBase = await page.evaluate(() => (window as any).getBackendBase());
  const server = createSharedProposalServer();
  server.records.set('880', {
    id: 880, proposalId: 'c2-published-source', title: 'Published source', goal: 'park',
    lifecycleStatus: 'Active',
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    publicationApiBase: apiBase,
    cadastreParcelIds: [PARCEL_ID], geometry: { type: 'Polygon', coordinates: square },
  });
  await attachSharedProposalServer(page, server);
  let lineageUnavailable = false;
  await page.route('**/proposals/902/lineage', route => lineageUnavailable ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: {
    proposalRowId: 902, authoredProposalId: 'c2-fork', publicationApiBase: apiBase,
    source: { resolution: 'resolved', reference: { kind: 'publication', apiBase, proposalRowId: '880' },
      proposalRowId: 880, publicationApiBase: apiBase, authoredProposalId: 'c2-published-source', title: 'Published source' },
    derived: []
  } }));
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const fork = await seed(page, { proposalId: 'c2-fork', serverProposalId: '902', title: 'Fork of a published source',
    publicationApiBase: apiBase,
    proposalOrigin: { relation: 'copy', source: { kind: 'publication', apiBase, proposalRowId: '880' }, title: 'Published source' } });
  await seed(page, { proposalId: '880', title: 'Unrelated numeric local record' });
  await seed(page, { proposalId: 'c2-published-source', title: 'Local authored-key collision' });
  await seed(page, { proposalId: 'p-actual-source-copy', serverProposalId: '880', publicationApiBase: apiBase, title: 'Published source' });

  await showProposal(page, fork);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const link = page.locator('#proposal-details-panel .proposal-based-on-link');
  await expect(link).toHaveText('Published source');
  await expect(link).toHaveAttribute('data-lineage-row-id', '880');
  await expect(link).toHaveAttribute('data-lineage-api-base', apiBase);
  await link.click();
  const inspector = page.locator('#planning-inspector');
  await expect(inspector).toContainText('Published source');
  const selectedSourceId = await page.evaluate(() => (window as any).currentlyHighlightedProposalId);
  expect(await page.evaluate(id => {
    const source = (window as any).proposalStorage.getProposal(id);
    return { rowId: source?.serverProposalId, apiBase: source?.publicationApiBase };
  }, selectedSourceId)).toEqual({ rowId: '880', apiBase });
  await showProposal(page, selectedSourceId);
  await expect(page.locator('#proposal-details-title')).toHaveText('Published source');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('880').title)).toBe('Unrelated numeric local record');
  expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('c2-published-source').title)).toBe('Local authored-key collision');
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .some((p: any) => String(p.serverProposalId) === '880'))).toBe(true);
  lineageUnavailable = true;
  await showProposal(page, fork);
  if (await expand.isVisible()) await expand.click();
  await expect(lineage(page)).toContainText('Published proposal relationships could not be loaded.');
  await expect(lineage(page)).not.toContainText('No related proposals');
});
