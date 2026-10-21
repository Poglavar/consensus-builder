import { expect } from '@playwright/test';
import { test } from '../helpers/fixtures';
import { waitForMapReady, waitForParcelsLoaded } from '../helpers/app';
import { showProposal } from '../helpers/runtime';

/**
 * Proposals are geometry; their parcels are derived (js/proposals/ground-rebase.js). A building
 * whose stored parcels no longer fit the cadastre in view: a local draft takes the parcels its
 * geometry covers and applies; a published record refuses, and its error offers "New proposal
 * with same geometry", which opens a fork with the re-derived parcels.
 */

const massing = {
  type: 'Feature',
  properties: { height: 15, massing: true },
  geometry: { type: 'Polygon', coordinates: [[[15.98205, 45.80015], [15.98215, 45.80015], [15.98215, 45.80025], [15.98205, 45.80025], [15.98205, 45.80015]]] }
};

// Inside fixture parcel HR-335754-1234, declared on HR-335754-1236 two parcels east.
const record = (proposalId: string, extra: Record<string, unknown> = {}) => ({
  proposalId, title: proposalId, description: 'Ground rebase fixture', offer: 0, offerCurrency: 'EUR',
  city: 'zg', goal: 'buildings', lifecycleStatus: 'Active', applied: false,
  cadastreParcelIds: ['HR-335754-1236'],
  geometry: { buildings: [massing], blockMassing: massing },
  buildingProposal: { typologyType: 'block', parameters: { rule: { kind: 'max', maxHeightM: 15 } } },
  ...extra
});

test.describe('re-applying a proposal to changed ground', () => {
  test.beforeEach(async ({ mockApi: page }) => {
    await page.goto('/?city=zg&at=45.8002,15.9822,19&lang=en&reduceMotion=1');
    await waitForMapReady(page);
    await waitForParcelsLoaded(page);
  });

  test('a local draft takes the parcels its geometry covers and applies', async ({ mockApi: page }) => {
    const result = await page.evaluate(async fixture => {
      const w = window as any;
      w.proposalStorage.addProposal(fixture);
      const applied = await w.applyProposalToMap(fixture.proposalId);
      const stored = w.proposalStorage.getProposal(fixture.proposalId);
      return { applied, ids: stored.cadastreParcelIds, isApplied: stored.applied };
    }, record('e2e-rebase-draft'));
    expect(result).toEqual({ applied: true, ids: ['HR-335754-1234'], isApplied: true });
  });

  test('a published record keeps its parcels and offers a new proposal with the same geometry', async ({ mockApi: page }) => {
    await page.evaluate(fixture => {
      (window as any).proposalStorage.addProposal(fixture);
    }, record('e2e-rebase-published', { serverProposalId: '880001', publicationApiBase: 'https://proposals.example.test' }));
    // A new selection opens the Planning Inspector; use its current Proposal actions flow so the
    // failure notice and published-record fork action render in the full action panel.
    await showProposal(page, 'e2e-rebase-published');
    await page.evaluate(id => (window as any).applyProposalToMap(id), 'e2e-rebase-published');
    const notice = page.locator('[data-proposal-map-action-error="e2e-rebase-published"]');
    await expect(notice).toContainText('extends beyond its selected cadastral parcels');
    expect(await page.evaluate(() => (window as any).proposalStorage.getProposal('e2e-rebase-published').cadastreParcelIds))
      .toEqual(['HR-335754-1236']);

    await notice.getByRole('button', { name: 'New proposal with same geometry' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).pendingProposalReplacementSource?.proposalId || null)).toBe('e2e-rebase-published');
    const draft = await page.evaluate(() => (window as any).proposalDraftStore.listDrafts()
      .filter((d: any) => d.sourceLocalProposalId === 'e2e-rebase-published').map((d: any) => d.fields.cadastreParcelIds));
    expect(draft).toEqual([['HR-335754-1234']]);
  });
});
