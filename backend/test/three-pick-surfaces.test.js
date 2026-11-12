// What a click in the 3D views can pick (three-mode.js): a design's unseen pick surfaces (a volume
// only for its buildings), a road's raised span, the buildings under an aerial surface point, and
// what the parcel view leaves out. The functions are read from the source and run against fakes.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const isolation = require('../../frontend/js/three-scene-isolation.js');
const clickPlan = require('../../frontend/js/three-click-plan.js');
const source = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');
const declarations = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
})(parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] }));

// Runs the named three-mode.js functions with `scope` as their surrounding variables.
function load(names, scope) {
    const code = `let { ${Object.keys(scope).join(', ')} } = this.scope;
        ${names.map(name => declarations.get(name)).join('\n')}
        this.api = { ${names.join(', ')}, set: (name, value) => { eval(name + ' = value'); } };`;
    const context = { scope };
    vm.runInNewContext(code, context);
    return context.api;
}

const polygon = id => ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } });
const node = (userData = {}, extra = {}) => ({ userData, visible: true, children: [], isMesh: true, ...extra });

describe('a design\'s pick surfaces (collectSourcePreviewParts)', () => {
    const api = load(['collectSourcePreviewParts', 'collectSourcePreviewFeatures'], {});
    it('gives a height to the buildings only: a road, plots and a park lie flat', () => {
        const tower = polygon('tower'), park = polygon('park');
        const combined = {
            roadProposal: { definition: { polygon: polygon('road').geometry } },
            buildingProposal: { buildings: [tower] },
            parcelLayout: { plots: [{ geometry: polygon('plot').geometry }, null] },
            structureProposal: { geometry: park }
        };
        const parts = api.collectSourcePreviewParts(combined);
        expect(parts.map(part => part.building)).toEqual([false, true, false, false]);
        expect(parts[1].feature).toBe(tower);
        expect(parts[3].feature).toBe(park);
        expect(api.collectSourcePreviewFeatures(combined)).toEqual(parts.map(part => part.feature));
    });
    it('reads a lone building geometry as a building and a design with nothing drawn as no parts', () => {
        const parts = api.collectSourcePreviewParts({ buildingGeometry: polygon('x').geometry, buildingProperties: { height: 12 } });
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ building: true, feature: { properties: { height: 12 } } });
        expect(api.collectSourcePreviewParts({ goal: 'as-is', cadastreParcelIds: ['p1'] })).toEqual([]);
    });
});

describe('a road\'s raised span (addGradeSeparatedCorridors3D)', () => {
    const record = { id: 'deck', mode: 'overpass', from: { lat: 0, lng: 0 }, crossing: { lat: 0, lng: 1 }, to: { lat: 0, lng: 2 }, segmentId: 's1' };
    function build(proposalId) {
        const lane = node({ lane: true });
        const target = { children: [lane], add(child) { this.children.push(child); } };
        const api = load(['addGradeSeparatedCorridors3D'], {
            window: { __corridorFootprint: { frameForDefinition: () => ({}) } },
            CORRIDOR_LANE_TYPES: {}, CORRIDOR_STRIP_Z: 0.05,
            buildCorridorStrips: () => [{ type: 'drive', polygons: [[[0, 0]]] }],
            corridorStripToFeature: value => value, corridorLaneMaterial: () => ({}),
            corridorStripMeshes3D: () => [node()],
            elevateGradeMeshes: () => { },
            addGradeSeparationEdges3D: group => group.add(node({ isGradeSeparationEdge: true }))
        });
        api.addGradeSeparatedCorridors3D(target, { gradeSeparations: [record] }, [{ segmentId: 's1', profile: {} }], null, null, proposalId);
        return { lane, added: target.children.slice(1) };
    }
    it('names the road on the deck and its rails, and on nothing that was there before', () => {
        const { lane, added } = build('road-1');
        expect(added).toHaveLength(2);
        expect(added.map(child => [child.userData.gradeSeparationPick, child.userData.proposalId])).toEqual([[true, 'road-1'], [true, 'road-1']]);
        expect(lane.userData).toEqual({ lane: true });
    });
    it('leaves the span unnamed when the road is not known', () => {
        expect(build(null).added.every(child => !('proposalId' in child.userData) && !child.userData.gradeSeparationPick)).toBe(true);
    });
});

describe('what a click ray is cast against (pickMapSubjectFromEvent)', () => {
    function scene(hits) {
        const cast = [];
        class Raycaster {
            constructor() { this.ray = { direction: { clone: () => 'direction' } }; }
            setFromCamera() { }
            intersectObjects(targets) { cast.push(...targets); return hits; }
        }
        const deck = node({ gradeSeparationPick: true, proposalId: 'road-1' });
        const lane = node({ isCorridorStrip: true });
        const sunk = node({ gradeSeparationPick: true, proposalId: 'road-2' });
        const groups = { proposalInteractionGroup: node(), buildingGroup: node(), flatGroup: node(), plannedFlatGroup: null, stationGroup: null,
            corridorGroup: { children: [deck, lane] }, terrainCorridorGroup: { children: [sunk] } };
        const parcel = { contains: centre => centre === 'on-parcel' };
        const api = load(['pickMapSubjectFromEvent'], {
            ...groups, isolatedParcelId: null,
            renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } }, camera: {},
            THREE: { Raycaster, Vector2: class { } },
            window: { __threeClickPlan: clickPlan, __threeSceneIsolation: isolation },
            getParcelFeatureById: id => (id === 'A' ? parcel : null),
            turf: { point: centre => centre, booleanPointInPolygon: (centre, feature) => feature.contains(centre) }
        });
        return { api, cast, groups, deck, lane, sunk };
    }
    const event = { clientX: 50, clientY: 50 };
    const hit = (userData, distance) => ({ object: { visible: true, userData, parent: null }, distance, point: { x: distance } });

    it('includes a road\'s raised and sunk spans, not its flat lanes', () => {
        const { api, cast, groups, deck, lane, sunk } = scene([]);
        expect(api.pickMapSubjectFromEvent(event)).toBeNull();
        expect(cast).toContain(groups.proposalInteractionGroup);
        expect(cast).toContain(deck);
        expect(cast).toContain(sunk);
        expect(cast).not.toContain(lane);
    });
    it('picks the deck the ray meets before the ground past it', () => {
        const { api } = scene([hit({ gradeSeparationPick: true, proposalId: 'road-1' }, 5), hit({ isParcel: true, parcelId: 'next-door' }, 9)]);
        expect(api.pickMapSubjectFromEvent(event)).toMatchObject({ picked: { proposalId: 'road-1' }, distance: 5, direction: 'direction' });
    });
    it('in the parcel view leaves out the pick volume of a building the view hides', () => {
        const hits = [hit({ proposalId: 'tower', pickVolumeCentre: 'next-door' }, 3), hit({ isParcel: true, parcelId: 'B' }, 8)];
        const whole = scene(hits);
        expect(whole.api.pickMapSubjectFromEvent(event).picked).toMatchObject({ proposalId: 'tower' });
        const viewed = scene(hits);
        viewed.api.set('isolatedParcelId', 'A');
        expect(viewed.api.pickMapSubjectFromEvent(event).picked).toEqual({ proposalId: null, parcelId: 'B' });
        // The building on the viewed parcel is still shown, and still picked.
        const own = scene([hit({ proposalId: 'tower', pickVolumeCentre: 'on-parcel' }, 3), hit({ isParcel: true, parcelId: 'A' }, 8)]);
        own.api.set('isolatedParcelId', 'A');
        expect(own.api.pickMapSubjectFromEvent(event).picked).toMatchObject({ proposalId: 'tower' });
    });
});

describe('the buildings under an aerial surface point (observedBuildingsOver)', () => {
    it('names each building whose model the point is over, once, by surfaces only', () => {
        const house = { id: 'house' }, shed = { id: 'shed' };
        const hits = [
            { object: { isMesh: true, userData: {}, parent: { userData: { planningBuiltFeature: house } } } },
            { object: { isMesh: true, userData: { planningBuiltFeature: house }, parent: null } },
            { object: { isLine: true, userData: { planningBuiltFeature: shed }, parent: null } }
        ];
        const cast = [];
        class Raycaster { constructor(origin, direction) { cast.push([origin, direction]); } intersectObjects() { return hits; } }
        class Vector3 { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
        const api = load(['observedBuildingsOver'], { existingBuildingsGroup: node(), ineligibleBuildingsGroup: null,
            THREE: { Raycaster, Vector3 }, clickedBuildingId: feature => feature.id });
        expect(api.observedBuildingsOver({ x: 4, y: 7, z: 30 })).toEqual([{ id: 'house', feature: house }]);
        expect(cast[0][0]).toMatchObject({ x: 4, y: 7 });
        expect(cast[0][1]).toMatchObject({ x: 0, y: 0, z: -1 });
        expect(api.observedBuildingsOver(null)).toEqual([]);
    });
});

describe('entering the scene before its parcels are loaded (viewGroundMissing)', () => {
    const bounds = { getWest: () => 1, getSouth: () => 2, getEast: () => 3, getNorth: () => 4 };
    const run = (count, fetch = () => { }) => {
        const asked = [];
        const api = load(['viewGroundMissing'], { map: { getBounds: () => bounds },
            window: { LiveParcelFabric: { countBounds: box => { asked.push(box); return count; } }, fetchParcelData: fetch } });
        return { missing: api.viewGroundMissing(), asked };
    };
    it('waits only while the view holds no parcel, and never without a way to load them', () => {
        expect(run(0)).toEqual({ missing: true, asked: [[1, 2, 3, 4]] });
        expect(run(12).missing).toBe(false);
        expect(run(0, null).missing).toBe(false);
        expect(load(['viewGroundMissing'], { map: null, window: {} }).viewGroundMissing()).toBe(false);
    });
});
