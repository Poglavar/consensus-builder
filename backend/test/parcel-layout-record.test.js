// Unit tests for frontend/js/parcel-layout-record.js: a layout plot's fingerprint and a layout's
// canonical content are geometry only, stable under key order and owner fields, and move with any
// change of a border.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const record = require('../../frontend/js/parcel-layout-record.js');

const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const square = (x0 = 15.96, y0 = 45.8, size = 0.001) => ({ type: 'Polygon', coordinates: [ring(x0, y0, x0 + size, y0 + size)] });
const sha256 = text => createHash('sha256').update(text).digest('hex');

describe('plotFingerprint', () => {
    it('is the SHA-256 of the canonical geometry and nothing else', () => {
        const geometry = square();
        const canonical = `{"coordinates":${JSON.stringify(geometry.coordinates)},"type":"Polygon"}`;
        expect(record.plotFingerprint({ geometry })).toBe(`layout-plot1-sha256:${sha256(canonical)}`);
    });

    it('ignores owners, shares, colours, areas, sources and key order', () => {
        const plain = record.plotFingerprint({ geometry: square() });
        const decorated = {
            source: 'equal', area: 123.4, color: '#123456', ownerKey: 'agent-ana', displayName: 'Ana', jointPool: true,
            owners: [{ ownerKey: 'agent-ana', share: 1 }],
            geometry: { coordinates: square().coordinates, type: 'Polygon', bbox: [0, 0, 1, 1] }
        };
        expect(record.plotFingerprint(decorated)).toBe(plain);
        expect(record.plotFingerprint({ geometry: { type: 'Feature', properties: { owner: 'x' }, geometry: square() } })).toBe(plain);
    });

    it('changes with any change of the geometry', () => {
        const plain = record.plotFingerprint({ geometry: square() });
        const moved = square();
        moved.coordinates[0][2] = [moved.coordinates[0][2][0] + 1e-9, moved.coordinates[0][2][1]];
        expect(record.plotFingerprint({ geometry: moved })).not.toBe(plain);
        expect(record.plotFingerprint({ geometry: square(15.961) })).not.toBe(plain);
        expect(record.plotFingerprint({ geometry: { type: 'MultiPolygon', coordinates: [square().coordinates] } })).not.toBe(plain);
    });

    it('refuses a plot without closed, finite polygon geometry', () => {
        expect(() => record.plotFingerprint({})).toThrow(/polygon geometry/);
        expect(() => record.plotFingerprint({ geometry: { type: 'Point', coordinates: [15.96, 45.8] } })).toThrow(/polygon geometry/);
        const open = square();
        open.coordinates[0].pop();
        open.coordinates[0].push([15.9601, 45.8]);
        expect(() => record.plotFingerprint({ geometry: open })).toThrow(/closed polygon rings/);
        const infinite = square();
        infinite.coordinates[0][1] = [Infinity, 45.8];
        expect(() => record.plotFingerprint({ geometry: infinite })).toThrow(/finite/);
    });
});

describe('content', () => {
    const plan = () => ({
        algorithm: 'equal', generatedAt: '2026-10-21T10:00:00.000Z', totalArea: 2, plotCount: 2, poolSource: 'site',
        pool: { type: 'Polygon', coordinates: [ring(0, 0, 2, 1)] },
        plots: [
            { geometry: { type: 'Polygon', coordinates: [ring(0, 0, 1, 1)] }, area: 1, source: 'equal' },
            { geometry: { type: 'Polygon', coordinates: [ring(1, 0, 2, 1)] }, area: 1, source: 'manual', derivation: { kind: 'courtyard', from: [0] } }
        ]
    });

    it('is the sorted-key JSON of the pool and each plot\'s geometry, source and derivation', () => {
        const pool = `{"coordinates":${JSON.stringify([ring(0, 0, 2, 1)])},"type":"Polygon"}`;
        const first = `{"geometry":{"coordinates":${JSON.stringify([ring(0, 0, 1, 1)])},"type":"Polygon"},"source":"equal"}`;
        const second = `{"derivation":{"from":[0],"kind":"courtyard"},"geometry":{"coordinates":${JSON.stringify([ring(1, 0, 2, 1)])},"type":"Polygon"},"source":"manual"}`;
        expect(record.content(plan())).toBe(`{"plots":[${first},${second}],"pool":${pool}}`);
    });

    it('leaves out everything that is not the design, so metadata and owners never move it', () => {
        const decorated = plan();
        Object.assign(decorated, { generatedAt: 'later', totalArea: 99, plotCount: 7, openGroundM2: 3, ownerShares: [{ ownerKey: 'a' }] });
        Object.assign(decorated.plots[0], { area: 5, owners: [{ ownerKey: 'a', share: 1 }], color: '#fff' });
        expect(record.content(decorated)).toBe(record.content(plan()));
    });

    it('changes with a border, a source, a derivation or the plot order (the plot numbers)', () => {
        const base = record.content(plan());
        const moved = plan();
        moved.plots[1].geometry.coordinates[0][1][0] = 2.0000001;
        moved.pool.coordinates[0][1][0] = 2.0000001;
        expect(record.content(moved)).not.toBe(base);
        const resourced = plan();
        resourced.plots[0].source = 'manual';
        expect(record.content(resourced)).not.toBe(base);
        const underived = plan();
        delete underived.plots[1].derivation;
        expect(record.content(underived)).not.toBe(base);
        const reordered = plan();
        reordered.plots.reverse();
        expect(record.content(reordered)).not.toBe(base);
    });

    it('refuses a layout without a pool or plots', () => {
        expect(() => record.content(null)).toThrow(/parcel layout is required/);
        expect(() => record.content({ ...plan(), plots: [] })).toThrow(/at least one plot/);
        expect(() => record.content({ ...plan(), pool: undefined })).toThrow(/layout pool needs polygon geometry/);
        expect(() => record.content({ ...plan(), plots: [{ source: 'equal' }] })).toThrow(/Plot 1 needs polygon geometry/);
    });
});
