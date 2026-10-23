// Click resolution in the 3D model view (frontend/js/three-click-plan.js): every click is also a
// parcel click; what the ray hit keeps its own meaning; isolation is a second click.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planThreeClick } = require('../../frontend/js/three-click-plan.js');

const idle = { viewedParcelId: null, isolatedParcelId: null, isolatedProposalId: null };

describe('planThreeClick', () => {
    it('views the parcel under a massing or building click without stealing the inspector', () => {
        const massing = planThreeClick({ ...idle, picked: { planningId: 'gup:HR-1' }, groundParcelId: 'HR-1' });
        expect(massing).toMatchObject({ selectMassing: 'gup:HR-1', clearSelection: false, parcel: { id: 'HR-1', action: 'view' }, openMassing: false });
        const feature = { type: 'Feature' };
        const built = planThreeClick({ ...idle, picked: { builtFeature: feature, parcelId: 'HR-1' }, groundParcelId: 'HR-2' });
        expect(built).toMatchObject({ inspectBuilding: feature, parcel: { id: 'HR-2', action: 'view' }, openMassing: false, clearSelection: false });
        // Off the loaded ground there is no parcel to view.
        expect(planThreeClick({ ...idle, picked: { builtFeature: feature }, groundParcelId: null }).parcel).toBeNull();
    });

    it('selects and isolates a proposal, viewing the parcel under the click; a second click clears it', () => {
        const first = planThreeClick({ ...idle, picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: true });
        expect(first).toMatchObject({ clearSelection: true, proposal: { id: 'p-1', action: 'isolate' }, parcel: { id: 'HR-3', action: 'view' }, openMassing: false });
        const again = planThreeClick({ ...idle, isolatedProposalId: 'p-1', viewedParcelId: 'HR-3', picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: true });
        expect(again).toMatchObject({ proposal: { id: 'p-1', action: 'clear' }, parcel: null });
        // Through a design the ray can reach the neighbour's slab: the design's own slice is the parcel in view.
        expect(planThreeClick({ ...idle, picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-2', proposalKnown: true }).parcel)
            .toEqual({ id: 'HR-3', action: 'view' });
        // An unknown proposal id is just ground.
        expect(planThreeClick({ ...idle, picked: { proposalId: 'gone', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: false }).parcel).toEqual({ id: 'HR-3', action: 'view' });
    });

    it('steps a ground click through view, isolate and clear on the same parcel', () => {
        const first = planThreeClick({ ...idle, picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(first).toMatchObject({ clearSelection: true, parcel: { id: 'HR-4', action: 'view' }, openMassing: true });
        const second = planThreeClick({ ...idle, viewedParcelId: 'HR-4', picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(second.parcel).toEqual({ id: 'HR-4', action: 'isolate' });
        const third = planThreeClick({ ...idle, viewedParcelId: 'HR-4', isolatedParcelId: 'HR-4', picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(third.parcel).toEqual({ id: 'HR-4', action: 'clear' });
        // Another parcel while one is isolated: view it (the isolation gives way in the executor).
        const other = planThreeClick({ ...idle, viewedParcelId: 'HR-4', isolatedParcelId: 'HR-4', picked: { parcelId: 'HR-5' }, groundParcelId: 'HR-5' });
        expect(other.parcel).toEqual({ id: 'HR-5', action: 'view' });
    });

    it('prefers the ground parcel over the picked one, and clears on empty ground only when something is set', () => {
        expect(planThreeClick({ ...idle, picked: { parcelId: 'HR-6' }, groundParcelId: 'HR-7' }).parcel).toEqual({ id: 'HR-7', action: 'view' });
        expect(planThreeClick({ ...idle, picked: null, groundParcelId: null })).toMatchObject({ clearSelection: true, parcel: null });
        expect(planThreeClick({ ...idle, viewedParcelId: 'HR-6', picked: null, groundParcelId: null }).parcel).toEqual({ id: null, action: 'clear' });
        expect(planThreeClick({ ...idle, isolatedProposalId: 'p-1', picked: null, groundParcelId: null }).parcel).toEqual({ id: null, action: 'clear' });
    });

    it('inside a proposal view, clicking the viewed parcel again does not isolate it away from the proposal', () => {
        const plan = planThreeClick({ ...idle, isolatedProposalId: 'p-1', viewedParcelId: 'HR-3', picked: { parcelId: 'HR-3' }, groundParcelId: 'HR-3' });
        expect(plan.parcel).toEqual({ id: 'HR-3', action: 'view' });
    });
});
