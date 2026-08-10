// The urban-rule editor opening on a map of the whole world.
//
// Measured against Leaflet 1.9 with a real 240 m × 900 m block: panel 851×240 → zoom 14, panel
// 851×0 → zoom 19, panel 0×0 → zoom 19, bounds spanning the globe → zoom 0. So an unlaid-out panel
// is NOT what produces the world view; only impossible BOUNDS are — one parcel of the block carrying
// a coordinate that is not a WGS84 degree, or a null-island (0, 0) vertex that stretches the block
// from the Gulf of Guinea to Šibenik.
//
// Three things follow, and this pins all of them: impossible bounds are reported, never zoomed to;
// a parcel with impossible geometry is left out so the rest of the block still frames; and a fit
// against an unlaid-out panel is deferred rather than performed, because a map created against a
// collapsed panel caches that size and Leaflet will not re-measure it until the map has a view.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fitReadiness, shouldRetry, usableBlockFeatures, MIN_USABLE_PX, MAX_BLOCK_SPAN_DEG } =
    require('../../frontend/js/blockify-map-fit.js');
const buildingBlocks = readFileSync(
    fileURLToPath(new URL('../../frontend/js/building-blocks.js', import.meta.url)), 'utf8');

// A real Šibenik block: ~240 m × 900 m.
const BLOCK = { west: 15.89038, south: 43.73490, east: 15.89341, north: 43.74311 };

describe('when the map can be framed on its block', () => {
    it('fits a laid-out panel', () => {
        expect(fitReadiness({ width: 851, height: 240, bounds: BLOCK })).toMatchObject({ ok: true, reason: null });
    });

    it('waits while the panel has no size', () => {
        const verdict = fitReadiness({ width: 851, height: 0, bounds: BLOCK });
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('not-laid-out');
        expect(shouldRetry(verdict.reason)).toBe(true);
    });

    it('waits on a zero-width panel too', () => {
        expect(fitReadiness({ width: 0, height: 0, bounds: BLOCK }).reason).toBe('not-laid-out');
    });

    it('treats a panel of a few pixels as not laid out', () => {
        expect(fitReadiness({ width: MIN_USABLE_PX - 1, height: 500, bounds: BLOCK }).reason).toBe('not-laid-out');
        expect(fitReadiness({ width: MIN_USABLE_PX, height: MIN_USABLE_PX, bounds: BLOCK }).ok).toBe(true);
    });

    it('waits rather than fitting when the size is not a number at all', () => {
        expect(fitReadiness({ width: NaN, height: 240, bounds: BLOCK }).reason).toBe('not-laid-out');
        expect(fitReadiness({}).reason).toBe('not-laid-out');
    });
});

describe('bounds that are not a block', () => {
    it('refuses ground spanning half a degree — and does not retry it', () => {
        const verdict = fitReadiness({
            width: 851, height: 240,
            bounds: { west: 15, south: 43, east: 16.5, north: 44 }
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('span-too-large');
        expect(verdict.spanDeg).toBeCloseTo(1.5, 6);
        // Next frame it is just as wrong; retrying would only hide it.
        expect(shouldRetry(verdict.reason)).toBe(false);
    });

    it('refuses a parcel carrying projected metres instead of degrees', () => {
        // HTRS96 easting/northing read as lng/lat — the shape of a real coordinate-system mix-up.
        const verdict = fitReadiness({
            width: 851, height: 240,
            bounds: { west: 15.89, south: 43.73, east: 449684, north: 4845342 }
        });
        expect(verdict.reason).toBe('span-too-large');
    });

    it('refuses missing or unreadable bounds', () => {
        expect(fitReadiness({ width: 851, height: 240, bounds: null }).reason).toBe('no-bounds');
        expect(fitReadiness({ width: 851, height: 240, bounds: { west: 15, south: 43, east: NaN, north: 44 } }).reason)
            .toBe('no-bounds');
    });

    it('accepts a single-point block — degenerate, but not wrong', () => {
        expect(fitReadiness({ width: 851, height: 240, bounds: { west: 15.89, south: 43.73, east: 15.89, north: 43.73 } }))
            .toMatchObject({ ok: true, spanDeg: 0 });
    });

    it('states its limit rather than hiding it', () => {
        expect(MAX_BLOCK_SPAN_DEG).toBe(0.5);
    });
});

const poly = (id, ring) => ({
    type: 'Feature',
    properties: { parcelId: id },
    geometry: { type: 'Polygon', coordinates: [ring] }
});
const SIBENIK = [[15.890, 43.734], [15.893, 43.734], [15.893, 43.743], [15.890, 43.743], [15.890, 43.734]];

describe('a block with one broken parcel', () => {
    it('leaves out a parcel touching null island — the thing that stretched the block to the world', () => {
        const { usable, rejected } = usableBlockFeatures([
            poly('HR-A', SIBENIK),
            poly('HR-B', [[15.890, 43.734], [0, 0], [15.893, 43.743], [15.890, 43.734]])
        ]);
        expect(usable.map(f => f.properties.parcelId)).toEqual(['HR-A']);
        expect(rejected).toEqual([{ id: 'HR-B', reason: 'coordinates are not plausible WGS84 degrees' }]);
    });

    it('leaves out projected metres', () => {
        const { usable, rejected } = usableBlockFeatures([
            poly('HR-A', SIBENIK),
            poly('HR-HTRS', [[449684, 4845342], [449956, 4845342], [449956, 4845574], [449684, 4845342]])
        ]);
        expect(usable).toHaveLength(1);
        expect(rejected[0].id).toBe('HR-HTRS');
    });

    it('leaves out NaN, and anything that is not a polygon', () => {
        const { usable, rejected } = usableBlockFeatures([
            poly('HR-A', SIBENIK),
            poly('HR-NAN', [[15.89, NaN], [15.893, 43.734], [15.893, 43.743], [15.89, NaN]]),
            { type: 'Feature', properties: { parcelId: 'HR-POINT' }, geometry: { type: 'Point', coordinates: [15.89, 43.73] } },
            { type: 'Feature', properties: { parcelId: 'HR-NULL' }, geometry: null }
        ]);
        expect(usable.map(f => f.properties.parcelId)).toEqual(['HR-A']);
        expect(rejected.map(r => r.id).sort()).toEqual(['HR-NAN', 'HR-NULL', 'HR-POINT']);
    });

    it('keeps a MultiPolygon block whole', () => {
        const { usable, rejected } = usableBlockFeatures([{
            type: 'Feature',
            properties: { parcelId: 'HR-MULTI' },
            geometry: { type: 'MultiPolygon', coordinates: [[SIBENIK]] }
        }]);
        expect(usable).toHaveLength(1);
        expect(rejected).toEqual([]);
    });

    it('passes a healthy block through untouched', () => {
        const features = [poly('HR-A', SIBENIK), poly('HR-B', SIBENIK)];
        expect(usableBlockFeatures(features)).toEqual({ usable: features, rejected: [] });
    });
});

// The pure verdict is worthless if the editor still fits blindly, so the wiring is pinned too.
describe('the editor asks before it fits', () => {
    it('drops unusable parcels before drawing or framing the block', () => {
        const draw = buildingBlocks.slice(
            buildingBlocks.indexOf('function displayBlockOnMap('),
            buildingBlocks.indexOf('function fitBlockifyMapToBlock()')
        );
        expect(draw).toContain('fitApi.usableBlockFeatures(rawFeatures)');
        expect(draw).toContain('features: split.usable');
        expect(draw).toContain('console.error');
    });

    it('has exactly one fitBounds, and it is inside the guarded helper', () => {
        expect(buildingBlocks.match(/\.fitBounds\(/g) || []).toHaveLength(1);
        const helper = buildingBlocks.slice(
            buildingBlocks.indexOf('function fitBlockifyMapToBlock()'),
            buildingBlocks.indexOf('function watchBlockifyMapUntilFitted()')
        );
        expect(helper).toContain('fit.fitReadiness(');
        expect(helper).toContain('blockifyMap.fitBounds(bounds');
        expect(helper).toContain('invalidateSize');
    });

    it('keeps trying until a fit lands, then stops', () => {
        expect(buildingBlocks).toContain('watchBlockifyMapUntilFitted()');
        expect(buildingBlocks).toContain('new ResizeObserver');
        expect(buildingBlocks).toContain('if (blockifyMapFitted || !blockifyMap) return;');
        // ...and a resize after the fit still refreshes the cached size, or clicks and dragged
        // vertices land at the wrong latlng.
        expect(buildingBlocks).toContain('blockifyMap.invalidateSize({ animate: false });');
    });

    it('tears the observer down with the modal', () => {
        const close = buildingBlocks.slice(buildingBlocks.indexOf('function closeBlockifyModal('));
        expect(close).toContain('blockifyMapResizeObserver.disconnect()');
        expect(close).toContain('blockifyMapFitted = false;');
    });
});
