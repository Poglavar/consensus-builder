// Regression: when a road corridor does NOT intersect a listed parent parcel, turf.difference
// returns the full parent polygon. Without a guard, calculateChildFeatures used to mint a
// synthetic descendant ID covering the entire parent — i.e. a "ghost split" with parent geometry.
// The fix (proposal-manager.js calculateChildFeatures + _buildChildFeaturesFromDefinition) skips
// pieces whose area is ≥ 99.9% of the parent area.

import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

test.describe('Road uncut-remainder guard @features', () => {
  test('road corridor that misses a listed parent does not produce synthetic descendant', async ({ mockApi: page }) => {
    await openCity(page);

    const result = await page.evaluate(async () => {
      const w = window as any;

      // Two parents: A is intersected by the corridor, B is far away and untouched.
      const intersectedId = 'HR-335754-1234';
      const untouchedId = 'HR-335754-1238';

      // Corridor sits entirely inside intersectedParent.
      const corridor = {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9820, 45.8001],
          [15.9824, 45.8001],
          [15.9824, 45.8004],
          [15.9820, 45.8004],
          [15.9820, 45.8001],
        ]],
      };

      // The repository's fixture transport is the only way cadastral facts enter the fabric.
      await w.CadastralParcelRepository.ensureIds([intersectedId, untouchedId]);
      const intersected = w.LiveParcelFabric.get(intersectedId);
      const untouched = w.LiveParcelFabric.get(untouchedId);
      if (!intersected || !untouched) throw new Error('Expected repository-backed parcel fixtures to be loaded');

      const proposalSeed = {
        proposalId: 'e2e-road-uncut-remainder',
        title: 'E2E road uncut remainder',
        goal: 'road-track',
        lifecycleStatus: 'Active',
        cadastreParcelIds: [intersectedId, untouchedId],
        roadProposal: { definition: { polygon: corridor, metadata: { mode: 'full' } } },
      };

      const added = w.proposalStorage.addProposal(proposalSeed);
      const pid = added?.proposalId || proposalSeed.proposalId;

      const applied = await w.ProposalManager.applyProposal(pid);

      const produced = w.LiveParcelFabric.producedBy(pid);
      const provenance = produced.flatMap((feature: any) => w.LiveParcelFabric.explicitCadastreIds(feature));

      return {
        pid,
        applied,
        producedCount: produced.length,
        untouchedOutputCount: provenance.filter((id: string) => id === untouchedId).length,
        intersectedOutputCount: provenance.filter((id: string) => id === intersectedId).length,
      };
    });

    expect(result.applied).toBe(true);
    expect(result.producedCount).toBeGreaterThan(0);
    expect(result.intersectedOutputCount).toBeGreaterThan(0);
    expect(result.untouchedOutputCount).toBe(0);
  });
});
