// Regression tests for turning one clicked system-road polygon into a normal editable corridor
// proposal, including the parcel-panel entry point that makes the flow reachable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
// Loading the segmentation module registers it on globalThis, which is where the adoption module
// looks for it — the same resolution the browser gets from the script list.
require('../../frontend/js/road-segmentation.js');
require('../../frontend/js/osm-profile.js');
const adoption = require('../../frontend/js/system-road-adoption.js');
const panelSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url),
    'utf8'
);
const indexSource = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const selectionSource = readFileSync(
    new URL('../../frontend/js/parcels/ui/parcel-selection.js', import.meta.url),
    'utf8'
);
const hoverSource = readFileSync(
    new URL('../../frontend/js/parcels/selection.js', import.meta.url),
    'utf8'
);
const ingestSource = readFileSync(
    new URL('../../frontend/js/parcels/ingest.js', import.meta.url),
    'utf8'
);

afterEach(() => {
    [
        'isRoadParcel', 'currentParcel', 'proposalStorage', 'ProposalManager',
        'calculateRoadMetrics', 'corridorProfileFromLegacy', 'openCorridorProfileEditor',
        'getCurrentUsername', 'getCurrentUserAgent', 'getProposalCityId',
        'generateDefaultProposalName', 'updateStatus'
    ].forEach(key => { delete globalThis[key]; });
});

function roadFeature(geometry = {
    type: 'Polygon',
    coordinates: [[[15.9, 45.8], [15.91, 45.8], [15.91, 45.801], [15.9, 45.801], [15.9, 45.8]]]
}) {
    return {
        type: 'Feature',
        properties: { isRoad: true, roadName: 'Test Street' },
        geometry
    };
}

function metrics(lines, width = 12) {
    return {
        widths: { average: width },
        segments: lines.map(centerline => ({ centerline }))
    };
}

describe('system road adoption eligibility', () => {
    it('offers adoption for a source road polygon', () => {
        expect(adoption.canOffer(roadFeature(), 'road-1', [])).toBe(true);

        const ordinaryParcel = roadFeature();
        ordinaryParcel.properties.isRoad = false;
        expect(adoption.canOffer(ordinaryParcel, 'parcel-1', [])).toBe(false);
    });

    it('refuses the corridor a proposal built, but keeps offering the remainder beside it', () => {
        // Applying an adopted street cuts the parcel in two: the corridor that was taken, marked
        // isProposed, and the leftover road land, which carries only ancestorProposal. Treating both
        // as "proposal-derived" is what made every neighbouring street unclickable after the first
        // adoption — the leftover is the rest of the network and is still there to be adopted.
        const builtCorridor = roadFeature();
        builtCorridor.properties.isProposed = true;
        builtCorridor.properties.ancestorProposal = 'proposal-1';
        expect(adoption.canOffer(builtCorridor, 'road-1#p-1', [])).toBe(false);

        const remainder = roadFeature();
        remainder.properties.ancestorProposal = 'proposal-1';
        remainder.properties.proposalId = 'proposal-1';
        expect(adoption.canOffer(remainder, 'road-1#p-2', [])).toBe(true);
    });

    it('keeps offering the parcel once one of its streets is adopted', () => {
        // One cadastral road polygon carries a whole network. Blocking the parcel because it holds
        // a road proposal made every OTHER street in it unclickable after the first adoption.
        const adopted = {
            goal: 'road-track',
            definition: { metadata: { segmentKey: '15.90000,45.80000|15.91000,45.80000' } }
        };
        expect(adoption.canOffer(roadFeature(), 'road-1', [adopted])).toBe(true);
    });

    it('refuses only the segment that is already adopted', () => {
        const key = '15.90000,45.80000|15.91000,45.80000';
        const adopted = { goal: 'road-track', definition: { metadata: { segmentKey: key } } };
        expect(adoption.canOffer(roadFeature(), 'road-1', [adopted], { segmentKey: key })).toBe(false);
        expect(adoption.canOffer(roadFeature(), 'road-1', [adopted], { segmentKey: 'other|segment' })).toBe(true);
    });

    it('names a segment the same way whichever end it starts from', () => {
        const a = [{ lat: 45.8, lng: 15.9 }, { lat: 45.8, lng: 15.91 }];
        expect(adoption.segmentKeyFor(a)).toBe(adoption.segmentKeyFor(a.slice().reverse()));
        expect(adoption.segmentKeyFor(a)).not.toBe(adoption.segmentKeyFor([{ lat: 45.9, lng: 15.9 }, { lat: 45.9, lng: 15.91 }]));
    });

    it('also recognizes roads held only in the road-parcel registry', () => {
        globalThis.isRoadParcel = id => id === 'road-registered';
        const feature = roadFeature();
        feature.properties = {};
        expect(adoption.canOffer(feature, 'road-registered', [])).toBe(true);
    });
});

describe('clicked system road geometry', () => {
    it('selects only the clicked polygon from a disconnected MultiPolygon road feature', () => {
        const left = [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]];
        const right = [[[10, 0], [12, 0], [12, 1], [10, 1], [10, 0]]];
        const feature = roadFeature({ type: 'MultiPolygon', coordinates: [left, right] });

        expect(adoption.clickedRoadGeometry(feature, [11, 0.5])).toEqual({
            type: 'Polygon',
            coordinates: right
        });
    });

    it('chooses the analysed centreline nearest the click', () => {
        const selected = adoption.centerlineFromMetrics(metrics([
            [[0, 0], [0, 10]],
            [[10, 0], [10, 10]]
        ]), [9.9, 4]);
        expect(selected).toEqual([{ lat: 0, lng: 10 }, { lat: 10, lng: 10 }]);
    });
});

describe('system road proposal materialization', () => {
    it('preserves the source polygon while giving the proposal an editable measured profile', () => {
        const feature = roadFeature();
        const profileFactory = width => ({
            strips: [
                { type: 'driving', width: width / 2, direction: 'backward' },
                { type: 'driving', width: width / 2, direction: 'forward' }
            ]
        });
        const proposal = adoption.buildProposal(feature, metrics([
            [[15.9, 45.8005], [15.91, 45.8005]]
        ], 12), {
            parcelId: 'road-1',
            author: 'Planner',
            city: 'zagreb',
            profileFactory
        });

        expect(proposal).toMatchObject({
            author: 'Planner',
            title: 'Test Street',
            goal: 'road-track',
            primaryType: 'Road',
            applied: false,
            parentParcelIds: ['road-1'],
            roadProposal: {
                parentParcelIds: ['road-1'],
                mode: 'adopt-system-road'
            }
        });
        expect(proposal.roadProposal.definition).toMatchObject({
            width: 12,
            segmentIds: ['system-1'],
            metadata: {
                source: 'system-road',
                sourceParcelId: 'road-1'
            }
        });
        expect(proposal.roadProposal.definition.points[0]).toEqual([
            { lat: 45.8005, lng: 15.9 },
            { lat: 45.8005, lng: 15.91 }
        ]);
        expect(proposal.geometry.roadGeometry.polygon).toEqual(feature.geometry);

        feature.geometry.coordinates[0][0][0] = 999;
        expect(proposal.geometry.roadGeometry.polygon.coordinates[0][0][0]).toBe(15.9);
    });

    it('keeps adopted widths inside the profile editor limits', () => {
        expect(adoption.measuredRoadWidth(metrics([], 0.4))).toBe(2);
        expect(adoption.measuredRoadWidth(metrics([], 120))).toBe(80);
    });

    it('stores, applies, and immediately opens the created road in the profile editor', async () => {
        const feature = roadFeature();
        const stored = [];
        const opened = vi.fn();
        globalThis.currentParcel = {
            id: 'road-1',
            layer: { feature },
            clickedLatLng: { lat: 45.8005, lng: 15.905 }
        };
        globalThis.proposalStorage = {
            getProposalsForParcel: vi.fn(() => []),
            addProposal: vi.fn(proposal => {
                stored.push(proposal);
                return 'proposal-1';
            }),
            removeProposal: vi.fn()
        };
        globalThis.ProposalManager = {
            _linkProposalToAncestors: vi.fn(),
            applyProposal: vi.fn(async () => true),
            unapplyProposal: vi.fn()
        };
        globalThis.calculateRoadMetrics = vi.fn(() => metrics([
            [[15.9, 45.8005], [15.91, 45.8005]]
        ], 10));
        globalThis.corridorProfileFromLegacy = width => ({
            strips: [
                { type: 'driving', width: width / 2, direction: 'backward' },
                { type: 'driving', width: width / 2, direction: 'forward' }
            ]
        });
        globalThis.openCorridorProfileEditor = opened;
        globalThis.getCurrentUsername = () => 'Planner';
        globalThis.getProposalCityId = () => 'zagreb';
        globalThis.generateDefaultProposalName = () => 'Road 1';
        globalThis.updateStatus = vi.fn();

        await expect(adoption.adoptSelectedSystemRoad()).resolves.toBe('proposal-1');
        expect(globalThis.proposalStorage.addProposal).toHaveBeenCalledOnce();
        expect(globalThis.ProposalManager.applyProposal).toHaveBeenCalledWith('proposal-1', {
            applyAnyway: true,
            suppressMissingParentAlerts: true
        });
        expect(opened).toHaveBeenCalledWith('proposal-1');
        expect(stored[0].roadProposal.definition.metadata).toMatchObject({
            source: 'system-road',
            sourceParcelId: 'road-1'
        });
        expect(globalThis.proposalStorage.removeProposal).not.toHaveBeenCalled();
    });
});

describe('what a click on an existing road adopts', () => {
    // A 12 m wide road parcel running east from the origin, and the OSM centrelines over it: a
    // through street with a side street meeting it at x=50. Planar metres — planSegmentAdoption is
    // projection-free by design.
    const parcelRingsXY = [[[0, -6], [0, 6], [100, 6], [100, -6], [0, -6]]];
    const osmLinesXY = [
        [[-50, 0], [50, 0], [150, 0]],
        [[50, 0], [50, 80]]
    ];

    it('adopts only the segment up to the junction, not the whole street', () => {
        const plan = adoption.planSegmentAdoption({ parcelRingsXY, osmLinesXY, clickXY: [20, 0] });
        expect(plan.segmentSource).toBe('osm-segment');
        const xs = plan.centerlineXY.map(([x]) => x);
        // Bounded by the parcel at one end (x=0) and by the junction at the other (x=50) — never
        // the 200 m the OSM way actually runs, and never past the junction into the next segment.
        expect(Math.min(...xs)).toBeCloseTo(0, 6);
        expect(Math.max(...xs)).toBeCloseTo(50, 6);
    });

    it('adopts the other side of the junction when the click is on that side', () => {
        const plan = adoption.planSegmentAdoption({ parcelRingsXY, osmLinesXY, clickXY: [80, 0] });
        const xs = plan.centerlineXY.map(([x]) => x);
        expect(Math.min(...xs)).toBeCloseTo(50, 6);
        expect(Math.max(...xs)).toBeCloseTo(100, 6);
    });

    it('derives the width from the room the parcel leaves, not from the profile default', () => {
        const plan = adoption.planSegmentAdoption({ parcelRingsXY, osmLinesXY, clickXY: [20, 0] });
        expect(plan.widthSource).toBe('parcel-clearance');
        expect(plan.width).toBeCloseTo(12, 1);
    });

    it('keeps a derived width inside the profile editor limits', () => {
        const sliver = [[[0, -0.2], [0, 0.2], [100, 0.2], [100, -0.2], [0, -0.2]]];
        const plan = adoption.planSegmentAdoption({
            parcelRingsXY: sliver,
            osmLinesXY: [[[0, 0], [100, 0]]],
            clickXY: [50, 0]
        });
        expect(plan.width).toBeGreaterThanOrEqual(2);
    });

    it('falls back to the parcel axis when no existing centreline covers the click', () => {
        const plan = adoption.planSegmentAdoption({
            parcelRingsXY,
            osmLinesXY: [],
            clickXY: [20, 0],
            fallbackCenterlineXY: [[5, 0], [95, 0]]
        });
        expect(plan.segmentSource).toBe('parcel-axis');
        expect(plan.centerlineXY).toEqual([[5, 0], [95, 0]]);
        // Even on the fallback the width still comes from the parcel — that part never needed OSM.
        expect(plan.width).toBeCloseTo(12, 1);
    });

    it('returns no centreline rather than throwing when it has nothing to work with', () => {
        const plan = adoption.planSegmentAdoption({ parcelRingsXY: [], osmLinesXY: [], clickXY: null });
        expect(plan.centerlineXY).toBeNull();
    });
});

describe('which centrelines define a segment', () => {
    const kind = (highway_type, tags) => ({ highway_type, tags });

    it('segments on the driveable street network', () => {
        ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
            'unclassified', 'living_street', 'pedestrian', 'secondary_link']
            .forEach(type => expect(adoption.definesRoadSegments(kind(type))).toBe(true));
    });

    it('ignores the pedestrian layer, which meets the carriageway every few metres', () => {
        // Counting these as junctions cut one real road parcel into 153 pieces instead of 43.
        ['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor', 'track', 'construction']
            .forEach(type => expect(adoption.definesRoadSegments(kind(type))).toBe(false));
    });

    it('breaks at an alley but not at any other kind of service road', () => {
        // A tagged alley is a street. Bare `service` is the entrance to a car park or a block's
        // courtyard, arriving every few dozen metres — counting those cut one obvious connector
        // along Strojarska cesta into four pieces of 72, 16, 29 and 65 m.
        expect(adoption.definesRoadSegments(kind('service', { service: 'alley' }))).toBe(true);
        expect(adoption.definesRoadSegments(kind('service'))).toBe(false);
        expect(adoption.definesRoadSegments(kind('service', { service: 'driveway' }))).toBe(false);
        expect(adoption.definesRoadSegments(kind('service', { service: 'parking_aisle' }))).toBe(false);
    });

    it('ignores a way with no highway type at all', () => {
        expect(adoption.definesRoadSegments({})).toBe(false);
        expect(adoption.definesRoadSegments(null)).toBe(false);
    });
});

describe('the hover outline never outlives the pointer', () => {
    // Enough of Leaflet, the map and the projection to drive the real fetch -> index -> pick -> draw
    // path in node. The projection is a plain scale so 0.001 deg reads as 1 metre.
    let added;
    let removed;

    function installStubs() {
        added = [];
        removed = [];
        globalThis.turf = turf;
        globalThis.wgs84ToHTRS96 = (lat, lng) => [lng * 1000, lat * 1000];
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.isRoadParcel = () => true;
        globalThis.map = {
            getPane: () => ({ style: {} }),
            createPane: () => ({ style: {} }),
            removeLayer: layer => removed.push(layer),
            hasLayer: () => true
        };
        globalThis.L = {
            geoJSON: (feature) => {
                const layer = { feature, addTo: () => layer };
                added.push(layer);
                return layer;
            }
        };
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                features: [{
                    properties: { highway_type: 'residential', name: 'Test Street' },
                    geometry: { type: 'LineString', coordinates: [[0, 0], [0.2, 0]] }
                }]
            })
        });
    }

    const roadLayer = () => ({
        feature: {
            type: 'Feature',
            properties: { isRoad: true, roadName: 'Test Street' },
            geometry: {
                type: 'Polygon',
                // 200 m long, 20 m wide about the centreline.
                coordinates: [[[0, -0.01], [0.2, -0.01], [0.2, 0.01], [0, 0.01], [0, -0.01]]]
            }
        }
    });

    afterEach(() => {
        adoption.clearSystemRoadSegmentHover();
        ['turf', 'wgs84ToHTRS96', 'htrs96ToWGS84', 'isRoadParcel', 'map', 'L', 'fetch']
            .forEach(key => { delete globalThis[key]; });
    });

    it('draws once the parcel is indexed, without waiting for another pointer move', async () => {
        installStubs();
        const layer = roadLayer();
        // The first hover can only start the build, so it reports nothing drawn yet...
        expect(adoption.hoverSystemRoadSegment('hover-parcel-1', layer, { lat: 0, lng: 0.1 })).toBe(false);
        // ...and the outline must then appear on its own, for that same pointer position.
        await vi.waitFor(() => expect(added.length).toBeGreaterThan(0));
    });

    it('drops the outline when the pointer moves to a parcel that is not indexed yet', async () => {
        installStubs();
        adoption.hoverSystemRoadSegment('hover-parcel-2', roadLayer(), { lat: 0, lng: 0.1 });
        await vi.waitFor(() => expect(added.length).toBeGreaterThan(0));

        // Moving to a different road parcel: its centrelines are not fetched yet, so nothing can be
        // drawn — and the PREVIOUS parcel's outline must not be left lit under the new pointer.
        removed.length = 0;
        expect(adoption.hoverSystemRoadSegment('hover-parcel-3', roadLayer(), { lat: 0, lng: 0.1 })).toBe(false);
        expect(removed.length).toBeGreaterThan(0);
    });
});

describe('the plan the adopt button actually gets', () => {
    // This drives resolveAdoptionPlan itself, which nothing else did — every other test called the
    // pure planner directly. Two undeclared-variable bugs lived in that function for a while, each
    // swallowed by its own try/catch, and each silently sent the adopted road down the parcel-axis
    // fallback: a straight bar through the centroid at the skeleton's average width.
    function installStubs() {
        globalThis.turf = turf;
        globalThis.wgs84ToHTRS96 = (lat, lng) => [lng * 1000, lat * 1000];
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({
                features: [{
                    properties: { highway_type: 'residential', name: 'Bend Street' },
                    geometry: {
                        type: 'LineString',
                        // A curve, so a straight-line fallback is distinguishable from the real thing.
                        coordinates: [[0, 0], [0.05, 0.001], [0.1, 0.003], [0.15, 0.006], [0.2, 0.01]]
                    }
                }]
            })
        });
    }
    const parcel = {
        type: 'Polygon',
        coordinates: [[[0, -0.012], [0.2, -0.002], [0.2, 0.022], [0, 0.012], [0, -0.012]]]
    };

    afterEach(() => {
        ['turf', 'wgs84ToHTRS96', 'htrs96ToWGS84', 'fetch'].forEach(k => { delete globalThis[k]; });
    });

    it('resolves a plan rather than falling through to the parcel axis', async () => {
        installStubs();
        const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'plan-parcel-1' });
        expect(plan).not.toBeNull();
        expect(plan.segmentSource).toBe('osm-segment');
    });

    it('keeps the centreline bent, so the road follows the corridor', async () => {
        installStubs();
        const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'plan-parcel-2' });
        // The parcel-axis fallback is a straight two-point bar; a real segment keeps its vertices.
        expect(plan.centerline.length).toBeGreaterThan(2);
    });

    it('derives the width by measurement, not from the profile default', async () => {
        installStubs();
        const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'plan-parcel-3' });
        expect(plan.widthSource).toMatch(/clearance/);
        expect(plan.width).toBeGreaterThan(0);
    });

    // The whole translator, over the same fetch -> index -> pick path the click takes: an adopted
    // street should come out with the section OSM says it has, not merely one that fits the metres.
    describe('the cross-section read off the OSM ways', () => {
        // The same bent street, now tagged, with a pavement mapped as its own way 6 m off each side —
        // which is how Zagreb maps them, and the only reason `sidewalk=separate` can mean anything.
        // The two profile builders the browser gets from corridor-profile.js's script tag: the OSM
        // bridge the translator reads tags through, and the geometric fit it falls back to.
        function installProfileGlobals() {
            const profiles = require('../../frontend/js/corridor-profile.js');
            globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
            globalThis.corridorProfileForAvailableWidth = profiles.corridorProfileForAvailableWidth;
        }

        function installTaggedStubs(streetTags) {
            installStubs();
            installProfileGlobals();
            const bend = [[0, 0], [0.05, 0.001], [0.1, 0.003], [0.15, 0.006], [0.2, 0.01]];
            const shifted = offset => bend.map(([lng, lat]) => [lng, lat + offset]);
            globalThis.fetch = async () => ({
                ok: true,
                json: async () => ({
                    features: [
                        {
                            properties: { highway_type: 'residential', name: 'Bend Street', tags: streetTags },
                            geometry: { type: 'LineString', coordinates: bend }
                        },
                        {
                            properties: { highway_type: 'footway', tags: { footway: 'sidewalk' } },
                            geometry: { type: 'LineString', coordinates: shifted(0.006) }
                        },
                        {
                            properties: { highway_type: 'footway', tags: { footway: 'sidewalk' } },
                            geometry: { type: 'LineString', coordinates: shifted(-0.006) }
                        }
                    ]
                })
            });
        }

        afterEach(() => {
            delete globalThis.corridorProfileFromOsmTags;
            delete globalThis.corridorProfileForAvailableWidth;
        });

        it('keeps the lane count the street has instead of the one that would fit', async () => {
            installTaggedStubs({ highway: 'residential', lanes: '2', 'sidewalk:both': 'separate' });
            const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'osm-profile-1' });
            expect(plan.profileSource).toBe('osm-tags');
            expect(plan.streetName).toBe('Bend Street');
            const lanes = plan.profile.strips.filter(s => s.type === 'driving').length;
            expect(lanes).toBe(2);
            // A corridor this wide fits more lanes than the street has, which is exactly the point.
            const fitted = require('../../frontend/js/corridor-profile.js').corridorProfileForAvailableWidth(plan.width);
            expect(fitted.strips.filter(s => s.type === 'driving').length).toBeGreaterThan(lanes);
        });

        it('reads the parking off the tags, on the side the tags put it', async () => {
            installTaggedStubs({ highway: 'residential', lanes: '2', 'parking:left': 'lane', 'parking:right': 'no' });
            const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'osm-profile-2' });
            const parking = plan.profile.strips.filter(s => s.type.startsWith('parking'));
            expect(parking.length).toBe(1);
            // parking:right=no, so the fit must not hand the street a second bay for symmetry.
            const before = plan.profile.strips.findIndex(s => s.type === 'driving');
            expect(plan.profile.strips.slice(0, before).some(s => s.type.startsWith('parking'))).toBe(true);
        });

        it('hands that section to the adopted definition, summing to the road\'s width', async () => {
            installTaggedStubs({ highway: 'residential', lanes: '2', 'sidewalk:both': 'separate' });
            const plan = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'osm-profile-3' });
            const definition = adoption.buildDefinition(
                { type: 'Feature', properties: {}, geometry: parcel },
                null,
                { plan, clickLngLat: [0.1, 0.004], parcelId: 'osm-profile-3' }
            );
            expect(definition.profile.strips.map(s => s.type)).toEqual(plan.profile.strips.map(s => s.type));
            const total = definition.profile.strips.reduce((sum, s) => sum + s.width, 0);
            expect(total).toBeCloseTo(definition.width, 2);
        });

        // Outside the mapped centre a road parcel has no OSM way to read, and the adoption still has
        // to produce a road. The section then comes from the geometric fit, as it did before.
        it('falls back to the geometric fit when the segment has no OSM section to read', async () => {
            installTaggedStubs({ highway: 'residential', lanes: '2' });
            const resolved = await adoption.resolveAdoptionPlan(parcel, [0.1, 0.004], null, { parcelId: 'osm-profile-4' });
            const plan = { ...resolved, profile: null, profileSource: null };
            const definition = adoption.buildDefinition(
                { type: 'Feature', properties: {}, geometry: parcel },
                null,
                { plan, clickLngLat: [0.1, 0.004], parcelId: 'osm-profile-4' }
            );
            const fitted = globalThis.corridorProfileForAvailableWidth(definition.width);
            expect(definition.profile.strips.map(s => s.type)).toEqual(fitted.strips.map(s => s.type));
        });
    });
});

describe('the cross-section fitted into an adopted corridor', () => {
    const fit = require('../../frontend/js/corridor-profile.js').corridorProfileForAvailableWidth;
    const total = p => Number(p.strips.reduce((a, s) => a + s.width, 0).toFixed(6));

    it('fills the corridor exactly, whatever the width', () => {
        [3, 5, 6, 7.5, 10, 12, 16, 20, 25, 30, 44].forEach(w => {
            expect(total(fit(w))).toBeCloseTo(w, 6);
        });
    });

    it('puts a footway on each side and fits lanes between them', () => {
        const p = fit(12);
        expect(p.strips[0].type).toBe('sidewalk');
        expect(p.strips[p.strips.length - 1].type).toBe('sidewalk');
        expect(p.strips.filter(s => s.type === 'driving').length).toBe(2);
    });

    it('carries both directions on a narrow street rather than one wide lane', () => {
        // 7.5 m is the classic side street: 1 + 2.75 + 2.75 + 1.
        const p = fit(7.5);
        expect(p.strips.filter(s => s.type === 'driving').length).toBe(2);
        expect(p.strips.filter(s => s.type === 'sidewalk').every(s => s.width >= 1)).toBe(true);
    });

    it('adds kerbside parking only once two lanes are already covered', () => {
        expect(fit(10).strips.some(s => s.type === 'parking')).toBe(false);
        expect(fit(16).strips.filter(s => s.type === 'parking').length).toBe(2);
    });

    it('adds lanes as the corridor widens, in balanced pairs', () => {
        const lanes = w => fit(w).strips.filter(s => s.type === 'driving').length;
        expect(lanes(10)).toBe(2);
        expect(lanes(20)).toBeGreaterThan(lanes(10));
        [10, 16, 20, 25, 30].forEach(w => expect(lanes(w) % 2).toBe(0));
    });

    it('never returns a lane wider than a lane should be', () => {
        // The old path halved the width: a 25 m corridor became two 12.5 m "lanes".
        [10, 16, 20, 25, 30, 44].forEach(w => {
            fit(w).strips.filter(s => s.type === 'driving').forEach(s => expect(s.width).toBeLessThanOrEqual(3.5));
        });
    });

    it('gives an alley the whole width as carriageway rather than nothing', () => {
        const p = fit(3);
        expect(total(p)).toBeCloseTo(3, 6);
        expect(p.strips.some(s => s.type === 'driving')).toBe(true);
    });
});

describe('system road adoption UI contract', () => {
    it('loads the adoption module and exposes the parcel-panel action', () => {
        expect(indexSource).toContain("'js/system-road-adoption.js'");
        expect(panelSource).toContain('global.SystemRoadAdoption.canOffer(feature, parcelKey, parcelProposals)');
        expect(panelSource).toContain('onclick="adoptSelectedSystemRoad()"');
    });

    it('loads the segmentation module before the adoption module that reads it', () => {
        expect(indexSource).toContain("'js/road-segmentation.js'");
        expect(indexSource.indexOf("'js/road-segmentation.js'"))
            .toBeLessThan(indexSource.indexOf("'js/system-road-adoption.js'"));
    });

    it('outlines the hovered segment instead of the whole road parcel', () => {
        expect(hoverSource).toContain('hoverSystemRoadSegment');
        expect(hoverSource).toContain('clearSystemRoadSegmentHover');
    });

    it('tracks the pointer along a road parcel, not just its entry point', () => {
        // mouseover fires once per polygon; a road parcel is hundreds of metres of street, so
        // without mousemove the outline sticks to whichever segment the pointer entered on.
        expect(hoverSource).toContain('mousemove: trackRoadSegmentHover');
        expect(ingestSource).toContain('mousemove:');
        expect(ingestSource).toContain('trackRoadSegmentHover');
    });

    it('previews the clicked segment from the parcel selection', () => {
        // Without this call the click highlights the whole cadastral road polygon, which on a
        // parcel carrying a street network reads as "the entire network is selected".
        expect(selectionSource).toContain('previewSelectedSystemRoadSegment');
    });
});
