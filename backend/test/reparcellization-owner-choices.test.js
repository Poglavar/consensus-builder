// Plot owner choices in the land-readjustment editor (reparcellization-ui-state.js): every owner once,
// by owner key, with public land appended only when the plan does not already list it.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assignableOwnerChoices } = require('../../frontend/js/reparcellization-ui-state.js');

describe('assignableOwnerChoices', () => {
    const publicLand = { ownerKey: 'public-land', displayName: 'Public land' };

    it('appends public land after the recorded owners', () => {
        const owners = [{ ownerKey: 'owner-a', displayName: 'Owner A' }, { ownerKey: 'owner-b', displayName: 'Owner B' }];
        expect(assignableOwnerChoices(owners, publicLand).map(o => o.ownerKey)).toEqual(['owner-a', 'owner-b', 'public-land']);
    });

    it('lists public land once when the plan already gives it a share', () => {
        const owners = [{ ownerKey: 'owner-a', displayName: 'Owner A' }, { ...publicLand, share: 0.2 }];
        const choices = assignableOwnerChoices(owners, publicLand);
        expect(choices.map(o => o.ownerKey)).toEqual(['owner-a', 'public-land']);
        expect(choices[1].share).toBe(0.2); // the plan's own entry, not the blank default
    });

    it('keeps distinct owners that share a display name', () => {
        const owners = [{ ownerKey: 'oib-1', displayName: 'Republika Hrvatska' }, { ownerKey: 'oib-2', displayName: 'Republika Hrvatska' }];
        expect(assignableOwnerChoices(owners, publicLand)).toHaveLength(3);
    });
});
