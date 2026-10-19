import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';

test('comparison distinguishes current local consent from verified receipts and missing rosters', async ({ mockApi: page }) => {
  await openCity(page);
  const ids = await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const local = w.proposalStorage.addProposal({ proposalId: 'p-comparison-local', title: 'Local consent preview', goal: 'as-is',
      kind: 'owner-deal', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    const signed = w.proposalStorage.addProposal({ proposalId: 'p-comparison-signed', title: 'Signed consent preview', goal: 'as-is',
      kind: 'owner-deal', cadastreParcelIds: [parcelId], lifecycleStatus: 'Active',
      approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' }, rights: {
        schema: 'parcel-rights/v1', source: { provider: 'fixture' }, parcels: [{ parcelId, areaM2: 100, complete: true, owners: [{ ownerId: 'owner-a', share: '1/1' }] }]
      } } });
    w.getParcelOwnerSlots = () => [{ key: 'a' }, { key: 'b' }];
    for (const id of [local, signed]) {
      const record = w.proposalStorage.peekAllProposals().find((p: any) => p.proposalId === id);
      record.acceptedParcelIds = [parcelId];
      record.ownerAcceptances = { [parcelId]: { ownerOrder: ['a', 'b'], acceptedOwnerKeys: ['a', 'b'],
        acceptedBy: { a: { effectHash: 'old-terms' }, b: { effectHash: 'old-terms' } } } };
    }
    w.ParcelCompare.open(parcelId, [local, signed]);
    return { local, signed };
  }, PARCEL_ID);
  const dialog = page.locator('#parcel-compare-dialog');
  const cell = (name: string) => dialog.locator(`[data-compare-cell="${name}"] .parcel-compare__value`);
  await expect(cell('consent-basis-a')).toContainText('Unsigned browser records matched to current terms');
  await expect(cell('owner-consent-a')).toHaveText('0/2 local owner entries');
  await expect(cell('parcel-consent-a')).toHaveText('No');
  await expect(cell('consent-basis-b')).toContainText('Signed decisions verified for current terms');
  await expect(cell('owner-consent-b')).toHaveText('0/1 declared owner parties');
  await expect(cell('parcel-consent-b')).toHaveText('No');

  await page.evaluate(({ ids, parcelId }) => {
    const w = window as any;
    const record = w.proposalStorage.peekAllProposals().find((p: any) => p.proposalId === ids.local);
    const hash = w.currentConsentBindingHash(record);
    for (const entry of Object.values(record.ownerAcceptances[parcelId].acceptedBy) as any[]) entry.effectHash = hash;
    w.ParcelCompare.open(parcelId, [ids.local, ids.signed]);
  }, { ids, parcelId: PARCEL_ID });
  await expect(cell('owner-consent-a')).toHaveText('2/2 local owner entries');
  await expect(cell('parcel-consent-a')).toHaveText('Yes');
  await page.evaluate(({ ids, parcelId }) => {
    const w = window as any;
    w.getParcelOwnerSlots = () => [];
    w.ParcelCompare.open(parcelId, [ids.local, ids.signed]);
  }, { ids, parcelId: PARCEL_ID });
  await expect(cell('owner-consent-a')).toHaveText('—');
  await expect(cell('parcel-consent-a')).toHaveText('—');
  await expect(cell('proposal-consent-a')).toHaveText('—');
  expect(await page.evaluate(({ id, parcelId }) => (window as any).proposalStorage.peekAllProposals()
    .find((p: any) => p.proposalId === id).ownerAcceptances[parcelId].acceptedOwnerKeys, { id: ids.local, parcelId: PARCEL_ID }))
    .toEqual(['a', 'b']);
});
