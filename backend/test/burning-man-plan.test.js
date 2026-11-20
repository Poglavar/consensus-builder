// The Burning Man plan type (frontend/js/schelling/burning-man-plan.js): a city laid out as a clock
// face around the Man. Its rings, radials, blocks, plots and the streets proposed around painted
// blocks must agree with each other: blocks clear of street land, every block found again from a
// point inside it, junctions shared between the streets that meet there. And it has Angel's 30 m
// arterials about 1 km apart, as the meridian plan has: no block far from one.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Plan = require('../../frontend/js/schelling/burning-man-plan.js');
const Streets = require('../../frontend/js/schelling/schelling-streets.js');

const MAN = { lat: 40.786958, lng: -119.202994 };
const city = (options = {}) => Plan.planFor({ centre: MAN, ...Plan.DEFAULTS, ...options });

// Metres east and north of the Man, in the plan's own local plane.
const local = (plan, [lng, lat]) => [(lng - plan.centre.lng) * plan.metersPerDegree.lon, (lat - plan.centre.lat) * plan.metersPerDegree.lat];
const ringOf = feature => feature.geometry.coordinates[0];
function centroid(ring) {
    const points = ring.slice(0, -1);
    return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
}

describe('a Burning Man city', () => {
    it('rings the Man with the Esplanade and lettered streets, and its 12:00 points where it is told', () => {
        const plan = city();
        expect(plan.radii[0]).toBe(760);
        // Eleven blocks of 76 m, nine local rings of 12 m between them and the two 30 m arterials'
        // halves facing the city.
        expect(plan.outerRadiusM).toBe(760 + 11 * 76 + 10 * 12 + 15 + 15);
        expect(Plan.describe(plan)).toMatchObject({ lastRing: 'K', blocks: 208, quarterHoursFrom: 'I', blockDepthM: 76 });
        const lines = Plan.centreLines(plan);
        expect(lines.filter(line => line.properties.kind === 'ring').map(line => line.properties.name))
            .toEqual(['Esplanade', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
        // 6:00 runs south of the Man when 12:00 is north, and west of him when 12:00 is east.
        const sixOf = p => Plan.centreLines(p).find(line => line.properties.name === '6:00').geometry.coordinates[1];
        const [x0, y0] = local(plan, sixOf(plan));
        expect(Math.abs(x0)).toBeLessThan(1e-6);
        expect(y0).toBeCloseTo(-plan.outerRadiusM, 3);
        const turned = city({ bearingDeg: 90 });
        const [x1, y1] = local(turned, sixOf(turned));
        expect(x1).toBeCloseTo(-turned.outerRadiusM, 3);
        expect(Math.abs(y1)).toBeLessThan(1e-6);
    });

    it('adds quarter-hour streets where blocks have grown to twice their Esplanade length', () => {
        const plan = city();
        const firstQuarter = plan.levels.indexOf(1);
        expect(plan.radii[firstQuarter]).toBeGreaterThanOrEqual(2 * plan.radii[0]);
        expect(plan.radii[firstQuarter - 1]).toBeLessThan(2 * plan.radii[0]);
        const radials = Plan.centreLines(plan).filter(line => line.properties.kind === 'radial');
        expect(radials).toHaveLength(17 + 16);
        const quarter = radials.find(line => line.properties.name === '2:15');
        expect(Math.hypot(...local(plan, quarter.geometry.coordinates[0]))).toBeCloseTo(plan.radii[firstQuarter], 6);
        // A small city never reaches twice its Esplanade: half hours only.
        expect(Plan.centreLines(city({ rings: 3 })).filter(line => line.properties.kind === 'radial')).toHaveLength(17);
    });

    it('has 30 m arterials about 1 km apart: the Esplanade, every ring nearest 1 km out, and the radials nearest 1 km apart at the edge', () => {
        const plan = city();
        expect(Plan.describe(plan)).toMatchObject({
            arterialWidthM: 30, arterialRings: ['Esplanade', 'K'], arterialHours: 1,
            arterialRadials: ['2:00', '3:00', '4:00', '5:00', '6:00', '7:00', '8:00', '9:00', '10:00']
        });
        // The arterial rings are as near 1 km apart as whole rings allow, and so are the radials at the edge.
        expect(plan.radii[11] - plan.radii[0]).toBeGreaterThan(900);
        expect(plan.radii[11] - plan.radii[0]).toBeLessThan(1100);
        expect(plan.outerRadiusM * Math.PI / 6).toBeGreaterThan(900);
        const streets = Plan.streetsOf(plan, Plan.cellsInBbox(plan, [-180, -85, 180, 85]));
        expect(new Set(streets.filter(s => s.roadClass === 'arterial').map(s => s.name)))
            .toEqual(new Set(['Esplanade', 'K', '2:00', '3:00', '4:00', '5:00', '6:00', '7:00', '8:00', '9:00', '10:00']));
        expect(Plan.ringWidthM(plan, 0)).toBe(30);
        expect(Plan.ringWidthM(plan, 1)).toBe(12);
        // A bigger city takes more arterial rings and an arterial every half hour.
        const big = Plan.describe(city({ esplanadeM: 1500, rings: 12, blockDepthM: 200, streetWidthM: 20 }));
        expect(big).toMatchObject({ arterialRings: ['Esplanade', 'E', 'J'], arterialHours: 0.5 });
        expect(big.arterialRadials).toHaveLength(17);
        // A small one keeps the Esplanade, and radials at 2:00, 6:00 and 10:00.
        expect(Plan.describe(city({ esplanadeM: 300, rings: 4 }))).toMatchObject({ arterialRings: ['Esplanade'], arterialHours: 4, arterialRadials: ['2:00', '6:00', '10:00'] });
    });

    it('puts every block within a ten-minute walk of an arterial', () => {
        for (const plan of [city(), city({ esplanadeM: 1500, rings: 12, blockDepthM: 200, streetWidthM: 20 })]) {
            const arterials = Plan.centreLines(plan).filter(line => line.properties.roadClass === 'arterial')
                .map(line => line.geometry.coordinates.map(point => local(plan, point)));
            const distanceToLine = ([x, y], points) => Math.min(...points.slice(1).map((b, k) => {
                const a = points[k];
                const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
                const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
                return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
            }));
            let farthest = 0;
            for (const { i, j } of Plan.cellsInBbox(plan, [-180, -85, 180, 85])) {
                for (const point of ringOf(Plan.blockOf(plan, i, j))) {
                    farthest = Math.max(farthest, Math.min(...arterials.map(line => distanceToLine(local(plan, point), line))));
                }
            }
            expect(farthest).toBeLessThan(600);
        }
    });

    it('keeps every block clear of the street land around it, and as deep as asked', () => {
        const plan = city({ rings: 10, esplanadeM: 300, blockDepthM: 50, streetWidthM: 14 });
        const cells = Plan.cellsInBbox(plan, [-180, -85, 180, 85]);
        expect(cells.length).toBe(Plan.describe(plan).blocks);
        const streets = Plan.streetsOf(plan, cells);
        for (const { i, j } of cells) {
            const block = Plan.blockOf(plan, i, j);
            const inner = plan.radii[j] + Plan.ringWidthM(plan, j) / 2;
            const outer = plan.radii[j + 1] - Plan.ringWidthM(plan, j + 1) / 2;
            expect(outer - inner).toBeCloseTo(50, 9);
            for (const point of ringOf(block)) {
                const [x, y] = local(plan, point);
                const r = Math.hypot(x, y);
                expect(r).toBeGreaterThanOrEqual(inner - 1e-6);
                expect(r).toBeLessThanOrEqual(outer + 1e-6);
                // Never nearer a radial street's centre line than half that street.
                for (const street of streets.filter(s => s.axis === 'radial' && s.from <= j && s.to > j)) {
                    const bearing = (plan.bearingDeg + 60 + street.line * plan.unitDeg) * Math.PI / 180;
                    const across = Math.abs(x * Math.cos(bearing) - y * Math.sin(bearing));
                    const along = x * Math.sin(bearing) + y * Math.cos(bearing);
                    if (along > 0) expect(across).toBeGreaterThanOrEqual(Plan.radialWidthM(plan, street.line) / 2 - 1e-6);
                }
            }
        }
    });

    it('finds every block again from a point inside it, and nothing on the open playa', () => {
        const plan = city();
        for (const { i, j } of Plan.cellsInBbox(plan, [-180, -85, 180, 85])) {
            const [lng, lat] = centroid(ringOf(Plan.blockOf(plan, i, j)));
            expect(Plan.cellAt(plan, lat, lng)).toEqual({ i, j });
        }
        // 12:00 beyond the Esplanade is open playa; the Man himself is inside the Esplanade; 6:00
        // between A and B is a block.
        expect(Plan.cellAt(plan, MAN.lat + 1000 / plan.metersPerDegree.lat, MAN.lng)).toBeNull();
        expect(Plan.cellAt(plan, MAN.lat, MAN.lng)).toBeNull();
        expect(Plan.cellAt(plan, MAN.lat - 900 / plan.metersPerDegree.lat, MAN.lng)).toEqual({ i: 8, j: 1 });
    });

    it('starts the painting tool from the clock hour nearest the map centre', () => {
        const plan = city();
        // From the Man, the city's middle: 6:00 to 7:00, two half-hour blocks a ring and four beyond.
        const cells = Plan.defaultCells(plan, MAN.lat, MAN.lng);
        expect(cells).toHaveLength(9 * 2 + 2 * 4);
        expect(new Set(cells.map(({ i, j }) => Plan.blockOf(plan, i, j).properties.from.split(':')[0]))).toEqual(new Set(['6']));
        expect(cells.length).toBeLessThanOrEqual(64);
    });

    it('splits a block into two rows of plots that cover it', () => {
        const plan = city();
        const block = Plan.blockOf(plan, 3, 9);
        for (const level of [0, 3]) {
            const plots = Plan.plotsOfBlock(plan, 3, 9, level);
            expect(plots).toHaveLength(2 * 2 ** level);
            const area = plots.reduce((sum, plot) => sum + plot.properties.area_m2, 0);
            expect(Math.abs(area - block.properties.area_m2) / block.properties.area_m2).toBeLessThan(0.01);
        }
        expect(Plan.plotsOfBlock(plan, 3, 9, null)).toEqual([]);
        expect(Plan.plotSize(plan, 3).depthM).toBe(38);
        // The plot size quoted is of a block between two local radials, not one an arterial narrows.
        expect(Plan.plotSize(plan, 0).areaM2).toBe(Plan.plotsOfBlock(plan, 1, 0, 0)[0].properties.area_m2);
    });

    it('proposes the streets around chosen blocks with their junctions shared and their names', () => {
        const plan = city();
        const one = Plan.streetsOf(plan, [{ i: 3, j: 2 }]);
        expect(one.map(street => street.name).sort()).toEqual(['3:30', '4:00', 'B', 'C']);
        const cells = Plan.defaultCells(plan, MAN.lat, MAN.lng);
        const summary = Plan.summary(plan, cells);
        expect(summary).toMatchObject({ blocks: 26, roads: 1 });
        // The hour's two arterial radials and its stretch of the Esplanade and K.
        const hourArc = (plan.radii[0] + plan.radii[11]) * Math.PI / 6;
        expect(summary.lengthM.arterial).toBeCloseTo(2 * (plan.radii[11] - plan.radii[0]) + hourArc, 6);
        const { form, roads } = Plan.importForm(plan, cells, { laneTags: profile => ({ lanes: String(profile.strips.filter(s => s.type === 'driving').length) }) });
        expect(roads).toHaveLength(1);
        const ways = form.elements.filter(element => element.type === 'way');
        expect(ways).toHaveLength(summary.streets);
        // Every junction node is shared by a ring way and a radial way; arc vertices belong to one way.
        const uses = new Map();
        ways.forEach(way => way.nodes.forEach(id => uses.set(id, (uses.get(id) || new Set()).add(way.tags.name))));
        const radialNames = new Set(ways.filter(way => way.tags.name.includes(':')).map(way => way.tags.name));
        ways.filter(way => radialNames.has(way.tags.name)).forEach(way => way.nodes.forEach(id => expect(uses.get(id).size).toBe(2)));
        // Junctions sit on their ring.
        const nodes = new Map(form.elements.filter(element => element.type === 'node').map(node => [node.id, node]));
        const esplanadeWay = ways.find(way => way.tags.name === 'Esplanade');
        for (const id of esplanadeWay.nodes) {
            const node = nodes.get(id);
            expect(Math.hypot(...local(plan, [node.lon, node.lat]))).toBeCloseTo(plan.radii[0], 3);
        }
        // Arterials take the meridian plan's 30 m four-lane section, local streets their two lanes.
        const arterial = new Set(['Esplanade', 'K', '6:00', '7:00']);
        ways.forEach(way => expect([way.tags.name, way.tags.highway, way.tags.lanes])
            .toEqual(arterial.has(way.tags.name) ? [way.tags.name, 'primary', '4'] : [way.tags.name, 'residential', '2']));
    });

    it('draws a street polygon that covers its centre line', () => {
        const plan = city();
        const street = Plan.streetsOf(plan, [{ i: 0, j: 0 }]).find(s => s.axis === 'ring' && s.line === 0);
        const ring = Plan.streetPolygon(plan, street).coordinates[0];
        const radii = ring.map(point => Math.hypot(...local(plan, point)));
        expect(Math.min(...radii)).toBeCloseTo(plan.radii[0] - 15, 3);
        expect(Math.max(...radii)).toBeCloseTo(plan.radii[0] + 15, 3);
        const local12 = Plan.streetsOf(plan, [{ i: 0, j: 1 }]).find(s => s.axis === 'ring' && s.line === 1);
        const widths = Plan.streetPolygon(plan, local12).coordinates[0].map(point => Math.hypot(...local(plan, point)));
        expect(Math.max(...widths) - Math.min(...widths)).toBeCloseTo(12, 3);
    });

    it('refuses a Man without a place, and settings that leave no block', () => {
        expect(() => Plan.planFor({ ...Plan.DEFAULTS })).toThrow(RangeError);
        expect(() => city({ esplanadeM: 40, streetWidthM: 20 })).toThrow(RangeError);
    });
});

describe('the meridian plan, for the painting tool', () => {
    it('gives the street land and the superblock the tool starts from', () => {
        const Grid = require('../../frontend/js/parcels/schelling-grid.js');
        const plan = Grid.planFor({ lat: 45.8 });
        const cells = Streets.defaultCells(plan, 45.8, 15.98);
        expect(cells).toHaveLength(plan.subdivision.nLat * plan.subdivision.nLon);
        const street = Streets.streetsOf(plan, [{ i: 1, j: 1 }]).find(s => s.axis === 'EW');
        const [[west, south], [east], [, north]] = Streets.streetPolygon(plan, street).coordinates[0];
        expect(west).toBeCloseTo(Grid.lonOfLine(plan, 1), 12);
        expect(east).toBeCloseTo(Grid.lonOfLine(plan, 2), 12);
        expect((north - south) * plan.metersPerArcsecond.lat * 3600).toBeCloseTo(plan.streetWidthM, 6);
    });
});
