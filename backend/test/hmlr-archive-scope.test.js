// Verifies conservative archive routing against independent polygon-cell intersections.
import { describe, expect, it } from 'vitest';
import { booleanIntersects, bbox, bboxPolygon, feature } from '@turf/turf';
import {
    HMLR_SCOPE_GRID_DEGREES,
    HMLR_SCOPE_POLICY,
    createHmlrArchiveScopeBuilder,
    hmlrArchiveScopeIntersects,
    validateHmlrArchiveScope
} from '../parcels/hmlr-archive-scope.js';

const GRID = HMLR_SCOPE_GRID_DEGREES;
const HASH = 'a'.repeat(64);
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings });
const asFeature = geometry => feature(geometry);
const cellBounds = (x, y) => [x * GRID, y * GRID, (x + 1) * GRID, (y + 1) * GRID];

function build(geometries, project) {
    const builder = createHmlrArchiveScopeBuilder(project);
    for (const geometry of geometries) builder.addGeometry(geometry);
    return builder.finish(HASH);
}

function oracleCells(geometry) {
    const [minX, minY, maxX, maxY] = bbox(asFeature(geometry));
    const firstX = Math.floor(minX / GRID) - 1, lastX = Math.floor(maxX / GRID) + 1;
    const firstY = Math.floor(minY / GRID) - 1, lastY = Math.floor(maxY / GRID) + 1;
    const hits = [];
    for (let y = firstY; y <= lastY; y++) for (let x = firstX; x <= lastX; x++) {
        const bounds = cellBounds(x, y);
        if (booleanIntersects(asFeature(geometry), bboxPolygon(bounds))) hits.push({ x, y, bounds });
    }
    return hits;
}

function scopeHasCell(scope, x, y) {
    const row = scope.rows.find(([rowY]) => rowY === y);
    if (!row) return false;
    for (let index = 1; index < row.length; index += 2) {
        if (row[index] <= x && x <= row[index + 1]) return true;
    }
    return false;
}

const oracleCases = [
    ['concave polygon', polygon([[0.00013, 0.00019], [0.00387, 0.00019], [0.00387, 0.0011],
        [0.0012, 0.0011], [0.0012, 0.00382], [0.00013, 0.00382], [0.00013, 0.00019]])],
    ['thin diagonal sliver', polygon([[0.00011, 0.00012], [0.00391, 0.00376], [0.00384, 0.00383], [0.00004, 0.00019], [0.00011, 0.00012]])],
    ['polygon with a hole', polygon(square(0.0001, 0.0001, 0.0039, 0.0039), square(0.0011, 0.0011, 0.0029, 0.0029).reverse())],
    ['disjoint multipolygon', { type: 'MultiPolygon', coordinates: [
        [square(0.0001, 0.0002, 0.0011, 0.0013)], [square(0.0031, 0.0025, 0.0041, 0.0036)]
    ] }],
    ['negative longitude at Oxford latitude', polygon(square(-1.2351, 51.748, -1.2339, 51.7494))],
    ['invalid outside hole', polygon(square(-0.001, -0.001, 0.002, 0.002), square(0.004, 0.004, 0.005, 0.005).reverse())],
    ['edge touching a cell boundary', polygon(square(0.0001, 0.0001, 0.001, 0.001))],
    ['self crossing bow tie', polygon([[0.0001, 0.0001], [0.0039, 0.0039], [0.0001, 0.0039], [0.0039, 0.0001], [0.0001, 0.0001]])]
];

describe('HMLR archive occupied-cell scope', () => {
    it.each(oracleCases)('covers every Turf-intersecting complete cell for a %s', (_name, geometry) => {
        const scope = build([geometry]);
        const oracle = oracleCells(geometry);
        expect(oracle.length).toBeGreaterThan(0);
        for (const { x, y, bounds } of oracle) {
            expect(scopeHasCell(scope, x, y), `missing encoded cell (${x}, ${y})`).toBe(true);
            expect(hmlrArchiveScopeIntersects(scope, bounds)).toBe(true);
        }
    });

    it('does not route a query wholly inside a hole or between disjoint components', () => {
        const withHole = polygon(square(0, 0, 0.004, 0.004), square(0.001, 0.001, 0.003, 0.003).reverse());
        const holeScope = build([withHole]);
        const holeInterior = [0.00155, 0.00155, 0.00195, 0.00195];
        expect(booleanIntersects(asFeature(withHole), bboxPolygon(holeInterior))).toBe(false);
        expect(hmlrArchiveScopeIntersects(holeScope, holeInterior)).toBe(false);

        const islands = { type: 'MultiPolygon', coordinates: [
            [square(0, 0, 0.001, 0.001)], [square(0.003, 0, 0.004, 0.001)]
        ] };
        const gap = [0.00155, 0.0002, 0.00195, 0.0008];
        expect(booleanIntersects(asFeature(islands), bboxPolygon(gap))).toBe(false);
        expect(hmlrArchiveScopeIntersects(build([islands]), gap)).toBe(false);
    });

    it('keeps a cell that only touches a parcel boundary', () => {
        const geometry = polygon(square(0, 0, 0.001, 0.001));
        const touchingCell = [0.001, 0, 0.0015, 0.0005];
        expect(booleanIntersects(asFeature(geometry), bboxPolygon(touchingCell))).toBe(true);
        expect(hmlrArchiveScopeIntersects(build([geometry]), touchingCell)).toBe(true);
    });

    it('applies the optional coordinate projection before cell assignment', () => {
        const geometry = polygon(square(1000, 2000, 1002, 2002));
        const scope = build([geometry], ([x, y]) => [x / 1000, y / 1000]);
        expect(hmlrArchiveScopeIntersects(scope, [1, 2, 1.002, 2.002])).toBe(true);
        expect(hmlrArchiveScopeIntersects(scope, [1.01, 2.01, 1.011, 2.011])).toBe(false);
    });

    it('covers curved projected mid-edge repair vertices using 250 m samples', () => {
        // A 1 km native edge whose endpoints lie on y=0 but whose projected
        // midpoint bows to y=0.002. The endpoint polygon alone misses the bulge.
        const geometry = polygon([[0, 0], [1000, 0], [1000, -10], [0, -10], [0, 0]]);
        const project = ([x, y]) => [x / 1000, y / 1000 + Math.sin(Math.PI * x / 1000) * 0.002];
        const scope = build([geometry], project);
        const bulgeCell = [0.4998, 0.0018, 0.5002, 0.0022];
        const endpointOnly = polygon([[0, 0], [1, 0], [1, -0.01], [0, -0.01], [0, 0]]);
        expect(booleanIntersects(asFeature(endpointOnly), bboxPolygon(bulgeCell))).toBe(false);
        expect(hmlrArchiveScopeIntersects(scope, bulgeCell)).toBe(true);
        expect(scope.featureCount).toBe(1);
    });

    it('merges overlapping features into the same deterministic rows in either input order', () => {
        const first = polygon(square(0.0001, 0.0001, 0.0021, 0.0021));
        const second = polygon(square(0.0011, 0.0011, 0.0031, 0.0031));
        const forward = build([first, second]);
        const reverse = build([second, first]);
        expect(forward.featureCount).toBe(2);
        expect(reverse.featureCount).toBe(2);
        expect(forward.rows).toEqual(reverse.rows);
        expect(hmlrArchiveScopeIntersects(forward, [0.0014, 0.0014, 0.0016, 0.0016])).toBe(true);
    });

    it('requires a complete scope pinned to the authority archive and feature count', () => {
        const authority = { archiveSha256: HASH, featureCount: 2, bounds: [-0.01, -0.01, 0.01, 0.01] };
        const scope = build([polygon(square(0, 0, 0.001, 0.001)), polygon(square(0.002, 0.002, 0.003, 0.003))]);
        expect(validateHmlrArchiveScope(scope, authority)).toBe(scope);
        expect(() => validateHmlrArchiveScope({ ...scope, archiveSha256: 'b'.repeat(64) }, authority)).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope({ ...scope, featureCount: 1 }, authority)).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope({ ...scope, schemaVersion: 2 }, authority)).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope({ ...scope, policy: 'wrong-policy' }, authority)).toThrow(/complete pinned archive/);
        const { policy, ...withoutPolicy } = scope;
        expect(() => validateHmlrArchiveScope(withoutPolicy, authority)).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope({ ...scope, rows: [] }, authority)).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope(scope, { ...authority, archiveSha256: 'c'.repeat(64) })).toThrow(/complete pinned archive/);
        expect(() => validateHmlrArchiveScope(scope, { ...authority, featureCount: 3 })).toThrow(/complete pinned archive/);
    });

    it.each([
        ['descending row keys', rows => [...rows].reverse()],
        ['noninteger row key', rows => [[0.5, ...rows[0].slice(1), ...rows[1].slice(1)]]],
        ['empty or odd span tuple', rows => [[rows[0][0], rows[0][1]]]],
        ['overlapping spans', rows => [[rows[0][0], rows[0][1], rows[0][2], rows[0][2], rows[0][3]]]],
        ['out-of-range row', rows => [[180001, ...rows[0].slice(1)]]],
        ['out-of-range span', rows => [[rows[0][0], -360002, rows[0][2]]]]
    ])('rejects malformed scope rows: %s', (_name, mutate) => {
        const scope = build([polygon(square(0, 0, 0.001, 0.001)), polygon(square(0.002, 0.002, 0.003, 0.003))]);
        const rows = mutate(scope.rows);
        expect(() => validateHmlrArchiveScope({ ...scope, rows }, {
            archiveSha256: HASH, featureCount: 2, bounds: [-1, -1, 1, 1]
        })).toThrow(/Invalid HMLR archive scope row|Invalid HMLR archive scope span/);
    });

    it('rejects scope spans outside the pinned authority extent', () => {
        const scope = build([polygon(square(0, 0, 0.001, 0.001))]);
        expect(() => validateHmlrArchiveScope(scope, {
            archiveSha256: HASH, featureCount: 1, bounds: [0.01, 0.01, 0.02, 0.02]
        })).toThrow(/exceeds its authority extent/);
    });
});
