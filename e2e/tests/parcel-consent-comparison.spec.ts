// The parcel comparison's Status row: what each design's record says about its execution. A design
// carries no consent, terms or funding of its own (plan-design-agreement.md, M2), so the comparison
// no longer has those rows.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';
import { isApiDataRequest } from '../helpers/mocks/api-routes';
import { sampleParcels } from '../helpers/mocks/parcel-data';

test('comparison states each design\'s recorded execution and withdrawal', async ({ mockApi: page }) => {
  // A record names this parcel only under a provider-qualified source reference. Supply that
  // provenance through the fixture response so the real parcel ingestion and comparison use it.
  await page.route('**/parcels**', route => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'parcels')) return route.fallback();
    if (request.method() !== 'GET' && !(request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/parcels/under'))) return route.fallback();
    return route.fulfill({ json: { ...sampleParcels, features: sampleParcels.features.map(feature => ({
      ...feature, properties: { ...feature.properties, parcelSource: { sourceId: 'fixture-comparison', snapshotId: null } }
    })) } });
  });
  await openCity(page);
  await page.evaluate(async parcelId => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const parcelSet = { parcelSource: w.CadastralParcelRepository.get(parcelId).properties.parcelSource };
    if (!parcelSet.parcelSource?.sourceId) throw new Error('Comparison fixture needs the parcel provider identity');
    const executed = w.proposalStorage.addProposal({ proposalId: 'p-comparison-executed', title: 'Executed comparison design', goal: 'as-is',
      parcelSet, cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    const withdrawn = w.proposalStorage.addProposal({ proposalId: 'p-comparison-withdrawn', title: 'Withdrawn comparison design', goal: 'as-is',
      parcelSet, cadastreParcelIds: [parcelId], lifecycleStatus: 'Active' });
    const all = w.proposalStorage.peekAllProposals();
    Object.assign(all.find((p: any) => p.proposalId === executed), w.ProposalLifecycleEvidence.projectLifecycleEvidence({
      lifecycleStatus: 'Executed',
      chainRead: { status: 'Executed', observedAt: '2026-10-19T12:00:00.000Z',
        chainRef: { chainType: 'solana', chainId: 'solana-devnet', contract: 'fixture-program', tokenId: '7' } },
    }));
    const cancelled = all.find((p: any) => p.proposalId === withdrawn);
    cancelled.lifecycleStatus = 'Cancelled';
    cancelled.applied = true;
    w.ParcelCompare.open(parcelId, [executed, withdrawn]);
  }, PARCEL_ID);
  const dialog = page.locator('#parcel-compare-dialog');
  const cell = (name: string) => dialog.locator(`[data-compare-cell="${name}"] .parcel-compare__value`);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.parcel-compare__picker--a select')).toHaveValue('p-comparison-executed');
  await expect(dialog.locator('.parcel-compare__picker--b select')).toHaveValue('p-comparison-withdrawn');
  await expect(cell('status-a')).toContainText('Execution recorded');
  await expect(cell('status-a')).toContainText('does not verify payment, legal registration or physical construction');
  await expect(cell('status-b')).toContainText('Withdrawn');
  await expect(cell('status-b')).not.toContainText('Applied');
});
