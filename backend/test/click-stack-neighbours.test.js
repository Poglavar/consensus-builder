// The click stack's neighbour rule (frontend/js/click-stack/click-stack-neighbours.js): what each kind
// of selected object adds above and below it from its own references, and how those merge into hits.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neighboursOf, withNeighbours, withoutInstances } = require('../../frontend/js/click-stack/click-stack-neighbours.js');

const feature = (props = {}) => ({ type: 'Feature', properties: props, geometry: null });
const PARCEL = feature({ parcelId: 'HR-1-12' });
const PIECE = feature({ parcelId: 'HR-1-12#a', producedByProposalId: 'road', cadastreParcelIds: ['HR-1-12', 'HR-1-13'] });
const ROAD = { proposalId: 'road', title: 'Road', goal: 'road-track', createdAt: '2026-10-01', cadastreParcelIds: ['HR-1-12', 'HR-1-13', 'HR-1-12'] };
const PARK = { proposalId: 'park', title: 'Park', goal: 'park' };
const HOUSE = feature({ name: 'House' });

// A small world: parcel 12 is live and cut by the road; parcel 13 was consumed by it.
function lookups(extra = {}) {
    return {
        proposalOf: id => ({ road: ROAD, park: PARK })[id] || null,
        parcelFeature: id => ({ 'HR-1-12': PARCEL, 'HR-1-13': feature({ parcelId: 'HR-1-13' }) })[id] || null,
        isLive: id => id === 'HR-1-12',
        formedByDesign: proposal => (proposal.proposalId === 'road' ? [{ id: 'HR-1-12#a', feature: PIECE }] : []),
        piecesOfParcel: () => [{ id: 'HR-1-12', feature: PARCEL, producerId: null }, { id: 'HR-1-12#a', feature: PIECE, producerId: 'road' }],
        designsOnParcel: () => [{ id: 'road', proposal: ROAD, serverId: null }, { id: 'bafy-park', proposal: PARK, serverId: 'bafy-park' }, { id: 'broken' }],
        builtOnParcel: () => [{ id: 'b1', feature: HOUSE, demolition: { proposalId: 'road' } }, { id: null, feature: HOUSE }],
        permittedOnParcel: () => [{ id: 7, label: '12', item: { role: 'permitted' } }],
        permittedParcel: instance => instance.item?.source?.parcel || null,
        parcelLabel: id => String(id).replace(/^HR-\d+-/, ''),
        designLabel: proposal => proposal.title,
        buildingLabel: value => value.properties.name,
        ...extra
    };
}

const ids = list => (list || []).map(item => item.id);

describe('click stack neighbours of each kind', () => {
    it('gives a design its formed pieces and its cadastral parcels, each once', () => {
        const found = neighboursOf('designs', { id: 'road', proposal: ROAD }, lookups());
        expect(Object.keys(found).sort()).toEqual(['formed', 'parcels']);
        expect(found.formed).toEqual([{ id: 'HR-1-12#a', label: '12#a', feature: PIECE, designId: 'road', designLabel: 'Road' }]);
        expect(found.parcels.map(item => [item.id, item.label, item.live])).toEqual([['HR-1-12', '12', true], ['HR-1-13', '13', false]]);
        // Without the record on the instance, the stored proposal is read.
        expect(ids(neighboursOf('designs', { id: 'road' }, lookups()).parcels)).toEqual(['HR-1-12', 'HR-1-13']);
        expect(neighboursOf('designs', { id: 'gone' }, lookups())).toEqual({});
    });

    it('gives a formed parcel its producing design and its source parcels', () => {
        const found = neighboursOf('formed', { id: 'HR-1-12#a', feature: PIECE }, lookups());
        expect(found.designs).toEqual([{ id: 'road', label: 'Road', createdAt: '2026-10-01', proposal: ROAD, goal: 'road-track' }]);
        expect(ids(found.parcels)).toEqual(['HR-1-12', 'HR-1-13']);
        // The instance's own designId names the producer when the feature does not.
        expect(ids(neighboursOf('formed', { id: 'x', designId: 'park', feature: feature() }, lookups()).designs)).toEqual(['park']);
        // A piece with no producer (what a road leaves of a parcel) still has its sources.
        const leftover = neighboursOf('formed', { id: 'HR-1-12#b', feature: feature({ cadastreParcelIds: ['HR-1-12'] }) }, lookups());
        expect(leftover.designs).toEqual([]);
        expect(ids(leftover.parcels)).toEqual(['HR-1-12']);
    });

    it('gives a cadastral parcel its pieces, the designs and buildings on it and its permitted massing', () => {
        const found = neighboursOf('parcels', { id: 'HR-1-12', feature: PARCEL }, lookups());
        // The parcel is not one of its own pieces.
        expect(found.formed.map(item => [item.id, item.designId, item.designLabel])).toEqual([['HR-1-12#a', 'road', 'Road']]);
        // An entry without a proposal is skipped.
        expect(found.designs.map(item => [item.id, item.label, item.serverId, item.onParcel])).toEqual([
            ['road', 'Road', null, true], ['bafy-park', 'Park', 'bafy-park', true]]);
        expect(found.built).toEqual([{ id: 'b1', feature: HOUSE, demolition: { proposalId: 'road' }, tunnelled: false, label: 'House', onParcel: true }]);
        expect(found.permitted).toEqual([{ id: '7', label: '12', item: { role: 'permitted' } }]);
        // Its feature comes from the lookup when the instance has none; with no feature, no buildings.
        const builtOnParcel = vi.fn(() => []);
        neighboursOf('parcels', { id: 'HR-1-12' }, lookups({ builtOnParcel }));
        expect(builtOnParcel).toHaveBeenCalledWith(PARCEL);
        expect(neighboursOf('parcels', { id: 'HR-9-9' }, lookups()).built).toEqual([]);
    });

    it('gives a built building the design that affects it, and permitted massing its parcel', () => {
        expect(neighboursOf('built', { id: 'b1', affectedDesign: { id: 7, label: 'Road' } }, lookups())).toEqual({ designs: [{ id: '7', label: 'Road' }] });
        expect(neighboursOf('built', { id: 'b2' }, lookups())).toEqual({});
        const permitted = neighboursOf('permitted', { id: 'm1', item: { source: { parcel: 'HR-1-13' } } }, lookups());
        expect(permitted).toEqual({ parcels: [{ id: 'HR-1-13', label: '13', feature: feature({ parcelId: 'HR-1-13' }), live: false }] });
        expect(neighboursOf('permitted', { id: 'm2', item: {} }, lookups())).toEqual({});
    });

    it('adds nothing of its own for plans and agreements, or for no instance', () => {
        expect(neighboursOf('plans', { id: 'pl1', cid: 'pl1' }, lookups())).toEqual({});
        expect(neighboursOf('agreements', { id: 'a1' }, lookups())).toEqual({});
        expect(neighboursOf('designs', null, lookups())).toEqual({});
    });

    it('takes nothing from a missing lookup', () => {
        expect(neighboursOf('designs', { id: 'road', proposal: ROAD })).toEqual({ formed: [], parcels: [
            { id: 'HR-1-12', label: 'HR-1-12', feature: null, live: false }, { id: 'HR-1-13', label: 'HR-1-13', feature: null, live: false }] });
        expect(neighboursOf('parcels', { id: 'HR-1-12', feature: PARCEL }, {})).toEqual({ formed: [], designs: [], built: [], permitted: [] });
        expect(neighboursOf('permitted', { id: 'm1' }, {})).toEqual({});
    });

    it('reports a failing lookup and takes nothing from it, keeping the rest', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const found = neighboursOf('parcels', { id: 'HR-1-12', feature: PARCEL }, lookups({ designsOnParcel: () => { throw new Error('offline'); } }));
            expect(found.designs).toEqual([]);
            expect(ids(found.formed)).toEqual(['HR-1-12#a']);
            expect(ids(found.built)).toEqual(['b1']);
            expect(error).toHaveBeenCalledTimes(1);
            expect(String(error.mock.calls[0][0])).toContain('designsOnParcel failed');
        } finally {
            error.mockRestore();
        }
    });
});

describe('click stack neighbours merged into hits', () => {
    it('keeps existing instances first, appends new ones once and fills only missing fields', () => {
        const pointParcel = { id: 'HR-1-12', label: 'Twelve', feature: null, live: true, entry: { kind: 'parcel' } };
        const hits = { designs: [{ id: 'road', proposal: ROAD }], parcels: [pointParcel], built: [{ id: 'b0' }] };
        const { hits: merged, added } = withNeighbours(hits, 'designs', { id: 'road', proposal: ROAD }, lookups());
        expect(merged).not.toBe(hits);
        // Only what this call appended is reported, never what was already there.
        expect(added).toEqual({ formed: ['HR-1-12#a'], parcels: ['HR-1-13'] });
        expect(ids(merged.parcels)).toEqual(['HR-1-12', 'HR-1-13']);
        // The point's own fields win; a missing one is filled from the neighbour.
        expect(merged.parcels[0]).toEqual({ id: 'HR-1-12', label: 'Twelve', feature: PARCEL, live: true, entry: { kind: 'parcel' } });
        expect(ids(merged.formed)).toEqual(['HR-1-12#a']);
        // Kinds the neighbours do not touch, and the input, are left as they were.
        expect(merged.built).toBe(hits.built);
        expect(merged.designs).toBe(hits.designs);
        expect(hits.parcels).toEqual([pointParcel]);
        expect(hits).not.toHaveProperty('formed');
    });

    it('returns the same object when nothing is new', () => {
        const { hits } = withNeighbours({}, 'designs', { id: 'road', proposal: ROAD }, lookups());
        expect(withNeighbours(hits, 'designs', { id: 'road', proposal: ROAD }, lookups())).toEqual({ hits, added: {} });
        const plans = { plans: [{ id: 'pl1' }] };
        expect(withNeighbours(plans, 'plans', plans.plans[0], lookups()).hits).toBe(plans);
        expect(withNeighbours(plans, 'designs', { id: 'gone' }, lookups()).hits).toBe(plans);
    });

    it('starts from empty hits', () => {
        const { hits: merged } = withNeighbours(null, 'built', { id: 'b1', affectedDesign: { id: 'road', label: 'Road' } }, lookups());
        expect(merged).toEqual({ designs: [{ id: 'road', label: 'Road' }] });
    });

    it('takes a replaced selection\'s neighbours out again, except what is protected', () => {
        const hits = { designs: [{ id: 'd1' }, { id: 'd2' }], parcels: [{ id: 'p-click' }, { id: 'p-d1' }, { id: 'p-shared' }], formed: [{ id: 'f-d1' }] };
        const trimmed = withoutInstances(hits, { parcels: ['p-d1', 'p-shared', 'p-click'], formed: ['f-d1'] }, { parcels: ['p-click', 'p-shared'] });
        expect(trimmed).not.toBe(hits);
        expect(ids(trimmed.parcels)).toEqual(['p-click', 'p-shared']);
        expect(trimmed.formed).toEqual([]);
        expect(trimmed.designs).toBe(hits.designs);
        expect(ids(hits.parcels)).toEqual(['p-click', 'p-d1', 'p-shared']);
        // Nothing to take out: the same object comes back.
        expect(withoutInstances(hits, { parcels: ['elsewhere'] })).toBe(hits);
        expect(withoutInstances(hits, {})).toBe(hits);
    });
});
