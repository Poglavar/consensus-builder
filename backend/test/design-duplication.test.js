// Check copied geometry, fresh identity, selection cleanup and pointer-placement cancellation.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.turf = require('@turf/turf');
const { registry } = require('../../frontend/js/proposal-editor-adapters.js');
const api = require('../../frontend/js/design-duplication.js');
const geometry = require('../../frontend/js/single-building-geometry.js');
const goals = require('../../frontend/js/proposals/design-goals.js');
const site = { type: 'Polygon', coordinates: [[[-0.128, 51.507], [-0.1278, 51.507], [-0.1278, 51.5072], [-0.128, 51.5072], [-0.128, 51.507]]] };
const source = { proposalId: 'original', goal: 'park', city: 'london', title: 'Garden', description: 'Authored text',
    site, geometry: site, cadastreParcelIds: ['old-ground'], published: { cid: 'old-cid' },
    agreementIds: ['old-agreement'], lifecycleStatus: 'Executed', applied: true,
    structureProposal: { kind: 'park', geometry: site, decorationDesign: {
        trees: [{ coordinate: [-0.1279, 51.5071], heightM: 5, species: 'oak' }], paths: [[[-0.128, 51.507], [-0.1278, 51.5072]]],
        swings: [{ coordinate: [-0.1279, 51.5071], bearing: 90 }],
        enclosures: [{ fence: 'mesh', use: 'dog', gates: [[-0.1279, 51.507]], ring: [[-0.1279, 51.507], [-0.1278, 51.507], [-0.1278, 51.5071], [-0.1279, 51.507]] }]
    } } };
function environment() {
    return { ProposalDesignGoals: goals, DesignRecord: require('../../frontend/js/design-record.js'),
        __siteDraft: require('../../frontend/js/proposals/site-draft.js'), getProposalEditorAdapter: key => registry.get(key),
        SingleBuildingGeometry: geometry };
}
describe('fresh design duplication', () => {
    it('offers copies only for movable material goals', () => {
        expect(goals.keys.filter(goal => goals.canDuplicate({ goal }))).toEqual(['square', 'park', 'lake', 'single']);
        expect(() => api.templateOf({ ...source, goal: 'parcel-layout' }, environment())).toThrow(/tied to its site/);
    });
    it('copies authored geometry and metadata while clearing identity, bindings and agreement state', () => {
        const before = JSON.stringify(source);
        const template = api.templateOf(source, environment());
        const result = api.movedTemplate(template, { lng: -0.125, lat: 51.51 }, geometry);
        expect(result.fields).toMatchObject({ name: 'Garden', description: 'Authored text', selectedParcelIds: [], cadastreParcelIds: [], binding: null });
        expect(result.editorPayload.placement).toMatchObject({ free: true, bindingStatus: 'pending' });
        for (const key of ['proposalId', 'published', 'agreementIds', 'lifecycleStatus', 'sourceLocalProposalId', 'sourceSnapshot', 'origin']) expect(result).not.toHaveProperty(key);
        expect(result.fields.site).not.toEqual(template.fields.site);
        const tree = result.editorPayload.structureProposal.decorationDesign.trees[0];
        expect(tree).toMatchObject({ heightM: 5, species: 'oak' });
        expect(tree.coordinate).not.toEqual(source.structureProposal.decorationDesign.trees[0].coordinate);
        // Play equipment and fenced areas travel with the copy, by the same shift as the tree.
        const moved = result.editorPayload.structureProposal.decorationDesign, original = source.structureProposal.decorationDesign;
        const shift = (a, b) => [b[0] - a[0], b[1] - a[1]].map(value => Math.round(value * 1e7));
        const treeShift = shift(original.trees[0].coordinate, tree.coordinate);
        expect(moved.swings[0]).toMatchObject({ bearing: 90 });
        expect(shift(original.swings[0].coordinate, moved.swings[0].coordinate)).toEqual(treeShift);
        expect(moved.enclosures[0]).toMatchObject({ fence: 'mesh', use: 'dog' });
        expect(shift(original.enclosures[0].gates[0], moved.enclosures[0].gates[0])).toEqual(treeShift);
        expect(shift(original.enclosures[0].ring[2], moved.enclosures[0].ring[2])).toEqual(treeShift);
        const a = globalThis.turf.area(template.fields.site), b = globalThis.turf.area(result.fields.site);
        expect(Math.abs(b - a) / a).toBeLessThan(0.001);
        expect(JSON.stringify(source)).toBe(before);
    });
    it('keeps imported mesh references, height, rotation and colors on a copied Freeform building', () => {
        const feature = { type: 'Feature', geometry: site, properties: { height: 16, rotation: 35, color: '#abcdef', modelUrl: '/uploads/model.glb', modelTransform: { position: [5, 10, 0], dimensions: [16, 20] } } };
        const building = { ...source, goal: 'single', structureProposal: undefined,
            geometry: { buildings: [feature] }, buildingProposal: { typologyType: 'single', buildings: [feature], buildingFeature: feature } };
        const result = api.movedTemplate(api.templateOf(building, environment()), { lat: 51.51, lng: -0.125 }, geometry);
        expect(result.editorPayload.context.buildings[0].properties).toMatchObject(feature.properties);
        expect(result.editorPayload.context.parcelIds).toEqual([]);
        expect(result.editorPayload.context.buildings[0].geometry).not.toEqual(site);
    });
});

function runtime() {
    const listeners = new Map();
    const document = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
    const session = { pane: 'editor', close: vi.fn(), setPreview: vi.fn() };
    const env = { ...environment(), document, addEventListener() {}, removeEventListener() {},
        map: { getCenter: () => ({ lat: 51.5071, lng: -0.1279 }), getContainer: () => ({ contains: () => true }), mouseEventToLatLng: event => event.latlng },
        proposalStorage: { getProposal: () => source }, CityConfigManager: { getCurrentCityId: () => 'london' },
        OnMapEditor: { isActive: () => false, open: () => session },
        L: { geoJSON: () => ({ addTo() { return this; }, remove: vi.fn() }) },
        requestAnimationFrame: vi.fn(), cancelAnimationFrame: vi.fn(),
        proposalDraftStore: { createDraft: vi.fn(() => ({ id: 'copy-draft' })) },
        instantCreateProposalFromDraft: vi.fn(() => Promise.resolve('copy')), reportProposalDesignSaveFailure: vi.fn() };
    api.start('original', env);
    const event = extra => ({ button: 0, target: { closest: () => null }, clientX: 100, clientY: 100,
        latlng: { lat: 51.51, lng: -0.125 }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra });
    return { env, listeners, session, event };
}
describe('pointer placement', () => {
    it('Escape cancels without creating a draft or changing the source', () => {
        const r = runtime();
        r.listeners.get('keydown')(r.event({ key: 'Escape' }));
        expect(r.env.proposalDraftStore.createDraft).not.toHaveBeenCalled();
        expect(r.session.close).toHaveBeenCalledOnce();
        expect(r.listeners.size).toBe(0);
    });
    it('one physical click places one fresh copy and removes its event handlers', () => {
        const r = runtime();
        r.listeners.get('pointerdown')(r.event());
        r.listeners.get('click')(r.event());
        expect(r.env.proposalDraftStore.createDraft).toHaveBeenCalledOnce();
        expect(r.env.instantCreateProposalFromDraft).toHaveBeenCalledExactlyOnceWith('copy-draft');
        expect(r.env.proposalDraftStore.createDraft.mock.calls[0][0]).not.toHaveProperty('sourceLocalProposalId');
        expect(r.listeners.size).toBe(0);
    });
    it('a map drag does not place a copy', () => {
        const r = runtime();
        r.listeners.get('pointerdown')(r.event());
        r.listeners.get('click')(r.event({ clientX: 120 }));
        expect(r.env.proposalDraftStore.createDraft).not.toHaveBeenCalled();
        r.listeners.get('keydown')(r.event({ key: 'Escape' }));
    });
});
