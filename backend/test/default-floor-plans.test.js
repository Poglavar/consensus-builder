// The suggested default layout generator: regulation-sized core per region, two apartments per core
// with rooms, windows only on facades that are free, more cores for large floors, balconies, shops on
// an active ground floor, a garage level, and a flag when nothing fits.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

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
        expect(floorPlans.floors.map(floor => floor.elevationM)).toEqual([0, 3, 6, 9]);
        expect(floorPlans.floors.map(floor => floor.layoutId)).toEqual(['b1:default-ground', 'b1:default-typical', 'b1:default-typical', 'b1:default-typical']);
        expect(floorPlans.registration.accuracy).toBe('generated');
        // Each apartment has a living room, a bedroom, a bathroom and a hall, and the partitions are real walls.
        const apartment = floorPlans.floors[2].apartments[0];
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
        expect(result.floorPlans.floors[0].apartments.map(apartment => apartment.id)).toEqual(
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
        const result = plan({ footprint: slab, floors: 9, storeyHeightM: 3, front: { a: lngLat([0, 0]), b: lngLat([60, 0]), basis: 'street' } }, { maxApartmentM2: 60 });
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
        const tower = plan({ footprint: rectangle(0, 0, 24, 18), floors: 10, storeyHeightM: 3, front: southEdge(0, 0, 24, 18) });
        expect(tower.summary.highRise).toBe(true);
        expect(tower.summary.lift).toBe(true);
        expect(tower.warnings.map(w => w.code)).toContain('high-rise');
        expect(tower.summary.coreM).toEqual([4.6, 7.37]); // 1.5 m lobby in front of the flights
        const low = plan({ footprint: rectangle(0, 0, 24, 18), floors: 8, storeyHeightM: 3, front: southEdge(0, 0, 24, 18) });
        expect(low.summary.highRise).toBe(false); // top floor at 21 m
        expect(generator.coreDimensions(3, generator.rulesFor({ region: 'HR' }), true, true).landingM).toBe(3);
    });

    it('turns the ground floor of a tall block-rule building into shops, keeping the residential entrance', () => {
        const block = plan({ footprint: rectangle(0, 0, 30, 14), floors: 6, storeyHeightM: 3, front: southEdge(0, 0, 30, 14), typology: 'block' });
        // 30 × 14 m asks for two cores, so two shops per core on the ground floor and four apartments above.
        expect(block.summary.groundFloorUse).toBe('commercial');
        expect(block.summary.shopsOnGround).toBe(4);
        expect(block.floorPlans.floors[0].apartments).toEqual([]);
        expect(block.floorPlans.floors[0].units.map(unit => unit.kind)).toEqual(['shop', 'shop', 'shop', 'shop']);
        expect(block.floorPlans.floors[1].apartments).toHaveLength(4);
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
        expect(result.floorPlans.floors[0]).toMatchObject({ level: -1, elevationM: -3, layoutId: 'building:default-garage', apartments: [] });
        expect(result.floorPlans.floors[0].units[0].kind).toBe('garage');
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
