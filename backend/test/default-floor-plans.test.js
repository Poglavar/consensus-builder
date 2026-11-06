// The suggested default layout generator: regulation-sized core per region, two apartments per core
// with rooms, windows only on facades that are free, more cores for large floors, balconies, shops on
// an active ground floor, a garage level, and a flag when nothing fits.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const plans = require('../../frontend/js/building-floor-plans.js');
const rooms = require('../../frontend/js/default-floor-plan-rooms.js');
const generator = require('../../frontend/js/default-floor-plans.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
const latOf = y => LAT + y / M_PER_DEG, lngOf = x => LNG + x / MX;
const rectangle = (cx, cy, w, h) => turf.polygon([[[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]].map(lngLat)]);
const southEdge = (cx, cy, w, h) => ({ a: lngLat([cx - w / 2, cy - h / 2]), b: lngLat([cx + w / 2, cy - h / 2]), basis: 'street' });
// Croatian rules and no garage unless a test asks for them, so the numbers stay those of the writeup.
const plan = (input, rules = {}) => generator.planDefaultFloorPlans(input, { turf, rooms, rules: { region: 'HR', garage: 'never', ...rules }, validate: plans.validateFloorPlans });
const layoutOf = (result, index) => result.floorPlans.layouts[index].architecture;
const openingsOf = (result, layoutIndex, kind, room) => layoutOf(result, layoutIndex).openings.filter(o => o.kind === kind && (room === undefined || o.room === room));
const everyPoint = architecture => [...architecture.walls, ...architecture.slabs, ...architecture.landings].flatMap(polygon => polygon.flatMap(ring => ring))
    .concat(architecture.openings.flatMap(o => [o.a, o.b, ...(o.hinge ? [o.hinge, o.openTip] : [])]), architecture.stairs.flatMap(s => [s.a, s.b]), architecture.railings.flatMap(r => [r.a, r.b]));
// Model coordinates back on the ground, through the same registration the renderer uses.
const groundOf = result => { const map = plans.registrationToLngLat(result.floorPlans); return p => map(p[0], p[1]); };
const metresBetween = (result, a, b) => { const g = groundOf(result); return turf.distance(g(a), g(b), { units: 'meters' }); };

describe('default floor plan generator', () => {
    const house = () => plan({ footprint: rectangle(0, 0, 20, 12), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12), buildingId: 'b1' });

    it('lays out one lift core and two apartments with rooms on a 20 × 12 m, four-storey building', () => {
        const result = house();
        expect(result.warnings).toEqual([]);
        expect(result.summary).toMatchObject({ cores: 1, apartmentsPerFloor: 2, lift: true, highRise: false, frontBasis: 'street', heightM: 12, region: 'HR', groundFloorUse: 'residential', garageLevels: 0 });
        expect(result.summary.coreM).toEqual([4.6, 5.87]);
        // Inner area 19.4 × 11.4 minus the core and the dividing wall, shared by two apartments.
        result.summary.apartmentAreasM2.forEach(area => expect(area).toBeGreaterThan(94));
        result.summary.apartmentAreasM2.forEach(area => expect(area).toBeLessThan(100));
        const { floorPlans } = result;
        expect(plans.validateFloorPlans(floorPlans)).toEqual([]);
        expect(floorPlans.suggested).toBe(true);
        expect(floorPlans.layouts.map(layout => layout.source.kind)).toEqual(['generated', 'generated']);
        expect(floorPlans.layouts[0].source.generator).toBe(generator.GENERATOR_ID);
        expect(floorPlans.storeys.map(floor => floor.elevationM)).toEqual([0, 3, 6, 9]);
        expect(floorPlans.storeys.map(floor => floor.layoutId)).toEqual(['b1:default-ground', 'b1:default-typical', 'b1:default-typical', 'b1:default-typical']);
        expect(floorPlans.registration.accuracy).toBe('generated');
        // Each apartment has a living room, a bedroom, a bathroom and a hall, and the partitions are real walls.
        const apartment = floorPlans.storeys[2].units[0];
        expect(apartment.rooms.map(room => room.kind)).toEqual(expect.arrayContaining(['living', 'bedroom', 'bathroom', 'hall']));
        expect(result.summary.rooms).toBeGreaterThanOrEqual(8);
        const bare = plan({ footprint: rectangle(0, 0, 20, 12), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12) }, { balconies: false });
        expect(layoutOf(result, 1).walls.length).toBeGreaterThan(0);
        expect(layoutOf(result, 1).openings.filter(o => o.kind === 'door').length).toBeGreaterThan(layoutOf(bare, 1).openings.filter(o => o.kind === 'door' && o.room === 'apartment').length);
    });

    it('keeps every solid inside the registration frame, which carries a balcony margin', () => {
        const result = house();
        for (const layout of result.floorPlans.layouts) {
            const outside = everyPoint(layout.architecture).filter(p => p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1);
            expect(outside).toEqual([]);
        }
        expect(layoutOf(result, 0).dimensionsM).toEqual([23.4, 15.4]);
    });

    it('puts the entrance door in the front facade on the ground floor only, lift and apartment doors on every floor, and interior doors into rooms', () => {
        const result = house();
        const entrance = openingsOf(result, 0, 'glazedDoor', 'entrance');
        expect(entrance).toHaveLength(1);
        expect(openingsOf(result, 1, 'glazedDoor', 'entrance')).toHaveLength(0);
        // The south facade is at y = -6; the door sits mid-wall at y = -5.85, centred on the building.
        const ground = groundOf(result);
        expect(ground(entrance[0].a)[1]).toBeCloseTo(latOf(-5.85), 7);
        expect((ground(entrance[0].a)[0] + ground(entrance[0].b)[0]) / 2).toBeCloseTo(lngOf(0), 7);
        expect(openingsOf(result, 1, 'slidingDoor', 'lift')).toHaveLength(1);
        expect(openingsOf(result, 1, 'door', 'apartment')).toHaveLength(2);
        openingsOf(result, 1, 'door', 'apartment').forEach(door => {
            expect(door.hinge).toBeDefined();
            expect(metresBetween(result, door.hinge, door.openTip)).toBeCloseTo(1.1, 1);
        });
        const interior = layoutOf(result, 1).openings.filter(o => o.kind === 'door' && !['apartment', 'lift', 'entrance'].includes(o.room));
        expect(interior.length).toBeGreaterThanOrEqual(6);
        interior.forEach(door => expect(metresBetween(result, door.a, door.b)).toBeCloseTo(0.8, 1));
    });

    it('divides the storey into regulation risers shared by two flights that meet at a half landing', () => {
        const hr = generator.rulesFor({ region: 'HR' }), generic = generator.rulesFor();
        expect(generator.stairRun(3, hr)).toMatchObject({ risers: 20, flights: [10, 10] });
        expect(generator.stairRun(3, hr).runM).toBeCloseTo(2.97, 6);
        expect(generator.stairRun(3.3, hr).risers).toBe(22);
        expect(generator.stairRun(3, generic)).toMatchObject({ risers: 18, flights: [9, 9] });
        const stairs = layoutOf(house(), 1).stairs;
        expect(stairs.map(s => [s.steps, s.fromM, s.toM])).toEqual([[10, 0, 1.5], [10, 1.5, 3]]);
        stairs.forEach(s => expect(s.widthM).toBe(1.1));
        expect(layoutOf(house(), 1).landings).toHaveLength(1);
        // Typical floors open a stairwell in the slab; the ground slab stays whole.
        expect(layoutOf(house(), 1).slabs[0]).toHaveLength(2);
        expect(layoutOf(house(), 0).slabs[0]).toHaveLength(1);
    });

    it('applies the generic preset where no local regulation is configured', () => {
        const result = generator.planDefaultFloorPlans({ footprint: rectangle(0, 0, 20, 12), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12) }, { turf, rooms, rules: { garage: 'never' }, validate: plans.validateFloorPlans });
        expect(result.summary.region).toBe('generic');
        expect(result.summary.coreM).toEqual([4.8, 5.22]); // 1.20 m flights, 170 mm risers, 290 mm treads
        expect(result.floorPlans.generator.parameters.region).toBe('generic');
        expect(generator.rulesFor({ region: 'xx' }).region).toBe('generic');
        expect(generator.rulesFor({ rules: { region: 'hr' } }).maxRiserM).toBe(0.15);
    });

    it('gives every room a window on a free facade, none on party walls, and a balcony to the living room', () => {
        const free = house();
        const windows = openingsOf(free, 1, 'window');
        expect(windows.length).toBeGreaterThan(6);
        windows.forEach(window => expect(window.depthM).toBe(0.3));
        expect(windows.map(window => window.room)).toEqual(expect.arrayContaining(['bedroom', 'living']));
        const balconyDoors = openingsOf(free, 1, 'glazedDoor', 'living');
        expect(balconyDoors).toHaveLength(2);
        expect(layoutOf(free, 1).slabs.length).toBe(3); // the floor slab and two balcony slabs
        expect(layoutOf(free, 1).railings.length).toBe(6);
        // The balcony never sits on the entrance facade (south, y = -6); here the sunnier gable ends win.
        const ground = groundOf(free);
        balconyDoors.forEach(door => expect(ground(door.a)[1]).toBeGreaterThan(latOf(-5)));
        expect(openingsOf(free, 0, 'glazedDoor', 'living')).toHaveLength(0); // no balconies on the ground floor

        const terraced = plan({ footprint: rectangle(0, 0, 12, 14), floors: 5, storeyHeightM: 3, front: southEdge(0, 0, 12, 14),
            neighbours: [rectangle(-12, 0, 12, 14), rectangle(12, 0, 12, 14)] });
        expect(terraced.warnings).toEqual([]);
        const terracedWindows = openingsOf(terraced, 1, 'window');
        expect(terracedWindows.length).toBeGreaterThan(0);
        // Only the front (south) and the back (north) carry windows; the party walls at the sides stay blind.
        const g = groundOf(terraced);
        terracedWindows.forEach(window => expect(Math.abs(g(window.a)[1] - g(window.b)[1])).toBeLessThan(1e-9));
    });

    it('keeps a facade near the parcel boundary blind when told so', () => {
        const footprint = rectangle(0, 0, 20, 12);
        const east = { a: lngLat([10, -6]), b: lngLat([10, 6]) };
        const open = plan({ footprint, floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12) });
        const blind = plan({ footprint, floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12), blindEdges: [east] });
        const eastOpenings = result => layoutOf(result, 1).openings.filter(o => ['window', 'glazedDoor'].includes(o.kind) && Math.abs(groundOf(result)(o.a)[0] - lngOf(9.85)) < 1e-8);
        expect(eastOpenings(open).length).toBeGreaterThan(0);
        expect(eastOpenings(blind)).toEqual([]);
    });

    it('keeps openings off the stretch of a facade a neighbour stands against, and on the rest of it', () => {
        // A neighbour covers the western 8 m of the 20 m back (north) facade; the facade's midpoint stays free.
        const result = plan({ footprint: rectangle(0, 0, 20, 12), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 20, 12),
            neighbours: [rectangle(-6, 11, 8, 10)] });
        const g = groundOf(result);
        for (const index of [0, 1]) {
            const back = layoutOf(result, index).openings.filter(o => ['window', 'glazedDoor'].includes(o.kind) && Math.abs(g(o.a)[1] - latOf(5.85)) < 1e-8);
            expect(back.length).toBeGreaterThan(0);
            // Nothing west of the neighbour's corner (x = -2) plus the blind clearance beside it.
            back.forEach(o => expect(Math.min(g(o.a)[0], g(o.b)[0])).toBeGreaterThan(lngOf(-1.75)));
        }
        // Without the neighbour, the same facade carries openings west of x = -2.
        const open = house();
        const westBack = layoutOf(open, 1).openings.filter(o => o.kind === 'window' && Math.abs(groundOf(open)(o.a)[1] - latOf(5.85)) < 1e-8 && groundOf(open)(o.a)[0] < lngOf(-2));
        expect(westBack.length).toBeGreaterThan(0);
    });

    it('cuts a facade run around the stretches neighbours stand against', () => {
        const facade = { partyRuns: [[2, 5], [9, 9.5]] };
        expect(rooms.freeRuns(facade, [0, 12])).toEqual([[0, 1.7], [5.3, 8.7], [9.8, 12]]);
        expect(rooms.freeRuns(facade, [0, 12], 2)).toEqual([[5.3, 8.7], [9.8, 12]]);
        expect(rooms.freeRuns({ partyRuns: [[0, 12]] }, [1, 11])).toEqual([]);
        expect(rooms.freeRuns({}, [1, 4])).toEqual([[1, 4]]);
    });

    it('flags a footprint that cannot hold the minimum core instead of inventing one', () => {
        const result = plan({ footprint: rectangle(0, 0, 6, 5), floors: 3, storeyHeightM: 3 });
        expect(result.floorPlans).toBeNull();
        expect(result.warnings.map(w => [w.code, w.severity])).toContainEqual(['core-does-not-fit', 'error']);
        expect(result.warnings.find(w => w.code === 'core-does-not-fit').message).toMatch(/Too small to fit a minimum stair core of 2\.85 × 5\.87 m/);
    });

    it('adds a core per 240 m² of usable floor and separates the segments', () => {
        const result = plan({ footprint: rectangle(0, 0, 60, 14), floors: 5, storeyHeightM: 3.3, front: southEdge(0, 0, 60, 14) });
        expect(result.warnings).toEqual([]);
        expect(result.summary).toMatchObject({ cores: 4, apartmentsPerFloor: 8, lift: true });
        expect(openingsOf(result, 0, 'glazedDoor', 'entrance')).toHaveLength(4);
        expect(layoutOf(result, 1).stairs).toHaveLength(8);
        expect(result.floorPlans.storeys[0].units.filter(unit => unit.kind === 'apartment').map(apartment => apartment.id)).toEqual(
            ['core-1-left-0', 'core-1-right-0', 'core-2-left-0', 'core-2-right-0', 'core-3-left-0', 'core-3-right-0', 'core-4-left-0', 'core-4-right-0']);
        result.summary.apartmentAreasM2.forEach(area => expect(area).toBeLessThan(120));
    });

    it('enters a jogged slab from each part of its street facade, with the entrance on the facade it abuts', () => {
        // Two 30 × 12 m halves offset by 3 m: the front facade is two parallel edges at y = 0 and y = 3.
        const jog = turf.polygon([[[0, 0], [30, 0], [30, 3], [60, 3], [60, 15], [30, 15], [30, 12], [0, 12], [0, 0]].map(lngLat)]);
        const result = plan({ footprint: jog, floors: 6, storeyHeightM: 3, front: { a: lngLat([0, 0]), b: lngLat([30, 0]), basis: 'street' } });
        expect(result.warnings).toEqual([]);
        expect(result.summary).toMatchObject({ cores: 3, apartmentsPerFloor: 6 });
        const entrances = openingsOf(result, 0, 'glazedDoor', 'entrance');
        expect(entrances).toHaveLength(3);
        const ground = groundOf(result);
        const facadeLines = [...new Set(entrances.map(door => Math.round((ground(door.a)[1] - LAT) * M_PER_DEG * 100) / 100))].sort((a, b) => a - b);
        expect(facadeLines).toEqual([0.15, 3.15]); // the two building lines, each mid-wall
    });

    it('spreads cores along the facade when stair bump-outs extend past it, and caps cores by frontage', () => {
        // A 60 × 20 m slab whose end bays protrude 7 m past the street facade on both sides.
        const slab = turf.polygon([[[-7, 2], [0, 2], [0, 0], [60, 0], [60, 2], [67, 2], [67, 20], [-7, 20], [-7, 2]].map(lngLat)]);
        // Tiny apartments would ask for twelve cores; the 74 m of street-facing facade holds six.
        // The slab is deep enough for a corridor; the design asks for point access.
        const result = plan({ footprint: slab, floors: 9, storeyHeightM: 3, front: { a: lngLat([0, 0]), b: lngLat([60, 0]), basis: 'street' } }, { maxApartmentM2: 60, access: 'point' });
        expect(result.floorPlans).not.toBeNull();
        expect(result.warnings.map(w => w.code)).toContain('cores-limited-by-frontage');
        expect(result.warnings.map(w => w.code)).toContain('deep-floor-plate');
        expect(result.summary.cores).toBe(6);
        const entrances = openingsOf(result, 0, 'glazedDoor', 'entrance');
        expect(entrances).toHaveLength(6);
        const ground = groundOf(result);
        // Every entrance sits mid-wall on a south-facing facade: the main one at y = 0 or a bump-out at y = 2.
        entrances.forEach(door => expect([0.15, 2.15]).toContainEqual(Math.round((ground(door.a)[1] - LAT) * M_PER_DEG * 100) / 100));
        const centres = entrances.map(door => ((ground(door.a)[0] + ground(door.b)[0]) / 2 - LNG) * MX).sort((a, b) => a - b);
        expect(centres[0]).toBeLessThan(0);   // the western bump-out carries a core
        expect(centres[5]).toBeGreaterThan(60); // and so does the eastern one
        expect(centres.slice(1).every((u, i) => u - centres[i] > 4.6 + 1)).toBe(true); // a metre of wall between cores
    });

    it('omits the lift below the storey and apartment thresholds, and obeys the lift policy', () => {
        const walkUp = plan({ footprint: rectangle(0, 0, 12, 10), floors: 2, storeyHeightM: 3 });
        expect(walkUp.summary).toMatchObject({ lift: false, cores: 1, apartmentsPerFloor: 2 });
        expect(walkUp.summary.coreM[0]).toBe(2.85);
        expect(openingsOf(walkUp, 1, 'slidingDoor')).toHaveLength(0);
        expect(layoutOf(walkUp, 1).railings.length).toBeGreaterThanOrEqual(3); // the open well's balustrade, plus balconies
        const forced = plan({ footprint: rectangle(0, 0, 12, 10), floors: 2, storeyHeightM: 3 }, { liftPolicy: 'always' });
        expect(forced.summary.lift).toBe(true);
        expect(openingsOf(forced, 1, 'slidingDoor')).toHaveLength(1);
        const rules = generator.rulesFor({ region: 'HR' });
        expect(generator.wantsLift(rules, 3, 2)).toBe(true); // 3 floors × 2 cores × 2 = 12 apartments
        expect(generator.wantsLift(rules, 3, 1)).toBe(false);
        expect(generator.wantsLift({ ...rules, liftPolicy: 'never' }, 3, 1, true)).toBe(true); // a high-rise always has one
    });

    it('treats a building whose top floor lies above 22 m as a high-rise with a fire lobby and a lift', () => {
        const tower = plan({ footprint: rectangle(0, 0, 24, 18), floors: 10, storeyHeightM: 3, front: southEdge(0, 0, 24, 18) }, { access: 'point' });
        expect(tower.summary.highRise).toBe(true);
        expect(tower.summary.lift).toBe(true);
        expect(tower.warnings.map(w => w.code)).toContain('high-rise');
        expect(tower.summary.coreM).toEqual([4.6, 7.37]); // 1.5 m lobby in front of the flights
        const low = plan({ footprint: rectangle(0, 0, 24, 18), floors: 8, storeyHeightM: 3, front: southEdge(0, 0, 24, 18) }, { access: 'point' });
        expect(low.summary.highRise).toBe(false); // top floor at 21 m
        expect(generator.coreDimensions(3, generator.rulesFor({ region: 'HR' }), true, true).landingM).toBe(3);
    });

    it('turns the ground floor of a tall block-rule building into shops, keeping the residential entrance', () => {
        const block = plan({ footprint: rectangle(0, 0, 30, 14), floors: 6, storeyHeightM: 3, front: southEdge(0, 0, 30, 14), typology: 'block' });
        // 30 × 14 m asks for two cores, so two shops per core on the ground floor and four apartments above.
        expect(block.summary.groundFloorUse).toBe('commercial');
        expect(block.summary.shopsOnGround).toBe(4);
        expect(block.floorPlans.storeys[0].units.map(unit => unit.kind)).toEqual(['shop', 'shop', 'shop', 'shop']);
        expect(block.floorPlans.storeys[1].units.filter(unit => unit.kind === 'apartment')).toHaveLength(4);
        const storefront = openingsOf(block, 0, 'window', 'shop');
        expect(storefront.length).toBeGreaterThan(0);
        storefront.forEach(window => expect(window).toMatchObject({ sillM: 0.4, heightM: 2.2 }));
        expect(openingsOf(block, 0, 'glazedDoor', 'entrance')).toHaveLength(2);
        expect(openingsOf(block, 0, 'glazedDoor', 'shop')).toHaveLength(4);
        const houseRule = plan({ footprint: rectangle(0, 0, 30, 14), floors: 6, storeyHeightM: 3, front: southEdge(0, 0, 30, 14), typology: 'parcel' });
        expect(houseRule.summary.groundFloorUse).toBe('residential');
        expect(plan({ footprint: rectangle(0, 0, 30, 14), floors: 3, storeyHeightM: 3, typology: 'parcel' }, { groundFloorUse: 'commercial' }).summary.shopsOnGround).toBe(4);
    });

    it('adds a garage level with columns and a ramp that surfaces through the ground slab', () => {
        const result = plan({ footprint: rectangle(0, 0, 40, 24), floors: 5, storeyHeightM: 3, front: southEdge(0, 0, 40, 24) }, { garage: 'auto' });
        expect(result.summary.garageLevels).toBe(1);
        expect(result.floorPlans.storeys[0]).toMatchObject({ level: -1, elevationM: -3, layoutId: 'building:default-garage' });
        expect(result.floorPlans.storeys[0].units.map(unit => unit.kind)).toEqual(['garage']);
        const garage = result.floorPlans.layouts.find(layout => layout.id.endsWith('default-garage')).architecture;
        expect(garage.platforms.length).toBe(10);
        garage.platforms.forEach(platform => { expect(platform.elevationM).toBeGreaterThan(0); expect(platform.elevationM).toBeLessThan(3); });
        expect(garage.walls.length).toBeGreaterThan(layoutOf(result, 1).walls.length - layoutOf(result, 1).openings.length); // columns
        expect(layoutOf(result, 0).slabs[0]).toHaveLength(2); // the ramp opening in the ground slab
        expect(result.warnings.map(w => w.code)).not.toContain('garage-ramp-steep');
        const shallow = plan({ footprint: rectangle(0, 0, 40, 12), floors: 5, storeyHeightM: 3, front: southEdge(0, 0, 40, 12) }, { garage: 'always' });
        expect(shallow.warnings.map(w => w.code)).toContain('garage-ramp-omitted');
        expect(shallow.floorPlans.layouts.find(layout => layout.id.endsWith('default-garage')).architecture.platforms).toBeUndefined();
        expect(plan({ footprint: rectangle(0, 0, 40, 24), floors: 3, storeyHeightM: 3 }, { garage: 'auto' }).summary.garageLevels).toBe(0);
    });

    it('falls back to the longest facade when the front is unknown or a party wall, and says so', () => {
        const unknown = plan({ footprint: rectangle(0, 0, 20, 12), floors: 3, storeyHeightM: 3 });
        expect(unknown.summary.frontBasis).toBe('longest');
        expect(unknown.warnings.map(w => w.code)).toEqual(['front-assumed-longest']);
        expect(unknown.summary.frontEdge.lengthM).toBeCloseTo(20, 3);
        const blocked = plan({ footprint: rectangle(0, 0, 20, 12), floors: 3, storeyHeightM: 3, front: southEdge(0, 0, 20, 12), neighbours: [rectangle(0, -12, 20, 12)] });
        expect(blocked.warnings.map(w => w.code)).toContain('front-is-party-wall');
        expect(blocked.summary.frontEdge.lengthM).toBeCloseTo(20, 3); // the opposite long facade
        expect(blocked.summary.frontEdge.a[1]).toBeGreaterThan(LAT);
    });

    it('is deterministic and refuses unknown storeys or implausible heights', () => {
        expect(JSON.stringify(house().floorPlans)).toBe(JSON.stringify(house().floorPlans));
        expect(plan({ footprint: rectangle(0, 0, 20, 12) }).warnings.map(w => w.code)).toEqual(['floors-unknown']);
        expect(plan({ footprint: rectangle(0, 0, 20, 12), floors: 3, storeyHeightM: 1.9 }).warnings.map(w => w.code)).toEqual(['storey-height-implausible']);
        expect(plan({ footprint: { type: 'Feature', geometry: { type: 'Point', coordinates: [16, 45.8] } }, floors: 3 }).warnings.map(w => w.code)).toEqual(['invalid-footprint']);
    });

    it('lays out only the largest part of a multi-part footprint and notes it', () => {
        const multi = turf.multiPolygon([rectangle(0, 0, 20, 12).geometry.coordinates, rectangle(40, 0, 4, 4).geometry.coordinates]);
        const result = plan({ footprint: multi, floors: 3, storeyHeightM: 3, front: southEdge(0, 0, 20, 12) });
        expect(result.floorPlans).not.toBeNull();
        expect(result.warnings.map(w => w.code)).toEqual(['multipolygon-largest-part']);
        expect(layoutOf(result, 0).dimensionsM).toEqual([23.4, 15.4]);
    });
});

describe('double-loaded corridor access', () => {
    const toM = ([lng, lat]) => [(lng - LNG) * MX, (lat - LAT) * M_PER_DEG];
    // A w × h rectangle about the origin turned counter-clockwise by deg, in WGS84.
    const turned = (w, h, deg) => {
        const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [x * c - y * s, x * s + y * c]);
        return { footprint: turf.polygon([[...corners, corners[0]].map(lngLat)]), edge: (i, basis = 'street') => ({ a: lngLat(corners[i]), b: lngLat(corners[(i + 1) % 4]), basis }) };
    };
    const segmentDistance = (p, a, b) => {
        const d = [b[0] - a[0], b[1] - a[1]], len2 = d[0] ** 2 + d[1] ** 2;
        const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2));
        return Math.hypot(p[0] - a[0] - k * d[0], p[1] - a[1] - k * d[1]);
    };
    // Points every quarter metre along a ring's edges, in metres.
    const along = ring => ring.slice(1).flatMap((q, i) => {
        const p = toM(ring[i]), r = toM(q), n = Math.max(1, Math.ceil(Math.hypot(r[0] - p[0], r[1] - p[1]) / 0.25));
        return Array.from({ length: n + 1 }, (_, k) => [p[0] + (r[0] - p[0]) * k / n, p[1] + (r[1] - p[1]) * k / n]);
    });
    const typeOf = type => generator.CORRIDOR_MIX.find(m => m.type === type);

    // Podbrežje A4 (backend/test/fixtures): the 2nd-floor plan's frame is 105.7 × 19.0 m, its long
    // axis 91° from east; the building is P+8, and its published 2nd floor has 13 flats.
    const a4Plan = JSON.parse(readFileSync(new URL('./fixtures/podbrezje-a4-published-floor-plans.json', import.meta.url), 'utf8')).plans.find(p => p.externalId === 'podbrezje-a4-floor-2');
    const [a4Length, a4Depth] = a4Plan.architecture.dimensionsM;
    const a4 = turned(a4Length, a4Depth, a4Plan.placement.priors.rotationDeg);
    const podbrezjeA4 = () => plan({ footprint: a4.footprint, floors: 9, storeyHeightM: 2.9, front: a4.edge(0), buildingId: 'a4' });

    it('chooses a corridor once the floor plate is 15 m deep inside its walls, point cores below', () => {
        const deepSlab = depth => plan({ footprint: rectangle(0, 0, 60, depth), floors: 5, storeyHeightM: 3, front: southEdge(0, 0, 60, depth) });
        expect(deepSlab(12).summary).toMatchObject({ access: 'point', accessBasis: 'depth', plateDepthM: 11.4 });
        const deep = deepSlab(18.7);
        expect(deep.summary).toMatchObject({ access: 'corridor', accessBasis: 'depth', plateDepthM: 18.1 });
        expect(deepSlab(15.6).summary.access).toBe('corridor'); // 15.0 m inside the walls
        expect(deepSlab(15.5).summary.access).toBe('point');
        expect(deep.floorPlans.notes.join(' ')).toMatch(/Corridor access: the floor plate is 18\.1 m deep inside its walls \(at least 15 m\)/);
        expect(deep.floorPlans.layouts[1].source.parameters).toMatchObject({ access: 'corridor', accessBasis: 'depth', plateDepthM: 18.1 });
        expect(generator.decideAccess(generator.rulesFor({ rules: { corridorFromDepthM: 20 } }), 18.1)).toMatchObject({ access: 'point', basis: 'depth' });
        // A very deep plate still gets its corridor, and is told its rows are deep.
        expect(deep.warnings.map(w => w.code)).not.toContain('deep-corridor-rows');
        const veryDeep = deepSlab(30);
        expect(veryDeep.summary.access).toBe('corridor');
        expect(veryDeep.warnings.map(w => w.code)).toContain('deep-corridor-rows');
    });

    it('takes the access a design or the view states over the depth rule, and falls back to point cores where a corridor cannot fit', () => {
        const footprint = rectangle(0, 0, 60, 18.7), front = southEdge(0, 0, 60, 18.7);
        const stated = plan({ footprint, floors: 5, storeyHeightM: 3, front }, { access: 'point', accessBasis: 'design' });
        expect(stated.summary).toMatchObject({ access: 'point', accessBasis: 'design', cores: expect.any(Number) });
        expect(stated.summary.corridor).toBeUndefined();
        expect(stated.floorPlans.notes.join(' ')).toMatch(/Point access, as the design states/);
        const viewed = plan({ footprint: rectangle(0, 0, 40, 16), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 40, 16) }, { access: 'corridor', accessBasis: 'view' });
        expect(viewed.summary).toMatchObject({ access: 'corridor', accessBasis: 'view' });
        const shallow = plan({ footprint: rectangle(0, 0, 40, 12), floors: 4, storeyHeightM: 3, front: southEdge(0, 0, 40, 12) }, { access: 'corridor' });
        expect(shallow.summary).toMatchObject({ access: 'point', accessBasis: 'design', accessFallback: 'corridor-too-shallow' });
        expect(shallow.warnings.map(w => w.code)).toContain('corridor-too-shallow');
        expect(shallow.floorPlans).not.toBeNull();
    });

    it('serves a slab the size of Podbrežje A4 from a corridor, every flat on a facade and on the corridor, none overlapping', () => {
        const result = podbrezjeA4();
        const { summary } = result;
        expect(summary).toMatchObject({ access: 'corridor', accessBasis: 'depth', lift: true });
        expect(summary.plateDepthM).toBeCloseTo(a4Depth - 0.6, 1);
        // The published floor has 13 flats in larger units; the default mix packs 26 into the same plate.
        expect(summary.apartmentsPerFloor).toBeGreaterThanOrEqual(10);
        expect(summary.apartmentsPerFloor).toBeLessThanOrEqual(30);
        expect(summary.flats).toHaveLength(summary.apartmentsPerFloor);
        const outline = turf.polygonToLine(a4.footprint);
        const spine = summary.corridor.spine.map(toM);
        const corridorReachM = summary.corridor.widthM / 2 + 0.2 + 0.05; // half the corridor, its wall, a tolerance
        for (const flat of summary.flats) {
            const ring = flat.rings[0];
            const facadeM = Math.min(...ring.map(p => turf.pointToLineDistance(turf.point(p), outline, { units: 'meters' })));
            expect(facadeM, `${flat.id} on a facade`).toBeLessThanOrEqual(0.3 + 0.05);
            expect(Math.min(...along(ring).map(p => segmentDistance(p, spine[0], spine[1]))), `${flat.id} on the corridor`).toBeLessThanOrEqual(corridorReachM);
        }
        for (let i = 0; i < summary.flats.length; i++) {
            for (let j = i + 1; j < summary.flats.length; j++) {
                const overlap = turf.intersect(turf.polygon([summary.flats[i].rings[0]]), turf.polygon([summary.flats[j].rings[0]]));
                expect(overlap ? turf.area(overlap) : 0, `${summary.flats[i].id} × ${summary.flats[j].id}`).toBeLessThan(0.05);
            }
        }
        // One entrance door from the corridor per flat, and a unit with rooms per flat on every storey above the ground.
        expect(openingsOf(result, 1, 'door', 'apartment')).toHaveLength(summary.flats.length);
        result.floorPlans.storeys.filter(storey => storey.level > 0).forEach(storey => expect(storey.units.map(unit => unit.type)).toEqual(summary.flats.map(flat => flat.type)));
    });

    it('keeps the corridor free of walls from end to end, with every stair on it, no dead end past 15 m and stairs at most 40 m apart', () => {
        const result = podbrezjeA4();
        const { corridor } = result.summary;
        const spine = corridor.spine.map(toM), stairs = corridor.stairCentres.map(toM);
        const lengthM = Math.hypot(spine[1][0] - spine[0][0], spine[1][1] - spine[0][1]);
        expect(lengthM).toBeCloseTo(corridor.lengthM, 1);
        const ground = groundOf(result);
        const walls = layoutOf(result, 1).walls.map(polygon => turf.polygon(polygon.map(ring => [...ring.map(p => ground(p)), ground(ring[0])])));
        for (let s = 0.1; s <= lengthM - 0.1; s += 0.25) {
            const p = [spine[0][0] + (spine[1][0] - spine[0][0]) * s / lengthM, spine[0][1] + (spine[1][1] - spine[0][1]) * s / lengthM];
            expect(walls.some(wall => turf.booleanPointInPolygon(turf.point(lngLat(p)), wall)), `wall across the corridor ${s.toFixed(2)} m along`).toBe(false);
        }
        const flights = layoutOf(result, 1).stairs.flatMap(flight => [flight.a, flight.b]).map(p => toM(ground(p)));
        expect(stairs.length).toBe(3); // 95 m of corridor: 2 × 15 m of dead end and one 40 m span leave a third stair
        for (const stair of stairs) {
            expect(segmentDistance(stair, spine[0], spine[1])).toBeLessThan(0.05);
            // The flights start behind the core's landing (3 m with the high-rise fire lobby), off the corridor's middle.
            expect(Math.min(...flights.map(p => Math.hypot(p[0] - stair[0], p[1] - stair[1])))).toBeLessThan(0.75 + 3.0 + 1.0);
        }
        const position = p => Math.hypot(p[0] - spine[0][0], p[1] - spine[0][1]);
        const positions = stairs.map(position).sort((a, b) => a - b);
        expect(positions[0]).toBeLessThanOrEqual(15 + 0.01);
        expect(lengthM - positions[positions.length - 1]).toBeLessThanOrEqual(15 + 0.01);
        positions.slice(1).forEach((p, i) => expect(p - positions[i]).toBeLessThanOrEqual(40));
        expect(corridor.deadEndM).toBeLessThanOrEqual(15);
        // Tighter egress limits ask for more stairs.
        expect(plan({ footprint: a4.footprint, floors: 9, storeyHeightM: 2.9, front: a4.edge(0) }, { maxDeadEndM: 8, maxStairSpacingM: 25 }).summary.cores).toBeGreaterThan(3);
    });

    it('honours the flat mix by count, with three-bed flats only at the gable ends', () => {
        const { summary } = podbrezjeA4();
        const counts = summary.corridor.mix, total = summary.flats.length;
        expect(counts['three-bed']).toBe(2);
        expect(summary.corridor.gables).toBe(2);
        for (const type of ['studio', 'one-bed', 'two-bed']) expect(Math.abs(counts[type] / total - typeOf(type).share), type).toBeLessThan(0.08);
        // Each flat's area stays near its type's range.
        for (const flat of summary.flats) {
            const [lo, hi] = typeOf(flat.type).areaM2;
            expect(flat.areaM2, `${flat.id} (${flat.type})`).toBeGreaterThan(0.85 * lo);
            expect(flat.areaM2, `${flat.id} (${flat.type})`).toBeLessThan(1.2 * hi);
        }
        // fillRows on its own: the counts fill the segments exactly and follow the shares.
        const rows = generator.fillRows([{ from: 0, to: 80 }, { from: 0, to: 80 }], generator.CORRIDOR_MIX.filter(m => !m.gable), 0.2);
        rows.forEach(row => {
            expect(row.flats[0].s0).toBe(0);
            expect(row.flats[row.flats.length - 1].s1).toBe(80);
            row.flats.slice(1).forEach((flat, i) => expect(flat.s0 - row.flats[i].s1).toBeCloseTo(0.2, 9));
        });
        const types = rows.flatMap(row => row.flats.map(flat => flat.entry.type));
        expect(types.filter(type => type === 'one-bed').length).toBeGreaterThan(types.filter(type => type === 'studio').length);
    });

    it('furnishes corridor flats from the corridor out, and wraps the gable flats round the corner', () => {
        const result = podbrezjeA4();
        const units = result.floorPlans.storeys.find(storey => storey.level === 2).units;
        const kinds = unit => unit.rooms.map(room => room.kind);
        for (const unit of units) {
            expect(kinds(unit), unit.id).toEqual(expect.arrayContaining(['hall', 'bathroom', 'living']));
            const bedrooms = kinds(unit).filter(kind => kind === 'bedroom').length;
            if (unit.type === 'studio') expect(bedrooms).toBe(0);
            else if (unit.type === 'three-bed') expect(bedrooms).toBeGreaterThanOrEqual(2);
            else expect(bedrooms, unit.id).toBeGreaterThanOrEqual(1);
        }
        // Every living room has daylight: a window or a balcony door of its own.
        const lit = layoutOf(result, 1).openings.filter(o => o.room === 'living' && (o.kind === 'window' || o.kind === 'glazedDoor'));
        expect(lit.length).toBeGreaterThanOrEqual(units.length);
        // A gable flat reaches three facades: its end wall and both long sides.
        const outline = turf.polygonToLine(a4.footprint);
        const gable = result.summary.flats.find(flat => flat.type === 'three-bed');
        const ring = gable.rings[0].slice(0, -1);
        const onFacade = ring.filter(p => turf.pointToLineDistance(turf.point(p), outline, { units: 'meters' }) < 0.35);
        expect(onFacade.length).toBeGreaterThanOrEqual(4);
    });

    it('puts the cores and studios on the north side of an east-west slab and flags the flats that face only north', () => {
        const ew = plan({ footprint: rectangle(0, 0, 106, 18.8), floors: 9, storeyHeightM: 2.9, front: southEdge(0, 0, 106, 18.8) });
        expect(ew.summary.corridor.coreSide).toBe('north');
        const centroidY = flat => turf.centroid(turf.polygon(flat.rings)).geometry.coordinates[1] - LAT;
        const ground = groundOf(ew);
        layoutOf(ew, 1).stairs.forEach(flight => expect(ground(flight.a)[1]).toBeGreaterThan(LAT));
        const studios = ew.summary.flats.filter(flat => flat.type === 'studio');
        expect(studios.length).toBeGreaterThan(0);
        expect(studios.filter(flat => centroidY(flat) > 0).length / studios.length).toBeGreaterThanOrEqual(0.8);
        // Exactly the north row's flats are flagged; the gable flats see three ways.
        const northRow = ew.summary.flats.filter(flat => flat.type !== 'three-bed' && centroidY(flat) > 0);
        expect(ew.summary.flats.filter(flat => flat.flag).map(flat => flat.id).sort()).toEqual(northRow.map(flat => flat.id).sort());
        expect(ew.summary.flaggedFlats).toBe(northRow.length);
        expect(ew.floorPlans.storeys.find(storey => storey.level === 3).units.filter(unit => unit.flag === 'north-single-aspect')).toHaveLength(northRow.length);
        expect(ew.floorPlans.notes.join(' ')).toMatch(new RegExp(`${northRow.length} flat\\(s\\) per storey face only north`));
        // Turned north-south, both long sides see east or west: no flat is flagged and the cores face the street.
        const ns = podbrezjeA4();
        expect(ns.summary.corridor.coreSide).toBe('street');
        expect(ns.summary.flaggedFlats).toBe(0);
    });
});

describe('generated layout sources in the shared validator', () => {
    const generated = () => plan({ footprint: rectangle(0, 0, 20, 12), floors: 2, storeyHeightM: 3, front: southEdge(0, 0, 20, 12) }).floorPlans;
    it('accepts a generated source only inside a suggested model', () => {
        const model = generated();
        expect(plans.validateFloorPlans(model)).toEqual([]);
        const notSuggested = { ...model, suggested: false };
        expect(plans.validateFloorPlans(notSuggested).join(' ')).toMatch(/generated layouts require floorPlans.suggested = true/);
    });
    it('requires the generator name and its parameters', () => {
        const model = generated();
        model.layouts[0].source = { kind: 'generated' };
        expect(plans.validateFloorPlans(model).join(' ')).toMatch(/source.generator: must name the generator.*source.parameters: must be an object/);
    });
});
