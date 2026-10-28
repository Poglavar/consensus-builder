// Park enclosures (frontend/js/park-enclosures.js): the record rules, where gates go, the fence split
// at its gates, every fence style and play item as boxes, and the checks MCP and the editor share.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const enclosures = require('../../frontend/js/park-enclosures.js');

const M = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M * Math.cos(LAT * Math.PI / 180);
const ll = ([x, y]) => [LNG + x / MX, LAT + y / M];
const metres = ([lng, lat]) => [(lng - LNG) * MX, (lat - LAT) * M];
// A 40 × 20 m enclosure, counter-clockwise from its south-west corner.
const RING = [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]].map(ll);
const near = (a, b, tolerance = 0.05) => Math.hypot(...metres(a).map((value, i) => value - metres(b)[i])) < tolerance;
const lengthOf = run => run.slice(1).reduce((sum, point, i) => sum + Math.hypot(...metres(point).map((value, j) => value - metres(run[i])[j])), 0);

describe('the enclosure record', () => {
    it('keeps a valid record, defaults an unknown fence by use, and drops a ring that is not one', () => {
        const list = enclosures.normalizeEnclosures([
            { fence: 'plinth', use: 'none', gates: [ll([20, 0])] },
            { fence: 'chainlink', use: 'dog', gates: [ll([0, 10])], ring: RING.slice(0, 4) },
            { fence: 'iron', use: 'skatepark', gates: [], ring: [ll([0, 0]), ll([1, 1]), ll([0, 0])] },
            null
        ]);
        expect(list).toEqual([
            { fence: 'plinth', use: 'none', gates: [ll([20, 0])] },
            // An unclosed ring is closed; a dog area without a known fence gets mesh.
            { fence: 'mesh', use: 'dog', gates: [ll([0, 10])], ring: RING }
        ]);
        expect(enclosures.DEFAULT_FENCE).toEqual({ none: 'iron', dog: 'mesh', play: 'mesh' });
        expect(enclosures.USE_SURFACE).toEqual({ none: null, dog: 'gravel', play: 'rubber' });
    });

    it('names the first problem with an authored enclosure', () => {
        const park = { type: 'Polygon', coordinates: [RING] };
        const ok = { fence: 'iron', use: 'play', gates: [ll([20, 0.5])], ring: RING };
        expect(enclosures.enclosureIssue(ok)).toBeNull();
        expect(enclosures.enclosureIssue({ ...ok, fence: 'hedge' }).code).toBe('enclosure-fence');
        expect(enclosures.enclosureIssue({ ...ok, use: 'tennis' }).code).toBe('enclosure-use');
        expect(enclosures.enclosureIssue({ ...ok, ring: RING.slice(0, 4) }).code).toBe('enclosure-ring');
        expect(enclosures.enclosureIssue({ ...ok, gates: [] }).code).toBe('enclosure-gate-missing');
        expect(enclosures.enclosureIssue({ ...ok, gates: [ll([20, 5])] }).code).toBe('enclosure-gate-off-fence');
        // A whole-park fence is checked against the park's outline.
        const whole = { fence: 'iron', use: 'none', gates: [ll([40, 10])] };
        expect(enclosures.enclosureIssue(whole, park)).toBeNull();
        expect(enclosures.enclosureIssue({ ...whole, gates: [ll([30, 10])] }, park).code).toBe('enclosure-gate-off-fence');
    });

    it('follows the park outline when it has no ring of its own, taking the largest part', () => {
        const small = [[100, 0], [104, 0], [104, 4], [100, 0]].map(ll);
        const park = { type: 'MultiPolygon', coordinates: [[small], [RING]] };
        expect(enclosures.enclosureRing({ fence: 'iron', use: 'none', gates: [] }, park)).toEqual(RING);
        expect(enclosures.enclosureRing({ fence: 'iron', use: 'none', gates: [], ring: small }, park)).toEqual(small);
    });
});

describe('gates', () => {
    it('puts gates where footpaths cross the fence, else in the middle of the longest side', () => {
        const paths = [[ll([-5, 10]), ll([45, 10])], [ll([20, 10]), ll([20.5, 10])]];
        const gates = enclosures.defaultGates(RING, paths);
        expect(gates).toHaveLength(2);
        expect(near(gates[0], ll([0, 10])) || near(gates[1], ll([0, 10]))).toBe(true);
        expect(gates.some(gate => near(gate, ll([40, 10])))).toBe(true);
        const [middle] = enclosures.defaultGates(RING, []);
        expect(near(middle, ll([20, 0]))).toBe(true);
    });

    it('snaps a point to the nearest place on the fence', () => {
        const hit = enclosures.snapToRing(RING, ll([12, 1.5]));
        expect(near(hit.point, ll([12, 0]))).toBe(true);
        expect(hit.distM).toBeCloseTo(1.5, 2);
    });

    it('splits the fence at its gates and leaves a gate-wide opening at each', () => {
        const none = enclosures.fenceRuns(RING, []);
        expect(none.runs).toEqual([RING]);
        const one = enclosures.fenceRuns(RING, [ll([20, 0.4])]);
        expect(one.gates).toHaveLength(1);
        expect(near(one.gates[0].centre, ll([20, 0]))).toBe(true);
        expect(one.runs).toHaveLength(1);
        // The one run goes all the way round from one side of the gate to the other.
        expect(lengthOf(one.runs[0])).toBeCloseTo(120 - enclosures.GATE_WIDTH_M, 1);
        expect(near(one.runs[0][0], ll([20.6, 0]))).toBe(true);
        expect(near(one.runs[0][one.runs[0].length - 1], ll([19.4, 0]))).toBe(true);
        // Two gates make two runs; a gate across the closing corner wraps; far and duplicate gates are ignored.
        const two = enclosures.fenceRuns(RING, [ll([20, 0]), ll([20, 20]), ll([20.3, 0]), ll([20, 10])]);
        expect(two.gates).toHaveLength(2);
        expect(two.runs).toHaveLength(2);
        expect(two.runs.map(lengthOf).reduce((a, b) => a + b, 0)).toBeCloseTo(120 - 1.5 - 1.2, 1);
        const corner = enclosures.fenceRuns(RING, [ll([0.2, 0])]);
        expect(lengthOf(corner.runs[0])).toBeCloseTo(120 - 1.2, 1);
    });
});

describe('fence parts', () => {
    const run = [[0, 0], [10, 0]];
    const byMaterial = boxes => boxes.reduce((counts, part) => ({ ...counts, [part.material]: (counts[part.material] || 0) + 1 }), {});

    it('builds each style from its own parts, lightest to heaviest', () => {
        expect(enclosures.FENCE_KINDS).toEqual(['rail', 'mesh', 'iron', 'plinth']);
        expect(enclosures.FENCE_KINDS.map(kind => enclosures.FENCES[kind].heightM)).toEqual([0.6, 1.2, 1.8, 2.2]);
        // A 10 m low rail: posts every 2 m including both ends, one rail.
        expect(byMaterial(enclosures.fenceParts([run], 'rail'))).toEqual({ timber: 7 });
        expect(byMaterial(enclosures.fenceParts([run], 'mesh'))).toEqual({ mesh: 1, metal: 2 + 5 });
        // Wrought iron: bars every 13 cm.
        expect(byMaterial(enclosures.fenceParts([run], 'iron'))).toEqual({ iron: 2 + 76 + 5 });
        // Iron on a brick base: the plinth and its coping, brick pillars every 4 m with stone caps.
        expect(byMaterial(enclosures.fenceParts([run], 'plinth'))).toEqual({ brick: 1 + 4, stone: 1 + 4, iron: 2 + 76 });
        expect(enclosures.fenceParts([run], 'hedge')).toEqual([]);
    });

    it('sizes horizontal parts in scene units and heights in metres', () => {
        const k = 1.5;
        const scaled = enclosures.fenceParts([run.map(([x, y]) => [x * k, y * k])], 'plinth', k);
        const wall = scaled.find(part => part.material === 'brick' && part.height === 0.6);
        expect(wall).toMatchObject({ x: 7.5, y: 0, z: 0.3, angle: 0 });
        expect(wall.along).toBeCloseTo((10 + 0.35) * k, 9);
        expect(wall.across).toBeCloseTo(0.35 * k, 9);
        const pillar = scaled.find(part => part.material === 'brick' && part.height === 2.3);
        expect(pillar.z).toBeCloseTo(1.15, 9);
        expect(pillar.along).toBeCloseTo(0.5 * k, 9);
    });

    it('thins the bars of a very long fence', () => {
        const long = [[0, 0], [5000, 0]];
        const bars = enclosures.fenceParts([long], 'iron').filter(part => part.height === 1.8);
        expect(bars.length).toBeLessThanOrEqual(15000);
        expect(bars.length).toBeGreaterThan(14000);
    });
});

describe('play equipment', () => {
    it('offers a swing, a seesaw and a slide, each standing on the ground', () => {
        expect(enclosures.EQUIPMENT).toEqual({ swing: 'swings', seesaw: 'seesaws', slide: 'slides' });
        for (const [kind, parts] of Object.entries(enclosures.EQUIPMENT_PARTS)) {
            expect(parts.length, kind).toBeGreaterThan(4);
            const lowest = Math.min(...parts.map(part => part.z - Math.abs(part.sz * Math.cos(part.ry)) / 2 - Math.abs(part.sx * Math.sin(part.ry)) / 2));
            expect(lowest, kind).toBeGreaterThan(-0.05);
        }
        // The swing's beam is 2.2 m up; the slide's chute ends near the ground at the front.
        expect(enclosures.EQUIPMENT_PARTS.swing[0]).toMatchObject({ material: 'frame', z: 2.2 });
        const chute = enclosures.EQUIPMENT_PARTS.slide.find(part => part.material === 'chute');
        expect(chute.x + Math.cos(chute.ry) * chute.sx / 2).toBeCloseTo(1.6, 1);
        expect(chute.z - Math.sin(chute.ry) * chute.sx / 2).toBeCloseTo(0.25, 1);
    });

    it('normalises placements to a point and a bearing', () => {
        const coordinate = value => (Array.isArray(value) && value.length >= 2 ? [Number(value[0]), Number(value[1])] : null);
        expect(enclosures.normalizeEquipment([{ coordinate: [16, 45], bearing: 370 }, [16.1, 45.1], { coordinate: 'x' }], coordinate))
            .toEqual([{ coordinate: [16, 45], bearing: 10 }, { coordinate: [16.1, 45.1], bearing: 0 }]);
    });
});
