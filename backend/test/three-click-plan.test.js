// Click resolution in the 3D model view (frontend/js/three-click-plan.js): every click is also a
// parcel click; what the ray hit keeps its own meaning. Repeat keys do not depend on click timing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planThreeClick, clickKey, subjectHit, photoHit, drapeSegments } = require('../../frontend/js/three-click-plan.js');

const idle = { viewedParcelId: null, isolatedParcelId: null, isolatedProposalId: null };

describe('shared scene hit resolution', () => {
    it('ignores hidden model context and retains authored identity through nested pick meshes', () => {
        const hidden = { visible: false, userData: { parcelId: 'hidden' } };
        const authored = { visible: true, userData: { proposalId: 'design', parcelId: 'parcel' } };
        const point = { x: 1, y: 2, z: 3 };
        expect(subjectHit([
            { object: { parent: hidden }, distance: 1 },
            { object: { parent: authored }, distance: 2, point }
        ])).toEqual({ picked: { proposalId: 'design', parcelId: 'parcel' }, distance: 2, point });
        expect(subjectHit([{ object: { parent: hidden } }])).toBeNull();
    });
    it('chooses visible authored geometry ahead of Google tiles and source buildings ahead of occluded designs', () => {
        const authored = { picked: { proposalId: 'design' }, distance: 20, point: { x: 1 } };
        const surface = { distance: 25, point: { x: 2 } };
        expect(photoHit({ authored, surface })).toBe(authored);
        const feature = { type: 'Feature' };
        const nearer = { ...surface, distance: 10 };
        expect(photoHit({ authored, surface: nearer, built: [{ id: 'building', feature }] }))
            .toEqual({ ...nearer, picked: { builtFeature: feature } });
        expect(photoHit({ authored, surface: nearer, built: [{ feature, onParcel: true }] }).picked).toBeNull();
        expect(photoHit({ authored, surface: null })).toBe(authored);
        expect(photoHit({ authored: null, surface: null })).toBeNull();
    });
    it('picks a design replacing raw Google triangles, without treating a neighbouring design as the clicked surface', () => {
        const authored = { picked: { proposalId: 'park' }, distance: 20, point: { x: 1 } };
        const surface = { distance: 10, point: { x: 2 } };
        expect(photoHit({ authored, surface, designs: [{ id: 'park' }] })).toBe(authored);
        expect(photoHit({ authored, surface, designs: [{ id: 'park', onParcel: true }] }).picked).toBeNull();
        expect(photoHit({ authored, surface, designs: [{ id: 'another' }] }).picked).toBeNull();
    });
    it('drapes long boundaries over terrain, accepts zero height, and leaves gaps where terrain is unknown', () => {
        expect(drapeSegments([0, 0, .6, 16, 0, .6], x => x / 2, 8))
            .toEqual([0, 0, .6, 8, 0, 4.6, 8, 0, 4.6, 16, 0, 8.6]);
        expect(drapeSegments([0, 0, .6, 24, 0, .6], x => x === 8 ? null : 0, 8))
            .toEqual([16, 0, .6, 24, 0, .6]);
        expect(drapeSegments([0, 0, .6, 8, 0, .6], () => NaN)).toEqual([]);
    });
});

describe('planThreeClick', () => {
    it('identifies repeated picks by the actual subject and parcel, not timing or feature object identity', () => {
        expect(clickKey({ picked: { builtFeature: {} }, builtId: 'b1', groundParcelId: 'p1' }))
            .toBe(clickKey({ picked: { builtFeature: {} }, builtId: 'b1', groundParcelId: 'p1' }));
        expect(clickKey({ picked: { builtFeature: {} }, builtId: 'b2', groundParcelId: 'p1' }))
            .not.toBe(clickKey({ picked: { builtFeature: {} }, builtId: 'b1', groundParcelId: 'p1' }));
        expect(clickKey({ picked: { proposalId: 'd1', parcelId: 'p1' }, groundParcelId: 'neighbour', proposalKnown: true }))
            .toBe(clickKey({ picked: { proposalId: 'd1', parcelId: 'p1' }, groundParcelId: 'p1', proposalKnown: true }));
        expect(clickKey({ groundParcelId: 'p1' })).not.toBe(clickKey({ groundParcelId: 'p2' }));
        expect(clickKey({ picked: { planningId: 'm1' }, groundParcelId: 'p1' })).not.toBe(clickKey({ groundParcelId: 'p1' }));
        expect(clickKey({ picked: { proposalId: 'gone', parcelId: 'p1' }, proposalKnown: false })).toBe(clickKey({ groundParcelId: 'p1' }));
        expect(clickKey({})).toBeNull();
    });
    it('views the parcel under a massing or building click without stealing the inspector', () => {
        const massing = planThreeClick({ ...idle, picked: { planningId: 'gup:HR-1' }, groundParcelId: 'HR-1' });
        expect(massing).toMatchObject({ selectMassing: 'gup:HR-1', clearSelection: false, parcel: { id: 'HR-1', action: 'view' } });
        const feature = { type: 'Feature' };
        const built = planThreeClick({ ...idle, picked: { builtFeature: feature, parcelId: 'HR-1' }, groundParcelId: 'HR-2' });
        expect(built).toMatchObject({ inspectBuilding: feature, parcel: { id: 'HR-2', action: 'view' }, clearSelection: false });
        // Off the loaded ground there is no parcel to view.
        expect(planThreeClick({ ...idle, picked: { builtFeature: feature }, groundParcelId: null }).parcel).toBeNull();
    });

    it('selects a proposal without isolation, viewing the parcel under the click; a second click retains it', () => {
        const first = planThreeClick({ ...idle, picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: true });
        expect(first).toMatchObject({ clearSelection: true, proposal: { id: 'p-1', action: 'select' }, parcel: { id: 'HR-3', action: 'view' } });
        const again = planThreeClick({ ...idle, isolatedProposalId: 'p-1', viewedParcelId: 'HR-3', picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: true });
        expect(again).toMatchObject({ clearSelection: false, proposal: { id: 'p-1', action: 'retain' }, parcel: { id: 'HR-3', action: 'view' } });
        // Through a design the ray can reach the neighbour's slab: the design's own slice is the parcel in view.
        expect(planThreeClick({ ...idle, picked: { proposalId: 'p-1', parcelId: 'HR-3' }, groundParcelId: 'HR-2', proposalKnown: true }).parcel)
            .toEqual({ id: 'HR-3', action: 'view' });
        // An unknown proposal id is just ground.
        expect(planThreeClick({ ...idle, picked: { proposalId: 'gone', parcelId: 'HR-3' }, groundParcelId: 'HR-3', proposalKnown: false }).parcel).toEqual({ id: 'HR-3', action: 'view' });
    });

    it('retains selection on repeated ground clicks on the same parcel', () => {
        const first = planThreeClick({ ...idle, picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(first).toMatchObject({ clearSelection: true, parcel: { id: 'HR-4', action: 'view' } });
        const second = planThreeClick({ ...idle, viewedParcelId: 'HR-4', picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(second).toMatchObject({ clearSelection: false, parcel: { id: 'HR-4', action: 'retain' } });
        const third = planThreeClick({ ...idle, viewedParcelId: 'HR-4', isolatedParcelId: 'HR-4', picked: { parcelId: 'HR-4' }, groundParcelId: 'HR-4' });
        expect(third.parcel).toEqual({ id: 'HR-4', action: 'retain' });
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
