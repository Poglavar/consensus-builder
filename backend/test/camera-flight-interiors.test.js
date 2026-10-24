// Unit crops keep real door/window geometry, metric dimensions and geographic registration.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url), THREE = require('three');
const Interiors = require('../../frontend/js/camera-flight-interiors.js');
const geometry = require('../../packages/interior-viewer/src/geometry.cjs');
const meshes = require('../../packages/interior-viewer/src/meshes.cjs');
const navigation = require('../../packages/interior-viewer/src/navigation.cjs');
const generator = require('../../frontend/js/default-floor-plans.js');
const rooms = require('../../frontend/js/default-floor-plan-rooms.js');
const clone = value => JSON.parse(JSON.stringify(value));
const rect = (u0, v0, u1, v1) => [[[u0, v0], [u1, v0], [u1, v1], [u0, v1]]];
const close = ring => [...ring, ring[0]];
const boundaryShape = boundary => turf.multiPolygon(boundary.map(polygon => polygon.map(close)));
const metre = Math.PI * 6378137 / 180, lat = 52, lng = -1, mx = metre * Math.cos(lat * Math.PI / 180);
const geographic = ([x, y]) => [lng + x / mx, lat + y / metre];
function architecture() {
    return { schema: geometry.ARCHITECTURE_SCHEMA, dimensionsM: [20, 10], wallHeightM: 2.8, slabThicknessM: 0.2,
        walls: [rect(0, 0, 0.015, 1), rect(0.985, 0, 1, 1), rect(0, 0, 1, 0.015), rect(0, 0.985, 1, 1),
            rect(0.49, 0, 0.505, 0.5), rect(0.49, 0.6, 0.505, 1), rect(0.25, 0.015, 0.26, 0.4),
            rect(0.25, 0.5, 0.26, 0.985), rect(0.75, 0.2, 0.76, 0.8)],
        slabs: [rect(0, 0, 1, 1)], landings: [rect(0.1, 0.7, 0.2, 0.9)],
        platforms: [{ rings: rect(0.1, 0.7, 0.2, 0.9), elevationM: 0.5, kind: 'landing' }],
        openings: [
            { kind: 'window', room: 'living', a: [0.0075, 0.2], b: [0.0075, 0.4], depthM: 0.3, sillM: 1, heightM: 1.2 },
            { kind: 'door', room: 'apartment', a: [0.4975, 0.5], b: [0.4975, 0.6], hinge: [0.4975, 0.6], openTip: [0.4475, 0.6], depthM: 0.3, sillM: 0, heightM: 2.1 },
            { kind: 'door', room: 'bedroom', a: [0.255, 0.4], b: [0.255, 0.5], hinge: [0.255, 0.5], openTip: [0.305, 0.5], depthM: 0.2, sillM: 0, heightM: 2.1 },
            { kind: 'window', room: 'neighbor', a: [0.9925, 0.2], b: [0.9925, 0.4], depthM: 0.3, sillM: 1, heightM: 1.2 }],
        stairs: [{ a: [0.15, 0.7], b: [0.15, 0.9], widthM: 1, steps: 5, fromM: 0, toM: 0.5 }],
        railings: [{ a: [0.1, 0.7], b: [0.1, 0.9], heightM: 1 }],
        inference: { wallFootprints: 'documented' } };
}
function feature() {
    return { type: 'Feature', geometry: turf.polygon([rect(0, 0, 20, 10)[0].map(geographic).concat([geographic([0, 0])])]).geometry,
        properties: { floorPlans: { schema: geometry.SCHEMA, suggested: false,
            registration: { corners: [[0, 0], [20, 0], [20, 10], [0, 10]].map(geographic), basis: 'Survey registration', accuracy: 'documented' },
            layouts: [{ id: 'layout', source: { kind: 'drawing', url: 'https://example.test/floor', sha256: 'abc' }, architecture: architecture() }],
            floors: [-1, 0, 3].map(level => ({ id: `floor-${level}`, level, elevationM: level * 3, elevationBasis: 'documented', layoutId: 'layout',
                apartments: [{ id: 'left', name: 'Left apartment', areaM2: 92, boundary: [rect(0.015, 0.015, 0.49, 0.985)],
                    entryUv: [0.45, 0.55], rooms: [{ kind: 'living', areaM2: 30 }, { kind: 'bedroom', areaM2: 18 }] }] })) } } };
}
const list = f => Interiors.listUnits(f, { geometry, turf });
const metricLength = (a, b, dimensions) => Math.hypot(...a.map((n, i) => (n - b[i]) * dimensions[i]));

describe('registered apartment interior entries', () => {
    it('crops a unit while retaining perimeter walls, windows, the entrance door and room partitions', () => {
        const source = feature(), original = clone(source), units = list(source), unit = units[1], model = unit.architecture;
        expect(source).toEqual(original); expect(units).toHaveLength(3);
        expect(unit).toMatchObject({ id: 'floor-0/apartment/left', floorId: 'floor-0', apartmentId: 'left', level: 0,
            elevationM: 0, suggested: false, name: 'Left apartment', entryUv: [0.45, 0.55], registration: { accuracy: 'documented' } });
        expect(unit.rooms.map(room => room.kind)).toEqual(['living', 'bedroom']);
        expect(model.dimensionsM[0]).toBeGreaterThan(9.5); expect(model.dimensionsM[0]).toBeLessThan(10.3);
        expect(model.walls.length).toBeGreaterThan(4); expect(model.walls).not.toEqual(original.properties.floorPlans.layouts[0].architecture.walls);
        expect(model.openings.map(opening => opening.room)).toEqual(['living', 'apartment', 'bedroom']);
        expect(model.openings.find(opening => opening.room === 'apartment').kind).toBe('door');
        expect(model.landings.length).toBeGreaterThan(0); expect(model.platforms[0].elevationM).toBe(0.5);
        expect(model.stairs[0]).toMatchObject({ widthM: 1, steps: 5, fromM: 0, toM: 0.5 });
        expect(model.railings[0].heightM).toBe(1); expect(model.inference).toEqual({ wallFootprints: 'documented' });
        for (const opening of model.openings) {
            const before = original.properties.floorPlans.layouts[0].architecture.openings.find(candidate => candidate.room === opening.room);
            expect(opening.depthM).toBe(before.depthM); expect(opening.heightM).toBe(before.heightM);
            expect(metricLength(opening.a, opening.b, model.dimensionsM)).toBeCloseTo(metricLength(before.a, before.b, [20, 10]), 7);
            if (opening.hinge) expect(metricLength(opening.hinge, opening.openTip, model.dimensionsM)).toBeCloseTo(1, 7);
        }
    });

    it('preserves the full irregular apartment when a generated ring has a collinear seam spur', () => {
        const f = feature(), plans = f.properties.floorPlans;
        plans.registration.corners = [[-1.880177509,52.47869979],[-1.880082729,52.47902799],[-1.880370204,52.479058786],[-1.880464984,52.478730586]];
        plans.layouts[0].architecture.dimensionsM = [37.0958,19.7899];
        plans.floors = [plans.floors[1]];
        plans.floors[0].apartments = [{ id: 'irregular', entryUv: [.42,.2], boundary: [[[[.348483,.101079],[.435114,.101079],[.435114,.440629],[.497116,.440629],[.497116,.89892],[.351853,.898921],[.351853,.101079]]]] }];
        const [unit] = list(f);
        expect(unit.architecture.dimensionsM[0]).toBeGreaterThan(5);
        expect(unit.architecture.dimensionsM[1]).toBeGreaterThan(15);
        expect(unit.boundary).toEqual(plans.floors[0].apartments[0].boundary);
    });

    it('builds a valid real Three.js unit mesh with walls, glass, doors and finite vertex buffers', () => {
        const unit = list(feature())[0]; expect(geometry.validateArchitecture(unit.architecture)).toEqual([]);
        const group = meshes.createLocalUnitGroup(THREE, unit.architecture, geometry);
        expect(group.children.map(mesh => mesh.name)).toEqual(expect.arrayContaining(['UnitPart:wall', 'UnitPart:slab', 'UnitPart:door', 'UnitPart:glass']));
        for (const child of group.children) {
            expect(child.geometry.attributes.position.count).toBeGreaterThan(0);
            expect(Array.from(child.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);
        }
        meshes.disposeGroup(group);
    });

    it('retains floor elevations and stable apartment identities across floors and repeated evaluation', () => {
        const source = feature(), units = list(source);
        expect(units.map(unit => unit.elevationM)).toEqual([-3, 0, 9]);
        expect(new Set(units.map(unit => unit.id)).size).toBe(3); expect(list(source)).toEqual(units);
        units[0].architecture.walls[0][0][0][0] = 999; units[0].boundary[0][0][0][0] = 999;
        expect(list(source)[0].architecture.walls[0][0][0][0]).toBeLessThan(1);
        expect(list(source)[0].boundary[0][0][0][0]).toBe(0.015);
    });

    it('reuses repeated floor crops while keeping each returned floor architecture independent', () => {
        let buffers = 0;
        const units = Interiors.listUnits(feature(), { geometry, turf: { ...turf, buffer: (...args) => { buffers++; return turf.buffer(...args); } } });
        expect(buffers).toBe(1);
        const before = clone(units[1].architecture);
        units[0].architecture.walls[0][0][0][0] = 999; expect(units[1].architecture).toEqual(before);
    });

    it('clips an outward door leaf on its actual line instead of moving its endpoint sideways', () => {
        const source = feature(), door = source.properties.floorPlans.layouts[0].architecture.openings.find(opening => opening.room === 'bedroom');
        door.openTip = [0.8, 0.8];
        const unit = list(source)[0], clipped = unit.architecture.openings.find(opening => opening.room === 'bedroom');
        const x = (clipped.openTip[0] - clipped.hinge[0]) * unit.architecture.dimensionsM[0];
        const y = (clipped.openTip[1] - clipped.hinge[1]) * unit.architecture.dimensionsM[1];
        expect(y / x).toBeCloseTo((0.8 - 0.5) * 10 / ((0.8 - 0.255) * 20), 7);
        expect(metricLength(clipped.hinge, clipped.openTip, unit.architecture.dimensionsM)).toBeLessThan(metricLength(door.hinge, door.openTip, [20, 10]));
    });

    it('maps the expanded unit registration through the original bilinear map at rotated/skewed corners', () => {
        const source = feature(), plans = source.properties.floorPlans;
        plans.registration.corners = [[0, 0], [17, 11], [13, 20], [-6, 8]].map(geographic);
        const unit = list(source)[0], originalMap = geometry.registrationToLngLat(plans), unitMap = geometry.registrationToLngLat({ registration: unit.registration });
        const corners = unit.registration.corners;
        expect(corners).not.toEqual(plans.registration.corners);
        const entry = originalMap(...unit.entryUv);
        expect(turf.booleanPointInPolygon(turf.point(entry), turf.polygon([corners.concat([corners[0]])]))).toBe(true);
        expect(turf.distance(originalMap(0.015, 0.015), corners[0], { units: 'meters' })).toBeGreaterThan(0.3);
        expect(unitMap(0, 0)).toEqual(corners[0]); expect(unitMap(1, 1)).toEqual(corners[2]);
    });

    it('uses real meter buffers at different latitudes instead of treating normalized UV as meters', () => {
        const source = feature(), low = list(source)[0];
        const highSource = feature();
        const highLat = 68, highMx = metre * Math.cos(highLat * Math.PI / 180);
        highSource.properties.floorPlans.registration.corners = [[0, 0], [20, 0], [20, 10], [0, 10]].map(([x, y]) => [1 + x / highMx, highLat + y / metre]);
        const high = list(highSource)[0];
        expect(high.architecture.dimensionsM[0]).toBeCloseTo(low.architecture.dimensionsM[0], 3);
        expect(high.architecture.dimensionsM[1]).toBeCloseTo(low.architecture.dimensionsM[1], 3);
    });

    it('falls back to an explicitly floor-level entry when source apartments lack spatial boundaries', () => {
        const source = feature(); source.properties.floorPlans.floors.forEach(floor => floor.apartments.forEach(apartment => { delete apartment.boundary; delete apartment.entryUv; }));
        const units = list(source);
        expect(units.map(unit => unit.id)).toEqual(['floor--1/floor', 'floor-0/floor', 'floor-3/floor']);
        expect(units.every(unit => unit.apartmentId === null)).toBe(true);
        expect(units[0].architecture).toEqual(source.properties.floorPlans.layouts[0].architecture);
        expect(units[0].registration).toEqual(source.properties.floorPlans.registration);
        expect(units[0].entryUv.every(Number.isFinite)).toBe(true); expect(units[0]).not.toHaveProperty('name');
    });

    it('finds a strictly interior point for concave units even when a point-on-feature returns a boundary vertex', () => {
        const source = feature(), boundary = [[[[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.7, 0.95],
            [0.7, 0.3], [0.3, 0.3], [0.3, 0.95], [0.05, 0.95]]]];
        source.properties.floorPlans.floors.forEach(floor => { floor.apartments[0].boundary = boundary; delete floor.apartments[0].entryUv; });
        const units = Interiors.listUnits(source, { geometry, turf: { ...turf, pointOnFeature: () => turf.point([0.05, 0.05]) } });
        for (const unit of units) expect(turf.booleanPointInPolygon(turf.point(unit.entryUv), boundaryShape(boundary), { ignoreBoundary: true })).toBe(true);
    });

    it('refuses invalid boundaries, outside entries, failed buffering and invalid floor registrations', () => {
        for (const mutate of [p => { p.floors[0].apartments[0].boundary = null; },
            p => { p.floors[0].apartments[0].boundary[0][0][0] = [NaN, 0]; },
            p => { p.floors[0].apartments[0].entryUv = [0.9, 0.9]; },
            p => { p.registration.corners[1] = p.registration.corners[0]; }]) {
            const source = feature(); mutate(source.properties.floorPlans); expect(() => list(source)).toThrow();
        }
        expect(() => Interiors.listUnits(feature(), { geometry, turf: { ...turf, buffer: () => null } })).toThrow(/buffer/);
        expect(() => Interiors.listUnits(feature(), { geometry, turf: { ...turf, buffer: () => { throw new Error('buffer failure'); } } })).toThrow(/buffer failure/);
    });

    it('validates nonempty normalized rings, holes and crossing boundaries before clipping', () => {
        expect(Interiors.validateBoundary([rect(0.1, 0.1, 0.9, 0.9)])).toBeNull();
        expect(Interiors.validateBoundary([[...rect(0.1, 0.1, 0.9, 0.9), rect(0.3, 0.3, 0.5, 0.5)[0]]])).toBeNull();
        for (const boundary of [[], null, new Array(1), [[new Array(4)]], [rect(-0.1, 0, 0.5, 1)],
            [[[[0, 0], [1, 1], [0, 1], [1, 0]]]], [[[[0, 0], [0.5, 0.5], [1, 1]]]],
            [[...rect(0.1, 0.1, 0.5, 0.5), rect(0.6, 0.6, 0.8, 0.8)[0]]]]) expect(Interiors.validateBoundary(boundary)).toBeTypeOf('string');
    });

    it('has no fabricated entries without floor data and can resolve its optional Node dependencies from backend cwd', () => {
        expect(Interiors.listUnits({ type: 'Feature', properties: {} })).toEqual([]);
        expect(Interiors.listUnits(feature()).map(unit => unit.apartmentId)).toEqual(['left', 'left', 'left']);
    });
});

describe('generated apartment spatial metadata', () => {
    it('retains suggested boundaries, inside entry points, door anchors and room metadata in validated snapshots', () => {
        const footprint = turf.polygon([[[0, 0], [20, 0], [20, 12], [0, 12], [0, 0]].map(geographic)]);
        const result = generator.planDefaultFloorPlans({ footprint, floors: 3, storeyHeightM: 3, buildingId: 'test-building',
            front: { a: geographic([0, 0]), b: geographic([20, 0]), basis: 'street' } },
        { turf, rooms, rules: { garage: 'never', groundFloorUse: 'residential' }, validate: geometry.validateFloorPlans });
        expect(result.floorPlans).not.toBeNull();
        const plans = clone(result.floorPlans); expect(geometry.validateFloorPlans(plans)).toEqual([]);
        expect(plans.suggested).toBe(true); expect(plans.floors.map(floor => floor.elevationM)).toEqual([0, 3, 6]);
        for (const floor of plans.floors) for (const apartment of floor.apartments) {
            expect(apartment.suggested).toBe(true); expect(Interiors.validateBoundary(apartment.boundary)).toBeNull();
            expect(turf.booleanPointInPolygon(turf.point(apartment.entryUv), boundaryShape(apartment.boundary), { ignoreBoundary: true })).toBe(true);
            expect(apartment.doorUv).toMatchObject({ a: expect.any(Array), b: expect.any(Array), hinge: expect.any(Array), openTip: expect.any(Array) });
            expect(apartment.rooms.map(room => room.kind)).toEqual(expect.arrayContaining(['living', 'hall']));
        }
        const units = list({ ...footprint, properties: { floorPlans: plans } });
        expect(units).toHaveLength(6); expect(units.every(unit => unit.suggested)).toBe(true);
        expect(new Set(units.map(unit => unit.id)).size).toBe(6);
        for (const unit of units) {
            expect(geometry.validateArchitecture(unit.architecture)).toEqual([]);
            expect(unit.architecture.openings.some(opening => opening.room === 'apartment')).toBe(true);
            expect(unit.architecture.openings.some(opening => opening.kind === 'window')).toBe(true);
            const point = geometry.registrationToLngLat(plans)(...unit.entryUv), [a, b, , d] = unit.registration.corners;
            const x = b.map((n, i) => n - a[i]), y = d.map((n, i) => n - a[i]), delta = point.map((n, i) => n - a[i]), determinant = x[0] * y[1] - x[1] * y[0];
            const u = (delta[0] * y[1] - delta[1] * y[0]) / determinant, v = (x[0] * delta[1] - x[1] * delta[0]) / determinant;
            const nav = navigation.buildNavigation(unit.architecture);
            expect(nav.canWalk([u * unit.architecture.dimensionsM[0], (1 - v) * unit.architecture.dimensionsM[1]])).toBe(true);
        }
        expect(footprint.properties).toEqual({});
    });
});
