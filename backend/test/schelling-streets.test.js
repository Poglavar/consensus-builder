// A Schelling intervention is a set of painted blocks; what it proposes is every street that bounds
// one. These tests pin that: shared edges come out once, streets that meet share their junction
// node, separate patches are separate roads, arterials keep Angel's 30 m and local streets the
// chosen width, and the corridor import turns each road into one road-track record.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Grid = require('../../frontend/js/parcels/schelling-grid.js');
const Streets = require('../../frontend/js/schelling/schelling-streets.js');
const { recordsFromImport } = require('../../frontend/js/corridor-import.js');
const { corridorProfileToOsmTags } = require('../../frontend/js/corridor-profile.js');

const plan = Grid.planFor({ lat: 45.8045 });
const start = Grid.cellAt(plan, 45.8045, 15.9788);
const superblock = Grid.superblockOf(plan, start.i, start.j);
const inner = superblock.cells.find(cell => !Grid.isArterialLon(plan, cell.i) && !Grid.isArterialLat(plan, cell.j)
    && !Grid.isArterialLon(plan, cell.i + 1) && !Grid.isArterialLat(plan, cell.j + 1));
const width = strips => strips.reduce((sum, strip) => sum + strip.width, 0);

describe('the streets bounding painted blocks', () => {
    it('are the four sides of one block, meeting at four shared corners', () => {
        const streets = Streets.streetsOf(plan, [inner]);
        expect(streets).toHaveLength(4);
        expect(streets.every(street => street.nodes.length === 2)).toBe(true);
        expect(Streets.networksOf(streets)).toHaveLength(1);
        expect(streets.every(street => street.roadClass === 'local')).toBe(true);
    });

    it('share the street between two neighbouring blocks, once', () => {
        const pair = [inner, { i: inner.i + 1, j: inner.j }];
        const streets = Streets.streetsOf(plan, pair);
        // Two east-west streets along both blocks, three north-south ones (west, between, east).
        expect(streets.filter(street => street.axis === 'EW').map(street => street.nodes.length)).toEqual([3, 3]);
        expect(streets.filter(street => street.axis === 'NS')).toHaveLength(3);
    });

    it('make a whole superblock one road: 9 + 9 streets, 4 of them arterials, 81 nodes', () => {
        const streets = Streets.streetsOf(plan, superblock.cells);
        expect(streets).toHaveLength(18);
        expect(streets.filter(street => street.roadClass === 'arterial')).toHaveLength(4);
        expect(Streets.networksOf(streets)).toHaveLength(1);
        const nodes = new Set(streets.flatMap(street => street.nodes.map(node => `${node.i}:${node.j}`)));
        expect(nodes.size).toBe(81);
    });

    it('keep separate patches as separate roads, and count a repeated block once', () => {
        const far = { i: inner.i + 3, j: inner.j };
        expect(Streets.networksOf(Streets.streetsOf(plan, [inner, far]))).toHaveLength(2);
        expect(Streets.streetsOf(plan, [inner, inner])).toHaveLength(4);
        expect(Streets.streetsOf(plan, [])).toEqual([]);
    });

    it('sum up what a selection proposes', () => {
        const summary = Streets.summary(plan, superblock.cells);
        expect(summary).toMatchObject({ blocks: 64, streets: 18, roads: 1 });
        expect(summary.lengthM.arterial).toBeCloseTo(2 * plan.arterial.spacingLonM + 2 * plan.arterial.spacingLatM, 3);
        expect(summary.lengthM.local).toBeCloseTo(7 * plan.arterial.spacingLonM + 7 * plan.arterial.spacingLatM, 3);
    });
});

describe('cross-sections', () => {
    it('make the arterial Angel’s 30 m', () => {
        expect(width(Streets.ARTERIAL_STRIPS)).toBeCloseTo(30, 9);
    });

    it('make a local street exactly the chosen width, with parking once there is room', () => {
        for (const metres of [7.5, 8, 12, 14, 15, 20, 24]) expect(width(Streets.localStrips(metres))).toBeCloseTo(metres, 3);
        expect(Streets.localStrips(12).some(strip => strip.type === 'parking')).toBe(false);
        expect(Streets.localStrips(15).filter(strip => strip.type === 'parking')).toHaveLength(2);
        expect(() => Streets.localStrips(5)).toThrow(RangeError);
    });
});

describe('the OSM form and the road records', () => {
    const laneTags = corridorProfileToOsmTags;

    it('shares junction nodes between crossing streets', () => {
        const { form, roads } = Streets.importForm(plan, superblock.cells, { laneTags });
        const nodes = form.elements.filter(element => element.type === 'node');
        const ways = form.elements.filter(element => element.type === 'way');
        expect(nodes).toHaveLength(81);
        expect(ways).toHaveLength(18);
        expect(roads).toEqual([{ id: 'schelling-1', name: null, wayIds: ways.map(way => way.id) }]);
        const uses = new Map();
        ways.forEach(way => way.nodes.forEach(id => uses.set(id, (uses.get(id) || 0) + 1)));
        // Every node is on one east-west and one north-south street.
        expect([...uses.values()].every(count => count === 2)).toBe(true);
        // Node coordinates are the lattice lines themselves.
        const lats = new Set(nodes.map(node => node.lat));
        expect(lats.size).toBe(9);
        expect([...lats].every(lat => Number.isInteger(Math.round(lat * 3600 / plan.local.stepLatSec * 1e6) / 1e6))).toBe(true);
    });

    it('becomes one road-track record per road, arterials at 30 m and local streets at the chosen width', () => {
        const wide = Grid.planFor({ lat: 45.8045, streetWidthM: 15 });
        const cells = Grid.superblockOf(wide, start.i, start.j).cells;
        const records = recordsFromImport(Streets.importForm(wide, cells, { laneTags }), { source: 'schelling-point', fallbackTitle: 'Schelling roads' });
        expect(records).toHaveLength(1);
        const { definition } = records[0].roadProposal;
        expect(records[0].goal).toBe('road-track');
        expect(definition.metadata.source).toBe('schelling-point');
        expect(definition.segments).toHaveLength(18);
        const widths = definition.segments.map((_, index) => {
            const id = definition.segmentIds?.[index];
            const profile = (id && definition.segmentProfiles?.[id]) || definition.profile;
            return Math.round(width(profile.strips) * 1000) / 1000;
        });
        expect(widths.filter(value => value === 30)).toHaveLength(4);
        expect(widths.filter(value => value === 15)).toHaveLength(14);
    });

    it('needs a way to write lane tags', () => {
        expect(() => Streets.importForm(plan, [inner])).toThrow(TypeError);
    });
});
