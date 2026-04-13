// Regression: when a road corridor does NOT intersect a listed parent parcel, turf.difference
// returns the full parent polygon. Without a guard, calculateChildFeatures used to mint a
// synthetic descendant ID covering the entire parent — i.e. a "ghost split" with parent geometry.
// The fix (proposal-manager.js calculateChildFeatures + _buildChildFeaturesFromDefinition) skips
// pieces whose area is ≥ 99.9% of the parent area.

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';

test.describe('Road uncut-remainder guard @features', () => {
  test('road corridor that misses a listed parent does not produce synthetic descendant', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);

    const result = await page.evaluate(async () => {
      const w = window as any;

      // Two parents: A is intersected by the corridor, B is far away and untouched.
      const intersectedId = 'HR-335754-9001';
      const untouchedId = 'HR-335754-9002';

      const intersectedParent = {
        type: 'Feature' as const,
        properties: {
          parcelId: intersectedId, parcel_id: intersectedId, id: intersectedId,
          BROJ_CESTICE: '9001', maticni_broj_ko: '335754', MATICNI_BROJ_KO: '335754',
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            [15.9819, 45.8000],
            [15.9825, 45.8000],
            [15.9825, 45.8005],
            [15.9819, 45.8005],
            [15.9819, 45.8000],
          ]],
        },
      };

      // Far enough that no corridor we draw through intersectedParent will touch this one.
      const untouchedParent = {
        type: 'Feature' as const,
        properties: {
          parcelId: untouchedId, parcel_id: untouchedId, id: untouchedId,
          BROJ_CESTICE: '9002', maticni_broj_ko: '335754', MATICNI_BROJ_KO: '335754',
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            [15.9900, 45.8050],
            [15.9906, 45.8050],
            [15.9906, 45.8055],
            [15.9900, 45.8055],
            [15.9900, 45.8050],
          ]],
        },
      };

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

      if (typeof w.ingestParcelFeatures !== 'function') {
        return { error: 'ingestParcelFeatures missing' };
      }
      await w.ingestParcelFeatures([intersectedParent, untouchedParent], { replaceExisting: true });

      const proposalSeed = {
        proposalId: 'e2e-road-uncut-remainder',
        title: 'E2E road uncut remainder',
        goal: 'Road/track',
        status: 'Active',
        // Both parents are listed — but the corridor only actually touches the first one.
        parentParcelIds: [intersectedId, untouchedId],
        roadProposal: {
          status: 'unapplied',
          parentParcelIds: [intersectedId, untouchedId],
          definition: {
            polygon: corridor,
            metadata: { mode: 'full' },
          },
        },
        geometry: {
          roadPlan: {
            polygon: corridor,
            metadata: { mode: 'full' },
          },
        },
      };

      const added = w.proposalStorage.addProposal(proposalSeed);
      const pid = added?.proposalId || proposalSeed.proposalId;

      const applied = await w.ProposalManager.applyProposal(pid);

      const after = w.proposalStorage.getProposal(pid);
      const childIds: string[] = Array.isArray(after?.childParcelIds) ? after.childParcelIds.map(String) : [];

      // Heuristic: synthetic descendant ids derived from a parent contain that parent's id.
      const ghostFromUntouched = childIds.filter(id => id.includes(untouchedId));

      return {
        pid,
        applied,
        childIds,
        childCount: childIds.length,
        ghostFromUntouchedCount: ghostFromUntouched.length,
      };
    });

    expect(result.error, `setup: ${result.error}`).toBeUndefined();
    expect(result.applied).toBe(true);
    // The intersected parent should produce at least one descendant.
    expect(result.childCount).toBeGreaterThan(0);
    // The untouched parent must NOT produce any synthetic descendant.
    expect(result.ghostFromUntouchedCount).toBe(0);
  });
});
