// What the click stack collects under one map point (frontend/js/click-stack/click-stack-hits.js):
// the real script run in a vm context over fake layers, asserting the hits object it hands the model.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const formation = require('../../frontend/js/proposals/formation-depth.js');
const neighbours = require('../../frontend/js/click-stack/click-stack-neighbours.js');

const source = readFileSync(new URL('../../frontend/js/click-stack/click-stack-hits.js', import.meta.url), 'utf8');

const POINT = { lat: 45.8, lng: 15.97 };
const parcelFeature = (props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [] } });

// stack: what __drillUi.stackAt finds (topmost first). Everything else is optional per test.
function loadHits({ stack = [], buildings = [], planning = null, bareGround = false,
    registry = {}, proposals = {}, parcelProposals = [], parcelBuildings = [] } = {}) {
    const context = {
        __formationDepth: formation,
        ClickStackNeighbours: neighbours,
        console,
        __drillUi: { stackAt: vi.fn(() => stack) },
        buildingsAt: vi.fn(() => buildings),
        buildingsOn: vi.fn(() => parcelBuildings),
        ParcelSetProposals: { lookup: vi.fn(() => ({ entries: parcelProposals })) },
        getProposalKey: proposal => proposal.proposalId,
        PlanningViews: planning ? { isReady: () => true, itemsAt: vi.fn(() => planning) } : undefined,
        AgreementStore: { list: vi.fn(() => []) },
        GroundMenu: { isBareGround: vi.fn(() => bareGround) },
        CadastralParcelRepository: { get: id => registry[id] || null },
        proposalStorage: { getProposal: id => proposals[id] || null },
        CbFormat: { formatArea: value => `${Math.round(value)} m²` },
        turf: { area: () => 120 }
    };
    context.window = context;
    vm.runInNewContext(source, context);
    return { hits: context.ClickStackHits.hitsAt(POINT), context };
}

const proposalEntry = (key, extra = {}) => ({ kind: 'proposal', key, depth: 2, proposal: { proposalId: key, title: `Design ${key}`, createdAt: '2026-10-01', ...extra } });
const formedEntry = (id, producerId, props = {}) => ({ kind: 'parcel', id, depth: 1, producerId, feature: parcelFeature(props) });
const bareEntry = (id, props = {}) => ({ kind: 'parcel', id, depth: 0, feature: parcelFeature(props) });

describe('click stack hits', () => {
    it('gives a design its formed body pieces and its cadastral parcels, live or not', () => {
        const source = parcelFeature({ parcelId: 'source' });
        const kept = parcelFeature({ parcelId: 'kept' });
        const outputs = [parcelFeature({ parcelId: 'piece-a', structureType: 'park' }), parcelFeature({ parcelId: 'piece-b', structureType: 'park' }), parcelFeature({ parcelId: 'leftover' })];
        const proposal = { proposalId: 'park', title: 'Park', goal: 'park', cadastreParcelIds: ['source', 'kept'] };
        const { context } = loadHits({ registry: { source }, proposals: { park: proposal } });
        context.LiveParcelFabric = { producedBy: vi.fn(() => outputs), featureId: feature => feature.properties.parcelId, get: id => (id === 'kept' ? kept : null) };
        const { hits } = context.ClickStackHits.withNeighbours({ designs: [{ id: 'park', proposal }] }, 'designs', { id: 'park', proposal });
        // Only the design's body pieces are formed land; the leftover is not.
        expect(hits.formed.map(item => item.id)).toEqual(['piece-a', 'piece-b']);
        expect(hits.formed.every(item => item.designId === 'park' && item.designLabel === 'Park')).toBe(true);
        expect(hits.parcels).toEqual([{ id: 'source', label: 'source', feature: source, live: false }, { id: 'kept', label: 'kept', feature: kept, live: true }]);
        expect(context.LiveParcelFabric.producedBy).toHaveBeenCalledWith('park');
    });

    it('gives an unapplied design no formed parcel and a missing record nothing', () => {
        const { context } = loadHits();
        context.LiveParcelFabric = { producedBy: () => [], get: () => null, featureId: feature => feature.id };
        const draft = { proposalId: 'draft', goal: 'park', cadastreParcelIds: ['source'] };
        const { hits } = context.ClickStackHits.withNeighbours({}, 'designs', { id: 'draft', proposal: draft });
        expect(hits.formed).toEqual([]);
        expect(hits.parcels.map(item => [item.id, item.live])).toEqual([['source', false]]);
        const empty = { designs: [] };
        expect(context.ClickStackHits.withNeighbours(empty, 'designs', { id: 'missing' }).hits).toBe(empty);
    });

    it('gives a cadastral parcel its pieces, the designs and buildings on it and its permitted massing', () => {
        const parcel = parcelFeature({ parcelId: 'HR-1-12' });
        const piece = parcelFeature({ parcelId: 'HR-1-12#a', producedByProposalId: 'road', cadastreParcelIds: ['HR-1-12'] });
        const house = { id: 'b1', feature: { type: 'Feature', properties: { name: 'House' }, geometry: null }, tunnelled: false };
        const { context } = loadHits({
            proposals: { road: { proposalId: 'road', title: 'Road' } },
            parcelBuildings: [house],
            parcelProposals: [
                { proposal: { proposalId: 'local-1', title: 'Row houses', createdAt: '2026-10-01' } },
                { proposal: { proposalId: 'local-copy', cid: 'bafy-published', title: 'Park' }, serverId: 'bafy-published' }
            ]
        });
        context.LiveParcelFabric = { get: id => (id === 'HR-1-12' ? parcel : null), featureId: feature => feature.properties.parcelId,
            entriesForCadastre: vi.fn(() => [parcel, piece]) };
        context.PlanningViews = { isReady: () => true, getItems: () => [
            { id: 'm1', role: 'permitted', source: { parcel: 'HR-1-12' } },
            { id: 'm2', role: 'permitted', title: 'By evidence', sourceEvidence: { parcelReference: { parcelId: 'HR-1-12' } } },
            { id: 'm3', role: 'permitted', source: { parcel: 'HR-1-99' } },
            { id: 'm4', role: 'existing', source: { parcel: 'HR-1-12' } }
        ] };
        const onPublished = vi.fn();
        const { hits } = context.ClickStackHits.withNeighbours({ parcels: [{ id: 'HR-1-12', feature: parcel, live: true }] }, 'parcels',
            { id: 'HR-1-12', feature: parcel, live: true }, { onPublished });
        expect(context.LiveParcelFabric.entriesForCadastre).toHaveBeenCalledWith(['HR-1-12']);
        // The parcel itself is not one of its own pieces.
        expect(hits.formed.map(item => [item.id, item.designId, item.designLabel])).toEqual([['HR-1-12#a', 'road', 'Road']]);
        expect(context.ParcelSetProposals.lookup).toHaveBeenCalledWith(['HR-1-12'], { onPublished });
        // A published design is keyed by its server id first.
        expect(hits.designs.map(item => [item.id, item.label, item.serverId, item.onParcel])).toEqual([
            ['local-1', 'Row houses', null, true], ['bafy-published', 'Park', 'bafy-published', true]]);
        expect(context.buildingsOn).toHaveBeenCalledWith(parcel);
        expect(hits.built.map(item => [item.id, item.label, item.onParcel])).toEqual([['b1', 'House', true]]);
        expect(hits.permitted.map(item => [item.id, item.label])).toEqual([['m1', 'HR-1-12'], ['m2', 'By evidence']]);
    });

    it('lets a view replace a lookup with its own', () => {
        const parcel = parcelFeature({ parcelId: 'HR-1-12' });
        const { context } = loadHits({ parcelBuildings: [{ id: 'map-building', feature: parcelFeature() }] });
        context.LiveParcelFabric = { get: () => parcel, featureId: feature => feature.properties.parcelId, entriesForCadastre: () => [] };
        const sceneBuilding = { id: 'scene-building', feature: { type: 'Feature', properties: { name: 'Scene house' }, geometry: null } };
        const overrides = { builtOnParcel: vi.fn(() => [sceneBuilding]), parcelLabel: () => '12' };
        const lookups = context.ClickStackHits.neighbourLookups({ overrides });
        expect(lookups.builtOnParcel).toBe(overrides.builtOnParcel);
        const { hits } = context.ClickStackHits.withNeighbours({}, 'permitted', { id: 'm1', item: { source: { parcel: 'HR-1-12' } } }, { overrides });
        expect(hits.parcels).toEqual([{ id: 'HR-1-12', label: '12', feature: parcel, live: true }]);
        const { hits: onParcel } = context.ClickStackHits.withNeighbours({}, 'parcels', { id: 'HR-1-12', feature: parcel }, { overrides });
        expect(overrides.builtOnParcel).toHaveBeenCalledWith(parcel);
        expect(context.buildingsOn).not.toHaveBeenCalled();
        expect(onParcel.built.map(item => [item.id, item.label])).toEqual([['scene-building', 'Scene house']]);
    });

    it('focuses the selected design geometry and the exact selected parcel', () => {
        const source = parcelFeature({ parcelId: 'source' });
        const shapeA = parcelFeature({ design: 'a' }), shapeB = parcelFeature({ design: 'b' });
        const { context } = loadHits({ registry: { source }, proposals: { a: { proposalId: 'a' }, b: { proposalId: 'b' } } });
        context.collectProposalFeatureSets = proposal => ({ primaryFeatures: [proposal.proposalId === 'a' ? shapeA : shapeB] });
        const focus = context.ClickStackHits.featuresFor;
        expect(focus('designs', { id: 'a' })).toEqual([shapeA]);
        expect(focus('parcels', { id: 'source' })).toEqual([source]);
        // A replaced source keeps its immutable original outline, even if the hit held a fragment.
        expect(focus('parcels', { id: 'source', live: false, feature: shapeB })).toEqual([source]);
        expect(focus('formed', { id: 'piece', feature: shapeB })).toEqual([shapeB]);
        expect(focus('built', { id: 'house', feature: shapeA })).toEqual([shapeA]);
        context.PlanningViews = { permittedFeatures: () => ({ body: [shapeA], bound: [shapeB] }) };
        expect(focus('permitted', { item: { id: 'permit', site: source } })).toEqual([shapeA, shapeB]);
        expect(focus('designs', { id: 'missing' })).toEqual([]);
    });

    it('uses only inspected plan features without falling back to mutable local designs', () => {
        const mutable = parcelFeature({ design: 'mutable-local-copy' });
        const inspected = parcelFeature({ design: 'inspected-canonical-revision' });
        const { context } = loadHits({ proposals: { 'local-design': { proposalId: 'local-design' } } });
        context.collectProposalFeatureSets = vi.fn(() => ({ primaryFeatures: [mutable] }));
        const focus = context.ClickStackHits.featuresFor;
        const plan = { id: 'plan-cid', cid: 'plan-cid', features: [inspected] };
        expect(focus('plans', plan)).toEqual([inspected]);
        expect(focus('plans', { id: 'plan-cid', cid: 'plan-cid', plan: { designCids: ['published-design'] } })).toEqual([]);
        expect(focus('plans', { id: 'plan-cid', cid: 'plan-cid', designCids: ['local-design'] })).toEqual([]);
        expect(context.collectProposalFeatureSets).not.toHaveBeenCalled();
    });

    it('does not project agreements into hits or read the agreement store', () => {
        const { hits, context } = loadHits({ stack: [proposalEntry('d1')] });
        expect(hits).not.toHaveProperty('agreements');
        expect(context.AgreementStore.list).not.toHaveBeenCalled();
    });

    it('adds the buildings and proposals of the parcel under the point when no design is there', () => {
        const house = { id: 'b1', feature: { type: 'Feature', properties: { name: 'House' }, geometry: null } };
        const shed = { id: 'b2', feature: { type: 'Feature', properties: { name: 'Shed' }, geometry: null } };
        const { hits, context } = loadHits({
            stack: [bareEntry('HR-1-12')],
            buildings: [house],
            parcelBuildings: [house, shed],
            parcelProposals: [
                { proposal: { proposalId: 'local-1', title: 'Row houses', createdAt: '2026-10-01' } },
                { proposal: { proposalId: null, cid: 'bafy-published', title: 'Park', createdAt: '2026-09-01' }, serverId: 'bafy-published' }
            ]
        });
        expect(context.ParcelSetProposals.lookup).toHaveBeenCalledWith(['HR-1-12'], { onPublished: undefined });
        expect(context.buildingsOn).toHaveBeenCalledWith(hits.parcels[0].feature);
        expect(hits.designs.map(d => [d.id, d.label, d.serverId, d.onParcel])).toEqual([
            ['local-1', 'Row houses', null, true], ['bafy-published', 'Park', 'bafy-published', true]]);
        // The building under the point is listed once, as a point hit; the parcel adds the other.
        expect(hits.built.map(b => [b.id, b.label, !!b.onParcel])).toEqual([['b1', 'House', false], ['b2', 'Shed', true]]);
        expect(hits).not.toHaveProperty('agreements');
    });

    it('lists only the point\'s own hits when a design is under it', () => {
        const { hits, context } = loadHits({ stack: [proposalEntry('d1'), bareEntry('HR-1-12')],
            parcelProposals: [{ proposal: { proposalId: 'other', title: 'Other' } }], parcelBuildings: [{ id: 'b9', feature: { properties: {} } }] });
        expect(context.ParcelSetProposals.lookup).not.toHaveBeenCalled();
        expect(hits.designs.map(d => d.id)).toEqual(['d1']);
        expect(hits.built).toEqual([]);
    });

    it('splits the drill stack into designs, formed parcels and cadastral parcels by kind and depth', () => {
        const { hits, context } = loadHits({
            stack: [proposalEntry('d1'), formedEntry('f1', 'd1'), bareEntry('HR-335550-12')],
            proposals: { d1: { proposalId: 'd1', title: 'Park' } }
        });
        expect(context.__drillUi.stackAt).toHaveBeenCalledWith(POINT);
        expect(hits.designs.map(d => [d.id, d.label, d.goal])).toEqual([['d1', 'Design d1', '']]);
        expect(hits.formed.map(f => [f.id, f.designId, f.designLabel])).toEqual([['f1', 'd1', 'Park']]);
        // A cadastral id loses its HR-<KO>- prefix in the label.
        expect(hits.parcels.map(p => [p.id, p.label, p.live])).toEqual([['HR-335550-12', '12', true]]);
        expect(hits.ground).toEqual([]);
    });

    it('lists every cadastral parcel a formation stands on, the clicked one first, consumed ones from the registry', () => {
        const consumed = parcelFeature({ rootParcelNumber: '7160' });
        const { hits } = loadHits({
            stack: [formedEntry('f1', 'd1', { cadastreParcelIds: ['HR-1-7160', 'HR-1-12', 'HR-1-12'] }), bareEntry('HR-1-12')],
            registry: { 'HR-1-7160': consumed }
        });
        expect(hits.parcels.map(p => p.id)).toEqual(['HR-1-12', 'HR-1-7160']);
        expect(hits.parcels[0].live).toBe(true);
        expect(hits.parcels[1]).toMatchObject({ id: 'HR-1-7160', label: '7160', live: false, feature: consumed });
    });

    it('treats a live piece cut from a cadastral parcel as formed ground, with the original below it', () => {
        // What a road leaves of parcel 1234 on one side: live, no producer, its own id is a fragment.
        const leftover = { kind: 'parcel', id: 'HR-1-1234#pg62kpz', depth: 0, producerId: null, feature: parcelFeature({ cadastreParcelIds: ['HR-1-1234'] }) };
        const { hits } = loadHits({ stack: [leftover] });
        expect(hits.formed.map(f => f.id)).toEqual(['HR-1-1234#pg62kpz']);
        expect(hits.parcels.map(p => [p.id, p.live])).toEqual([['HR-1-1234', false]]);
        // An uncut parcel naming only itself stays cadastral.
        const whole = { kind: 'parcel', id: 'HR-1-12', depth: 0, producerId: null, feature: parcelFeature({ cadastreParcelIds: ['HR-1-12'] }) };
        const { hits: plain } = loadHits({ stack: [whole] });
        expect(plain.formed).toEqual([]);
        expect(plain.parcels.map(p => p.id)).toEqual(['HR-1-12']);
    });

    it('takes a design\'s own cadastreParcelIds when no formed parcel is under the point', () => {
        const { hits } = loadHits({ stack: [proposalEntry('d1', { cadastreParcelIds: ['HR-1-5', 'HR-1-6'] })] });
        expect(hits.parcels.map(p => [p.id, p.live])).toEqual([['HR-1-5', false], ['HR-1-6', false]]);
    });

    it('keeps a single bare parcel alone when the owner names only that one', () => {
        const { hits } = loadHits({ stack: [formedEntry('f1', 'd1', { cadastreParcelIds: ['HR-1-12'] }), bareEntry('HR-1-12')] });
        expect(hits.parcels.map(p => p.id)).toEqual(['HR-1-12']);
    });

    it('does not read the agreement store when there is no design at the point either', () => {
        const { hits, context } = loadHits({ stack: [bareEntry('HR-1-1')] });
        expect(hits).not.toHaveProperty('agreements');
        expect(context.AgreementStore.list).not.toHaveBeenCalled();
    });

    it('takes only permitted massing from the planning items, and the built buildings with their outcome', () => {
        const building = { id: 'b1', feature: parcelFeature({ name: 'Town hall' }), demolition: { proposalId: 'd1' }, tunnelled: false };
        const { hits } = loadHits({
            buildings: [building],
            planning: [{ id: 'm1', role: 'permitted', source: { parcel: '7160' } }, { id: 'm2', role: 'existing', title: 'Existing' }, { id: 'm3', role: 'proposed' }]
        });
        expect(hits.permitted.map(p => [p.id, p.label])).toEqual([['m1', '7160']]);
        expect(hits.built).toEqual([{ id: 'b1', feature: building.feature, demolition: building.demolition, tunnelled: false, label: 'Town hall' }]);
        expect(hits.ground).toEqual([]);
    });

    it('offers bare ground only when nothing else is there and the ground menu says it is bare', () => {
        expect(loadHits({ bareGround: true }).hits.ground).toEqual([{ id: 'here', label: '' }]);
        // Cadastre not loaded yet (or a parcel's place): no ground section.
        expect(loadHits({ bareGround: false }).hits.ground).toEqual([]);
        // Something at the point: no ground section, whatever the ground is.
        const withBuilding = loadHits({ bareGround: true, buildings: [{ id: 'b1', feature: parcelFeature() }] });
        expect(withBuilding.hits.ground).toEqual([]);
        expect(withBuilding.context.GroundMenu.isBareGround).not.toHaveBeenCalled();
    });

    it('survives a failing building or massing hit test, reporting it, with the rest intact', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { context } = loadHits();
            context.buildingsAt = () => { throw new Error('layer gone'); };
            context.PlanningViews = { isReady: () => true, itemsAt: () => { throw new Error('turf down'); } };
            context.__drillUi.stackAt = () => [bareEntry('HR-1-1')];
            const hits = context.ClickStackHits.hitsAt(POINT);
            expect(hits.built).toEqual([]);
            expect(hits.permitted).toEqual([]);
            expect(hits.parcels.map(p => p.id)).toEqual(['HR-1-1']);
            expect(error).toHaveBeenCalledTimes(2);
        } finally {
            error.mockRestore();
        }
    });
});
