// The applied-corridor render is keyed: a refresh rebuilds only corridors whose inputs changed,
// drops only the cross-corridor junctions those corridors take part in, and leaves everything
// else on the map untouched. corridor-render.js runs in a vm context with a hand-built Leaflet
// and stubbed builders, so no turf and no DOM are involved.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const pure = require('../../frontend/js/corridor-render.js');
const renderSource = readFileSync(new URL('../../frontend/js/corridor-render.js', import.meta.url), 'utf8');

function leafletStub() {
    const makeLayer = (kind, extra = {}) => {
        const layer = { kind, ...extra };
        layer.on = () => layer;
        layer.addTo = target => { target.addLayer(layer); return layer; };
        return layer;
    };
    const makeGroup = () => {
        const children = new Set();
        const group = {
            kind: 'group',
            children,
            addLayer(layer) { children.add(layer); return group; },
            removeLayer(layer) { children.delete(layer); return group; },
            hasLayer: layer => children.has(layer),
            getLayers: () => Array.from(children),
            addTo(target) { target.addLayer(group); return group; }
        };
        return group;
    };
    return {
        layerGroup: makeGroup,
        featureGroup: makeGroup,
        polygon: (latlngs, options) => makeLayer('polygon', { latlngs, options }),
        polyline: (latlngs, options) => makeLayer('polyline', { latlngs, options }),
        circleMarker: (latlng, options) => makeLayer('circle', { latlng, options }),
        marker: (latlng, options) => makeLayer('marker', { latlng, options }),
        divIcon: () => ({}),
        geoJSON: (data, options) => makeLayer('geojson', { data, options }),
        canvas: () => ({ kind: 'canvas' }),
        latLng: (lat, lng) => ({ lat, lng })
    };
}

function mapStub() {
    const panes = new Map();
    const layers = new Set();
    return {
        panes,
        layers,
        getPane: name => panes.get(name) || null,
        createPane(name) { const pane = { style: {} }; panes.set(name, pane); return pane; },
        hasLayer: layer => layers.has(layer),
        addLayer(layer) { layers.add(layer); },
        removeLayer(layer) { layers.delete(layer); }
    };
}

const road = (id, points, options = {}) => ({
    proposalId: id,
    applied: options.applied !== false,
    roadProposal: { definition: { points, profile: options.profile || { strips: [{ type: 'lane', left: 3, right: -3 }] }, ...(options.definition || {}) } }
});

function environment(proposals) {
    const L = leafletStub();
    const map = mapStub();
    const buildCorridorStrips = vi.fn(() => [{ type: 'lane', polygons: [[[0, 0], [0, 1], [1, 1]]] }]);
    // One treatment per pair of distinct corridors in the input (the junction set is found over
    // [{ corridorId, entries }]), so the render's keying and scoping can be observed without any
    // geometry. Arms are what a corridor's own drawing reads from a junction; none here.
    const buildCorridorJunctionSet = vi.fn(corridors => {
        const ids = Array.from(new Set(corridors.map(corridor => String(corridor.corridorId)))).sort();
        const out = [];
        for (let i = 0; i < ids.length; i += 1) {
            for (let j = i + 1; j < ids.length; j += 1) {
                out.push({ lat: 1, lng: 1, degree: 3, surfacePolygons: [[[0, 0], [0, 1], [1, 1]]], crosswalkPolygons: [], corridorIds: [ids[i], ids[j]], arms: [] });
            }
        }
        return out;
    });
    const context = {
        console,
        Map, Set, Array, Number, JSON, Math, Object, String, Infinity, Error, Promise,
        setTimeout, clearTimeout,
        L, map,
        proposalStorage: { getAllProposals: () => proposals.slice() },
        isApplied: proposal => proposal.applied === true,
        getProposalKey: proposal => proposal.proposalId,
        corridorProfileOf: definition => definition.profile,
        corridorCenterlineOf: definition => definition.points,
        corridorSegmentEntries: definition => [{ segmentId: 's1', points: definition.points, profile: definition.profile, width: 6 }],
        buildCorridorStrips,
        buildCorridorLaneMarkingsForEntries: entries => entries.map(() => [{ kind: 'edge', lines: [[[0, 0], [0, 1]]] }]),
        buildCorridorJunctionTreatmentsForEntries: () => [],
        buildCorridorJunctionSet,
        calculateRoadPolygon: () => [[0, 0], [0, 1], [1, 1]],
        // every builder is stubbed, so any frame object serves (corridor-footprint.js frameForDefinition)
        __corridorFootprint: { frameForDefinition: () => ({ latLngToMetric: (lat, lng) => [lng, lat], metricToLatLng: (x, y) => [y, x] }) },
        requestAnimationFrame: callback => callback(),
        CustomEvent,
        dispatchEvent: vi.fn()
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(renderSource, context);
    return { context, map, buildCorridorStrips, buildCorridorJunctionSet, state: context.__corridorRenderState, proposals };
}

const near = (lat, lng) => [{ lat, lng }, { lat: lat + 0.001, lng: lng + 0.001 }];

describe('keyed applied-corridor render', () => {
    it('draws every applied corridor once and every cross junction once on the first refresh', () => {
        const env = environment([road('a', near(0, 0)), road('b', near(0.0005, 0.0005)), road('c', near(0.0002, 0.0008))]);
        env.context.refreshAppliedCorridorStrips();
        expect(env.buildCorridorStrips).toHaveBeenCalledTimes(3);
        expect(Array.from(env.state.byId.keys()).sort()).toEqual(['a', 'b', 'c']);
        expect(Array.from(env.state.junctions.keys()).sort()).toEqual(['a|b@1.000000,1.000000', 'a|c@1.000000,1.000000', 'b|c@1.000000,1.000000']);
        expect(env.map.layers.has(env.state.root)).toBe(true);
        expect(env.map.getPane('corridorJunctionsPane').style).toEqual({ zIndex: '656', pointerEvents: 'none' });
        expect(env.map.getPane('corridorMarkingsPane').style).toEqual({ zIndex: '657', pointerEvents: 'none' });
        expect(env.map.getPane('corridorHitPane').style).toEqual({ zIndex: '659', pointerEvents: 'auto' });
    });

    it('a refresh with nothing changed builds nothing and keeps every group', () => {
        const env = environment([road('a', near(0, 0)), road('b', near(0.0005, 0.0005))]);
        env.context.refreshAppliedCorridorStrips();
        const groupA = env.state.byId.get('a').group;
        const junction = env.state.junctions.get('a|b@1.000000,1.000000');
        env.context.refreshAppliedCorridorStrips();
        expect(env.buildCorridorStrips).toHaveBeenCalledTimes(2);
        expect(env.buildCorridorJunctionSet).toHaveBeenCalledTimes(1);
        // The street network changed once (the first draw), so the block view hears of it once.
        expect(env.context.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(['appliedCorridorsChanged']);
        expect(env.state.byId.get('a').group).toBe(groupA);
        expect(env.state.junctions.get('a|b@1.000000,1.000000')).toBe(junction);
    });

    it('rebuilds only the corridor whose definition changed, and only its junctions', () => {
        const proposals = [road('a', near(0, 0)), road('b', near(0.0005, 0.0005)), road('c', near(0.0002, 0.0008))];
        const env = environment(proposals);
        env.context.refreshAppliedCorridorStrips();
        const groupA = env.state.byId.get('a').group;
        const groupB = env.state.byId.get('b').group;
        const groupC = env.state.byId.get('c').group;
        const junctionAC = env.state.junctions.get('a|c@1.000000,1.000000');
        const junctionAB = env.state.junctions.get('a|b@1.000000,1.000000');

        proposals[1].roadProposal.definition.points = near(0.0006, 0.0004);
        env.buildCorridorStrips.mockClear();
        env.context.refreshAppliedCorridorStrips();

        expect(env.buildCorridorStrips).toHaveBeenCalledTimes(1);
        expect(env.state.byId.get('a').group).toBe(groupA);
        expect(env.state.byId.get('c').group).toBe(groupC);
        expect(env.state.byId.get('b').group).not.toBe(groupB);
        expect(env.state.root.hasLayer(groupB)).toBe(false);
        expect(env.state.root.hasLayer(env.state.byId.get('b').group)).toBe(true);
        expect(env.state.junctions.get('a|c@1.000000,1.000000')).toBe(junctionAC);
        expect(env.state.junctions.get('a|b@1.000000,1.000000')).not.toBe(junctionAB);
        expect(env.state.root.hasLayer(junctionAB)).toBe(false);
    });

    // The stubbed treatments carry no arms, so no corridor's own drawing depends on them; with real
    // junctions the neighbours' lane lines are cut at the stop lines and the neighbours rebuild
    // when a junction they met disappears (corridorJunctionSignature).
    it('unapplying a corridor removes its group and its junctions without rebuilding anything', () => {
        const proposals = [road('a', near(0, 0)), road('b', near(0.0005, 0.0005)), road('c', near(0.0002, 0.0008))];
        const env = environment(proposals);
        env.context.refreshAppliedCorridorStrips();
        const groupC = env.state.byId.get('c').group;
        proposals[2].applied = false;
        env.buildCorridorStrips.mockClear();
        env.context.dispatchEvent.mockClear();
        env.context.refreshAppliedCorridorStrips();
        expect(env.buildCorridorStrips).not.toHaveBeenCalled();
        expect(env.context.dispatchEvent).toHaveBeenCalledTimes(1);
        expect(env.state.byId.has('c')).toBe(false);
        expect(env.state.root.hasLayer(groupC)).toBe(false);
        expect(Array.from(env.state.junctions.keys()).sort()).toEqual(['a|b@1.000000,1.000000']);
    });

    it('only corridors whose bbox touches a changed one are handed to the junction finder', () => {
        const proposals = [road('a', near(0, 0)), road('b', near(0.0005, 0.0005)), road('far', near(10, 10))];
        const env = environment(proposals);
        env.context.refreshAppliedCorridorStrips();
        proposals[0].roadProposal.definition.points = near(0.0001, 0.0001);
        env.buildCorridorJunctionSet.mockClear();
        env.context.refreshAppliedCorridorStrips();
        expect(env.buildCorridorJunctionSet).toHaveBeenCalledTimes(1);
        const ids = env.buildCorridorJunctionSet.mock.calls[0][0].map(corridor => corridor.corridorId);
        expect(ids).toEqual(['a', 'b']);
    });

    it('the cross-section preview rebuilds the previewed corridor alone, and once more when cleared', () => {
        const env = environment([road('a', near(0, 0)), road('b', near(0.0005, 0.0005))]);
        env.context.refreshAppliedCorridorStrips();
        const groupB = env.state.byId.get('b').group;
        env.buildCorridorStrips.mockClear();
        env.context.setCorridorProfilePreview('a', { strips: [{ type: 'lane', left: 5, right: -5 }] });
        expect(env.buildCorridorStrips).toHaveBeenCalledTimes(1);
        expect(env.state.byId.get('b').group).toBe(groupB);
        env.buildCorridorStrips.mockClear();
        env.context.clearCorridorProfilePreview();
        expect(env.buildCorridorStrips).toHaveBeenCalledTimes(1);
        expect(env.state.byId.get('b').group).toBe(groupB);
    });
});

describe('keyed render pure pieces', () => {
    it('diffs previous hashes against the applied set', () => {
        const previous = new Map([['a', 'h1'], ['b', 'h2'], ['gone', 'h3']]);
        expect(pure.corridorRenderDiff(previous, [{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'changed' }, { id: 'new', hash: 'h4' }]))
            .toEqual({ removed: ['gone'], changed: ['b', 'new'] });
    });

    it('hashes the definition, the owner class and only the matching preview', () => {
        const proposal = { proposalId: 'a' };
        const definition = { points: [1, 2] };
        const base = pure.corridorRenderHash(proposal, definition, null);
        expect(pure.corridorRenderHash(proposal, definition, { proposalKey: 'b', profile: {} })).toBe(base);
        expect(pure.corridorRenderHash(proposal, definition, { proposalKey: 'a', profile: {} })).not.toBe(base);
        expect(pure.corridorRenderHash(proposal, { points: [1, 3] }, null)).not.toBe(base);
    });

    it('takes a bbox from centerline points and a footprint in either shape', () => {
        expect(pure.corridorRenderBbox({ polygon: { type: 'Polygon', coordinates: [[[10, 1], [11, 2]]] } }, [{ points: [{ lat: 0, lng: 9 }] }]))
            .toEqual([9, 0, 11, 2]);
        expect(pure.corridorRenderBbox({ polygon: [[[10, 1], [11, 2]]] }, [])).toEqual([10, 1, 11, 2]);
        expect(pure.corridorRenderBbox({}, [])).toBeNull();
        expect(pure.corridorBboxIntersects([0, 0, 1, 1], [1.00001, 0, 2, 1], 1e-4)).toBe(true);
        expect(pure.corridorBboxIntersects([0, 0, 1, 1], [1.001, 0, 2, 1], 1e-4)).toBe(false);
    });
});

describe('road-scope preview that keeps per-stretch cross-sections', () => {
    it('restyles only the stretches without their own cross-section when keepOverrides is set', () => {
        const env = environment([road('a', near(0, 0), { definition: { segmentProfiles: { s1: { strips: [{ type: 'lane', left: 2, right: -2 }] } } } })]);
        env.context.corridorSegmentEntries = definition => [
            { segmentId: 's1', points: definition.points, profile: definition.segmentProfiles.s1, width: 4 },
            { segmentId: 's2', points: definition.points, profile: definition.profile, width: 6 }
        ];
        env.context.refreshAppliedCorridorStrips();
        const preview = { strips: [{ type: 'lane', left: 5, right: -5 }] };
        env.context.setCorridorProfilePreview('a', preview, null, { keepOverrides: true });
        const kept = env.context.corridorRenderEntries(env.proposals[0], env.proposals[0].roadProposal.definition);
        expect(kept.map(entry => entry.profile === preview)).toEqual([false, true]);
        env.context.setCorridorProfilePreview('a', preview, null);
        const all = env.context.corridorRenderEntries(env.proposals[0], env.proposals[0].roadProposal.definition);
        expect(all.map(entry => entry.profile === preview)).toEqual([true, true]);
    });
});

// A click on an applied corridor's own hit target: the drill (which reads LAND footprints) decides
// only when its stack holds that corridor. A tunnelled stretch has no land, so the drill saw only
// the parcels above it and the tap on the drawn track opened a parcel (Šibenik, 2026-10-16).
describe('a click on an applied corridor', () => {
    const click = { latlng: { lat: 43.7362, lng: 15.892 } };
    function clickWith(stack) {
        const env = environment([]);
        const handleSurfaceClick = vi.fn(() => true);
        const selectAndHighlightProposal = vi.fn();
        env.context.__drillUi = { stackAt: vi.fn(() => stack), handleSurfaceClick };
        env.context.selectAndHighlightProposal = selectAndHighlightProposal;
        env.context.hideParcelInfoPanel = vi.fn();
        env.context.forwardAppliedCorridorClick({ proposalId: 'track-1' }, click);
        return { handleSurfaceClick, selectAndHighlightProposal };
    }

    it('selects the corridor when the drill stack at the point does not hold it', () => {
        const { handleSurfaceClick, selectAndHighlightProposal } = clickWith([{ kind: 'parcel', id: 'HR-1' }]);
        expect(handleSurfaceClick).not.toHaveBeenCalled();
        expect(selectAndHighlightProposal).toHaveBeenCalledWith('track-1', null, false, true);
    });

    it('lets the drill resolve the point when its stack holds the corridor', () => {
        const { handleSurfaceClick, selectAndHighlightProposal } = clickWith([{ kind: 'proposal', key: 'track-1' }, { kind: 'parcel', id: 'HR-1' }]);
        expect(handleSurfaceClick).toHaveBeenCalledWith(click.latlng);
        expect(selectAndHighlightProposal).not.toHaveBeenCalled();
    });
});

describe('applied-corridor hit targets', () => {
    it('give a stretch without a segment id its own target along the drawn line', () => {
        const proposal = { proposalId: 'track-1', applied: true, roadProposal: { definition: { points: near(0, 0), profile: { strips: [] } } } };
        const env = environment([proposal]);
        const group = env.context.L.layerGroup();
        env.context.renderAppliedCorridorHitTargets([], proposal, group, proposal.roadProposal.definition,
            [{ segmentId: null, points: near(0, 0), width: 6 }], {});
        expect(group.getLayers().filter(layer => layer.kind === 'polygon')).toHaveLength(1);
    });
});
