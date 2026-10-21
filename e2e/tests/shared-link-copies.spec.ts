import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';

test('shared links ignore numeric local keys and fork ancestry, then reuse the exact published copy', async ({ mockApi: page }) => {
  await openCity(page);
  await page.waitForFunction(() => (window as any).ProposalManager._initialReapplyDone === true);
  let lifecycleStatus = 'Cancelled';
  const published = () => ({ id: 42, proposalId: 'p-linked-publication', title: 'Linked published park',
    kind: 'owner-deal', goal: 'park', cadastreParcelIds: [PARCEL_ID], lifecycleStatus,
    site: PARCEL_GEOMETRY, structureProposal: { kind: 'park', geometry: PARCEL_GEOMETRY } });
  await page.route('**/proposals/batch', route => {
    const ids = route.request().postDataJSON().ids;
    return route.fulfill({ json: { items: ids.map((id: string) => ({ id, proposal: published() })) } });
  });
  await page.evaluate(parcelId => {
    const w = window as any;
    w.shouldSkipWelcomeForProposalLink = () => true;
    w.proposalStorage.addProposal({ proposalId: '42', title: 'Unrelated numeric local key',
      goal: 'as-is', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    w.proposalStorage.addProposal({ proposalId: 'p-local-fork', title: 'Separate local fork', goal: 'as-is',
      sourceProposalId: '42', replacementOfProposalId: '42', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    for (const p of w.proposalStorage.peekAllProposals()) p.applied = true;
  }, PARCEL_ID);
  const result = await page.evaluate(() => (window as any).handleSharedPlanRoute(['42'], 0, { suppressSummary: true }));
  expect(result.skipped).toEqual([]);
  expect(result.failed).toEqual([]);
  const records = await page.evaluate(() => (window as any).proposalStorage.peekAllProposals().map((p: any) => ({
    key: p.proposalId, row: p.serverProposalId, title: p.title, lifecycle: p.lifecycleStatus, applied: p.applied
  })));
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: '42', title: 'Unrelated numeric local key', lifecycle: 'Active', applied: true }),
    expect.objectContaining({ key: 'p-local-fork', lifecycle: 'Active', applied: true }),
    expect.objectContaining({ key: 'p-linked-publication', row: '42', lifecycle: 'Cancelled', applied: false })
  ]));

  lifecycleStatus = 'Active';
  await page.evaluate(() => {
    const w = window as any;
    const p = w.proposalStorage.getProposalByServerRowId('42', w.resolveBackendBaseUrl());
    p.lifecycleStatus = 'Active'; p.applied = true;
  });
  for (const reference of ['42', 'p-linked-publication']) {
    const reopened = await page.evaluate(ref => (window as any).handleSharedPlanRoute([ref], 0, { suppressSummary: true }), reference);
    expect(reopened.failed).toEqual([]);
    expect(reopened.skipped.map((item: any) => item.id)).toEqual(['p-linked-publication']);
  }
  const inspector = page.locator('#planning-inspector');
  await expect(inspector.getByRole('heading', { name: 'Linked published park', exact: true })).toBeVisible();
  await expect(inspector).toContainText('Active');
  await expect(inspector.getByRole('button', { name: 'Proposal actions', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe('p-linked-publication');
});
