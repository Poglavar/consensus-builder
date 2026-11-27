// Streets, segments and plots along a side (frontend/js/streets/street-segments.js) on OSM-shaped
// fixtures in /osm-road's feature shape: a T-junction, a sharp bend against a gentle curve, a bridge
// and bridges over the street, a gap between buildings, the plots on each side, and house numbers.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../frontend/js/streets/street-segments.js');

// A London-like anchor; fixtures are drawn in metres east (x) and north (y) of it.
const LNG0 = -0.1, LAT0 = 51.5, M_PER_DEG = Math.PI * 6378137 / 180;
const ll = ([x, y]) => [LNG0 + x / (M_PER_DEG * Math.cos(LAT0 * Math.PI / 180)), LAT0 + y / M_PER_DEG];
let nextId = 1000;
function way(name, points, tags = {}, highway = 'residential') {
    const id = nextId++;
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: points.map(ll) },
        properties: { osm_id: id, name, highway_type: tags.railway ? null : highway, railway_type: tags.railway || null, tags: { ...(name ? { name } : {}), ...tags }, source: 'osm_road' } };
}
const box = (x0, y0, x1, y1, id) => ({ id, type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(ll)] } });
const line = (x0, x1, y = 0, step = 25) => { const out = []; for (let x = x0; x < x1; x += step) out.push([x, y]); out.push([x1, y]); return out; };
function cut(features, opts = {}) {
    const ways = S.normaliseWays(features);
    const seed = ways.find(w => w.name === (opts.name || 'Hughes Road'));
    const street = S.streetWays(ways, { seedWayId: seed.id });
    return S.segmentStreet({ ways, street, buildings: opts.buildings ?? null, numbers: opts.numbers || [] });
}

describe('streets', () => {
    it('finds the street at a point and groups its ways by name and connectivity, branches included', () => {
        const a = way('Hughes Road', line(0, 150)), b = way('Hughes Road', line(150, 300));
        const branch = way('Hughes Road', [[150, 0], [150, -80]]);
        const far = way('Hughes Road', line(2000, 2100));
        const other = way('Cross Road', [[150, 0], [150, 100]]);
        const ways = S.normaliseWays([a, b, branch, far, other]);
        const at = S.streetAt(ways, ll([60, 8]));
        expect(at).toMatchObject({ name: 'Hughes Road', wayId: String(a.properties.osm_id) });
        expect(at.distanceM).toBeCloseTo(8, 0);
        expect(S.streetAt(ways, ll([60, 80]))).toBeNull();
        const street = S.streetWays(ways, { seedWayId: at.wayId }).map(w => w.id).sort();
        expect(street).toEqual([a, b, branch].map(f => String(f.properties.osm_id)).sort());
        expect(S.normaliseName('  Hughes   Rd. ')).toBe(S.normaliseName('hughes rd'));
    });
});

describe('segments', () => {
    it('cuts at a T-junction and names the branching road', () => {
        const result = cut([way('Hughes Road', line(0, 300)), way('Cross Road', [[150, 0], [150, 120]])]);
        expect(result.segments).toHaveLength(2);
        const [first, second] = result.segments;
        expect(first.from.kind).toBe('end');
        expect(first.to).toMatchObject({ kind: 'branch', names: ['Cross Road'] });
        expect(second.from).toMatchObject({ kind: 'branch', names: ['Cross Road'] });
        expect(first.lengthM + second.lengthM).toBe(300);
        expect(result.lengthM).toBe(300);
    });

    it('a footway or an unnamed drive meeting the street is no branching; a branch of the street itself is', () => {
        const result = cut([way('Hughes Road', line(0, 300)), way(null, [[100, 0], [100, 30]], {}, 'footway'), way(null, [[200, 0], [200, -30]], {}, 'service')]);
        expect(result.segments).toHaveLength(1);
        const forked = cut([way('Hughes Road', line(0, 300)), way('Hughes Road', [[150, 0], [150, 90]])]);
        expect(forked.segments).toHaveLength(3);
        expect(forked.points.filter(p => p.kind === 'branch').every(p => p.own === true)).toBe(true);
    });

    it('cuts at a bend of 30° or more over a 20 m baseline, not along a gentle curve', () => {
        const sharp = cut([way('Hughes Road', [...line(0, 150), [150, 25], [150, 50], [150, 75], [150, 100], [150, 125], [150, 150]])]);
        expect(sharp.segments).toHaveLength(2);
        expect(sharp.segments[0].to).toMatchObject({ kind: 'bend' });
        expect(sharp.points.find(p => p.kind === 'bend').degrees).toBeGreaterThanOrEqual(80);
        // A quarter circle of radius 150 m sampled every 5 m: about 7.6° per 20 m chord pair.
        const arc = [];
        for (let a = 0; a <= 90; a += 2) arc.push([150 * Math.sin(a * Math.PI / 180), 150 - 150 * Math.cos(a * Math.PI / 180)]);
        const gentle = cut([way('Hughes Road', arc)]);
        expect(gentle.segments).toHaveLength(1);
        expect(gentle.points.some(p => p.kind === 'bend')).toBe(false);
        // A tight 90° corner drawn with many vertices (radius 20 m) still counts once.
        const tight = [...line(0, 100)];
        for (let a = 0; a <= 90; a += 10) tight.push([100 + 20 * Math.sin(a * Math.PI / 180), 20 - 20 * Math.cos(a * Math.PI / 180)]);
        tight.push([120, 60], [120, 120]);
        const corner = cut([way('Hughes Road', tight)]);
        expect(corner.points.filter(p => p.kind === 'bend')).toHaveLength(1);
    });

    it('cuts at both ends of a bridge longer than 3 m, not at a 2 m culvert', () => {
        const bridged = cut([way('Hughes Road', line(0, 100)), way('Hughes Road', [[100, 0], [120, 0]], { bridge: 'yes' }), way('Hughes Road', line(120, 250))]);
        expect(bridged.segments.map(s => [s.from.kind, s.to.kind])).toEqual([['end', 'bridge-start'], ['bridge-start', 'bridge-end'], ['bridge-end', 'end']]);
        const culvert = cut([way('Hughes Road', line(0, 100)), way('Hughes Road', [[100, 0], [102, 0]], { bridge: 'yes' }), way('Hughes Road', line(102, 250))]);
        expect(culvert.segments).toHaveLength(1);
    });

    it('cuts under a railway bridge but not under a footbridge', () => {
        const result = cut([way('Hughes Road', line(0, 300)),
            way(null, [[200, -50], [200, 50]], { railway: 'rail', bridge: 'yes' }),
            way(null, [[80, -20], [80, 20]], { bridge: 'yes' }, 'footway')]);
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0].to).toMatchObject({ kind: 'overpass', railway: true });
        expect(result.segments[0].lengthM).toBe(200);
    });

    // Strong Suburbs para 8: a stretch over 50 m between one building and the next is not developable
    // by a street vote, and ends a voting unit only if it faces another such stretch.
    const row = (from, to, y0, y1) => { const out = []; for (let x = from; x <= to; x += 15) out.push(box(x, y0, x + 10, y1)); return out; };
    it('cuts at a gap over 50 m between buildings where it faces a stretch without buildings across the street', () => {
        // North: buildings to 100 m, then from 170 m. South: buildings to 115 m, then from 175 m.
        const buildings = [...row(0, 90, 12, 22), ...row(170, 290, 12, 22), ...row(0, 105, -22, -12), ...row(175, 295, -22, -12)];
        const result = cut([way('Hughes Road', line(0, 300))], { buildings });
        expect(result.segments.map(s => [s.from.kind, s.to.kind])).toEqual([['end', 'gap-start'], ['gap-start', 'gap-end'], ['gap-end', 'end']]);
        // The cut is the part of the north gap (100–170 m) that faces the south one (115–175 m).
        expect(result.segments[1].fromM).toBeCloseTo(115, 0);
        expect(result.segments[1].toM).toBeCloseTo(170, 0);
        expect(result.segments[1].undevelopable).toEqual([{ side: 'left', fromM: 115, toM: 170 }, { side: 'right', fromM: 115, toM: 170 }]);
        expect(result.segments[0].undevelopable).toEqual([{ side: 'left', fromM: 100, toM: 115 }]);
        expect(result.segments[2].undevelopable).toEqual([{ side: 'right', fromM: 170, toM: 175 }]);
        // A gap runs to the chain's end when the next building is beyond the junction: north's
        // buildings stop at 100 m and south's start at 170 m, so 100–170 m faces a gap on both sides.
        const handover = cut([way('Hughes Road', line(0, 300))], { buildings: [...row(0, 90, 12, 22), ...row(170, 290, -22, -12)] });
        expect(handover.segments.map(s => [s.fromM, s.toM])).toEqual([[0, 100], [100, 170], [170, 300]]);
        expect(handover.segments[2].undevelopable).toEqual([{ side: 'left', fromM: 170, toM: 300 }]);
        // Gaps that face each other for only part of their length still leave a buffer: cut where they
        // face (the south gap 145–215 m faces the north one for 25 m).
        const staggered = cut([way('Hughes Road', line(0, 300))], { buildings: [...row(0, 90, 12, 22), ...row(170, 290, 12, 22), ...row(0, 135, -22, -12), ...row(215, 290, -22, -12)] });
        expect(staggered.segments.map(s => [s.fromM, s.toM])).toEqual([[0, 145], [145, 170], [170, 300]]);
        // Facing a gap of 45 m only (buildings from 160 m), the north gap cuts nothing.
        const narrow = cut([way('Hughes Road', line(0, 300))], { buildings: [...row(0, 90, 12, 22), ...row(170, 290, 12, 22), ...row(0, 105, -22, -12), ...row(160, 295, -22, -12)] });
        expect(narrow.segments).toHaveLength(1);
        // A stretch of the other side without any building (a park) faces it too.
        const park = cut([way('Hughes Road', line(0, 300))], { buildings: [...row(0, 90, 12, 22), ...row(170, 290, 12, 22)] });
        expect(park.segments.map(s => [s.fromM, s.toM])).toEqual([[0, 100], [100, 170], [170, 300]]);
    });

    it('keeps a gap over 50 m that faces buildings inside the segment, as a stretch no street vote develops and a referable point', () => {
        const buildings = [...row(0, 90, 12, 22), ...row(170, 290, 12, 22), ...row(0, 295, -22, -12)];
        const result = cut([way('Hughes Road', line(0, 300))], { buildings });
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0].undevelopable).toEqual([{ side: 'left', fromM: 100, toM: 170 }]);
        // Its edges stay referable points an agent may cut at explicitly.
        const start = result.points.find(p => p.kind === 'gap-start'), end = result.points.find(p => p.kind === 'gap-end');
        expect([start.measureM, end.measureM, start.side]).toEqual([100, 170, 'left']);
        expect(result.between(start.id, end.id)).toMatchObject({ fromM: 100, toM: 170, from: { kind: 'gap-start' }, to: { kind: 'gap-end' },
            undevelopable: [{ side: 'left', fromM: 100, toM: 170 }] });
        // A 40 m gap is no gap; unknown buildings give none.
        const close = cut([way('Hughes Road', line(0, 300))], { buildings: [...buildings, box(130, 12, 140, 22)] });
        expect(close.segments).toHaveLength(1);
        expect(close.segments[0].undevelopable).toBeUndefined();
        expect(close.points.some(p => p.kind === 'gap-start')).toBe(false);
        expect(cut([way('Hughes Road', line(0, 300))]).buildingsKnown).toBe(false);
    });

    it('keeps house numbers as referable points that name ends and bound a selection, without cutting', () => {
        const numbers = [
            { number: '2', street: 'Hughes Road', point: ll([20, 15]) },
            { number: '40', street: 'Hughes Road', point: ll([120, 15]) },
            { number: '7', street: 'Other Street', point: ll([60, 15]) }
        ];
        const result = cut([way('Hughes Road', line(0, 300)), way('Cross Road', [[200, 0], [200, 90]])], { numbers });
        expect(result.segments).toHaveLength(2);
        expect(result.segments[0].numbers.map(n => [n.houseNumber, n.side])).toEqual([['2', 'left'], ['40', 'left']]);
        const two = result.points.find(p => p.houseNumber === '2'), branch = result.points.find(p => p.kind === 'branch');
        const part = result.between(two.id, branch.id);
        expect(part.lengthM).toBe(180);
        expect(part.from).toMatchObject({ kind: 'number', houseNumber: '2' });
        expect(() => result.between(two.id, 'p999')).toThrow(/referable points/);
    });
});

describe('plots along a side', () => {
    // Hughes Road runs west→east, so its left side is north. A road parcel holds the centreline.
    const road = box(-10, -6, 310, 6, 'road');
    const north = [0, 1, 2].map(i => box(i * 20, 6, i * 20 + 20, 40, `n${i}`));
    const south = [0, 1].map(i => box(i * 30, -40, i * 30 + 30, -6, `s${i}`));
    const back = box(0, 40, 60, 80, 'back');
    const sidewalk = box(100, 6, 160, 9, 'walk');
    const behindWalk = box(100, 9, 160, 40, 'behind');
    const parcels = [road, ...north, ...south, back, sidewalk, behindWalk].map(f => ({ id: f.id, geometry: f.geometry }));
    const coordinates = line(0, 200).map(ll);

    it('selects the plots fronting the left, the right or both sides, never the plots behind them', () => {
        expect(S.sideCompass(coordinates)).toEqual({ left: 'north', right: 'south' });
        const left = S.plotsAlong({ coordinates, parcels, side: 'left' }).map(p => p.id);
        expect(left).toEqual(['n0', 'n1', 'n2', 'walk']);
        const right = S.plotsAlong({ coordinates, parcels, side: 'right' });
        expect(right.map(p => p.id)).toEqual(['s0', 's1']);
        expect(right.every(p => p.side === 'right' && p.frontageM >= 3)).toBe(true);
        const both = S.plotsAlong({ coordinates, parcels, side: 'both' }).map(p => p.id).sort();
        expect(both).toEqual(['n0', 'n1', 'n2', 's0', 's1', 'walk']);
        expect(both).not.toContain('back');
        expect(both).not.toContain('road');
    });

    it('looks through road parcels named transparent, such as a separate pavement', () => {
        const left = S.plotsAlong({ coordinates, parcels, side: 'left', transparent: ['walk'] }).map(p => p.id);
        expect(left).toEqual(['n0', 'n1', 'n2', 'behind']);
    });

    it('is cut by the segment: plots beyond its ends are not along it', () => {
        const short = line(0, 30).map(ll);
        expect(S.plotsAlong({ coordinates: short, parcels, side: 'left' }).map(p => p.id)).toEqual(['n0', 'n1']);
    });
});

describe('the street reference a vote records', () => {
    it('names the street, its OSM ways, the segment ends and the side, and rejects anything else', () => {
        const result = cut([way('Hughes Road', line(0, 300)), way('Cross Road', [[150, 0], [150, 120]])]);
        const ref = S.reference(result, result.segments[1], 'left', { scheme: 'GB-USRN', id: 12345678 });
        expect(ref).toMatchObject({ name: 'Hughes Road', part: 'segment', side: 'left', official: { scheme: 'GB-USRN', id: '12345678' },
            from: { kind: 'branch', names: ['Cross Road'] }, to: { kind: 'end' } });
        expect(ref.osmWayIds).toEqual(result.segments[1].wayIds);
        expect(S.normaliseReference(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
        const whole = S.reference(result, null, 'both');
        expect(whole).toEqual({ name: 'Hughes Road', osmWayIds: result.wayIds, part: 'street', side: 'both' });
        expect(() => S.normaliseReference({ ...whole, extra: 1 })).toThrow(/unknown fields/);
        expect(() => S.normaliseReference({ ...whole, side: 'north' })).toThrow(/side/);
        expect(() => S.normaliseReference({ ...whole, osmWayIds: ['w12'] })).toThrow(/OSM way ids/);
        expect(() => S.normaliseReference({ ...ref, from: undefined })).toThrow(/end/);
    });
});

describe('lines of a recorded street', () => {
    it('gives a segment its own line, a whole street every segment, and an unreferable end a marked straight line', () => {
        const result = cut([way('Hughes Road', line(0, 300)), way('Cross Road', [[150, 0], [150, 120]]), way('Side Lane', [[220, 0], [220, -90]])]);
        const answer = { street: { name: 'Hughes Road' }, segments: result.segments };
        const [first, second] = result.segments;
        const segmentRef = S.reference({ name: 'Hughes Road', wayIds: result.wayIds }, first, 'both');
        expect(S.linesFor(segmentRef, answer)).toEqual({ lines: [first.coordinates], approximate: false });
        // Two segments between the street's start and the second branching, recorded with those ends.
        const longer = { ...segmentRef, to: { kind: 'branch', point: second.to.point } };
        expect(S.linesFor(longer, answer)).toEqual({ lines: [first.coordinates, second.coordinates], approximate: false });
        const whole = S.reference({ name: 'Hughes Road', wayIds: result.wayIds }, null, 'both');
        expect(S.linesFor(whole, answer).lines).toHaveLength(result.segments.length);
        const numbered = { ...segmentRef, to: { kind: 'number', houseNumber: '12', point: ll([60, 0]) } };
        expect(S.linesFor(numbered, answer)).toEqual({ lines: [[numbered.from.point, numbered.to.point]], approximate: true });
        expect(S.linesFor(segmentRef, { street: { name: 'Cross Road' }, segments: result.segments })).toBeNull();
    });
});

describe('corner plots', () => {
    // A suburban T-junction drawn like an English one (no road parcels: HM Land Registry titles stop
    // at the highway): Hughes Road runs west→east, Cross Road leaves it north at x = 150. The two
    // corner plots are chamfered at the junction (Strong Suburbs para 80.5); behind the west corner
    // plot, c1 fronts Cross Road only.
    const poly = (points, id) => ({ id, geometry: { type: 'Polygon', coordinates: [[...points, points[0]].map(ll)] } });
    const parcels = [
        poly([[60, 5], [95, 5], [95, 45], [60, 45]], 'h1'),
        poly([[95, 5], [125, 5], [125, 45], [95, 45]], 'h2'),
        poly([[125, 5], [140, 5], [145, 10], [145, 45], [125, 45]], 'corner-west'),
        poly([[105, 45], [145, 45], [145, 80], [105, 80]], 'c1'),
        poly([[155, 10], [160, 5], [190, 5], [190, 45], [155, 45]], 'corner-east'),
        poly([[155, 45], [190, 45], [190, 80], [155, 80]], 'c2')
    ];
    const features = () => [way('Hughes Road', line(0, 300)), way('Cross Road', [[150, 0], [150, 60], [150, 120]])];
    const along = (result, index, side) => S.plotsAlong({ coordinates: result.segments[index].coordinates, parcels, side, arms: S.armsOf(result.segments[index]) });

    it('a corner plot is along each street its boundary runs along, and is marked with the other street', () => {
        const hughes = cut(features());
        expect(hughes.segments[0].to).toMatchObject({ kind: 'branch', names: ['Cross Road'] });
        expect(hughes.segments[0].to.arms.map(arm => arm.name)).toEqual(['Cross Road']);
        const west = along(hughes, 0, 'left');
        expect(west.map(plot => plot.id)).toEqual(['h1', 'h2', 'corner-west']);
        expect(west.find(plot => plot.id === 'corner-west').corner).toEqual({ streets: ['Cross Road'] });
        // Plots beside it and behind it are not corners: the corner plot stands between them and Cross Road.
        expect(west.filter(plot => plot.corner).map(plot => plot.id)).toEqual(['corner-west']);
        expect(along(hughes, 1, 'left').filter(plot => plot.corner).map(plot => [plot.id, plot.corner.streets])).toEqual([['corner-east', ['Cross Road']]]);

        const cross = cut(features(), { name: 'Cross Road' });
        const both = along(cross, 0, 'both');
        expect(both.map(plot => plot.id).sort()).toEqual(['c1', 'c2', 'corner-east', 'corner-west']);
        expect(both.filter(plot => plot.corner).map(plot => [plot.id, plot.corner.streets]).sort())
            .toEqual([['corner-east', ['Hughes Road']], ['corner-west', ['Hughes Road']]]);
        // Without the ends' other roads nothing is marked, as before.
        expect(S.plotsAlong({ coordinates: cross.segments[0].coordinates, parcels, side: 'both' }).some(plot => plot.corner)).toBe(false);
    });

    it('the street reference records the corner plots with their other streets, and rejects malformed ones', () => {
        const hughes = cut(features());
        const corners = along(hughes, 0, 'left').filter(plot => plot.corner).map(plot => ({ parcelId: plot.id, streets: plot.corner.streets }));
        const ref = S.reference(hughes, hughes.segments[0], 'left', null, corners);
        expect(ref.corners).toEqual([{ parcelId: 'corner-west', streets: ['Cross Road'] }]);
        expect(S.normaliseReference(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
        expect(S.reference(hughes, hughes.segments[0], 'left')).not.toHaveProperty('corners');
        expect(() => S.normaliseReference({ ...ref, corners: [{ parcelId: 'x' }] })).toThrow(/corner plot/);
        expect(() => S.normaliseReference({ ...ref, corners: [...ref.corners, ...ref.corners] })).toThrow(/once/);
    });
});
