// Thumbnail framing for proposals anywhere on the globe: the shared bbox rule
// (frontend/js/thumbnail-bbox.js) and the server renderer's framing of real site-based records.
// Regression: a "swapped lat/lng" guess turned every bbox east of 90°E (an explore-mode Tokyo
// subdivision) into an invalid one, so neither the browser nor the server could draw it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { computeStitchFrame } from '../thumbnails/tile-stitch.js';
import { buildThumbnailRenderOptions, resolveProposalPolygon } from '../thumbnails/proposal-thumbnail.js';

const require = createRequire(import.meta.url);
const bboxApi = require('../../frontend/js/thumbnail-bbox.js');

// The site of a real explore-mode park in Tokyo (local record 1349), GeoJSON [lng, lat].
const TOKYO_RING = [
    [139.710248708725, 35.66602186357384], [139.70885396003726, 35.66602186357384],
    [139.70885396003726, 35.66536812922553], [139.710248708725, 35.66536812922553],
    [139.710248708725, 35.66602186357384]
];
const TOKYO_SITE = { type: 'MultiPolygon', coordinates: [[TOKYO_RING]] };
const ZAGREB_RING = [[15.977, 45.81], [15.9775, 45.81], [15.9775, 45.8104], [15.977, 45.8104], [15.977, 45.81]];

describe('thumbnail bbox rule', () => {
    it('reads GeoJSON [lng, lat] positions at any nesting depth', () => {
        expect(bboxApi.bboxOfLngLat([[TOKYO_RING]])).toEqual({
            lngMin: 139.70885396003726, lngMax: 139.710248708725,
            latMin: 35.66536812922553, latMax: 35.66602186357384
        });
    });

    it('accepts real boxes in every quadrant, including east of 90°E and west of 90°W', () => {
        for (const ring of [TOKYO_RING, ZAGREB_RING, [[-118.25, 34.05], [-118.24, 34.06]], [[151.2, -33.87], [151.21, -33.86]], [[45.03, 12.78], [45.04, 12.79]]]) {
            expect(() => bboxApi.assertValidBbox(bboxApi.bboxOfLngLat(ring))).not.toThrow();
        }
    });

    it('fails loudly, with the values, on a swapped Tokyo box instead of re-guessing it', () => {
        const swapped = bboxApi.bboxOfLngLat(TOKYO_RING.map(([lng, lat]) => [lat, lng]));
        expect(() => bboxApi.assertValidBbox(swapped, 'test')).toThrow(/latitude outside.*"latMax":139\.71/);
    });

    it('rejects spans wider than one proposal can be, and empty input', () => {
        expect(() => bboxApi.assertValidBbox(bboxApi.bboxOfLngLat([[15.97, 45.8], [45.8, 15.97]]))).toThrow(/spans more than/);
        expect(() => bboxApi.assertValidBbox(bboxApi.bboxOfLngLat([]))).toThrow(/no finite coordinates/);
        expect(bboxApi.bboxProblem(null)).toBe('no bbox');
    });

    it('flattens polygon coordinates into [lng, lat] points without reordering', () => {
        expect(bboxApi.lngLatPointsOf(TOKYO_SITE.coordinates).slice(0, 2)).toEqual(TOKYO_RING.slice(0, 2));
        expect(bboxApi.lngLatPointsOf([[ZAGREB_RING]])[0]).toEqual([15.977, 45.81]);
    });
});

describe('server framing of site-based records', () => {
    it('frames a Tokyo polygon (lng > 90) where it is, not swapped', () => {
        const frame = computeStitchFrame({ polygon: [TOKYO_RING], polygonOrder: 'lnglat', padding: 0 });
        expect(frame.lngMin).toBeCloseTo(139.70885396, 6);
        expect(frame.latMax).toBeCloseTo(35.66602186, 6);
    });

    it('throws with the offending values for a bad bbox', () => {
        expect(() => computeStitchFrame({ polygon: [[[15.97, 45.8], [45.8, 15.97], [16, 46]]], polygonOrder: 'lnglat' }))
            .toThrow(/spans more than.*lngMin/);
    });

    it('a site-only proposal (no parcels, no other geometry) is framed by its site', async () => {
        const proposal = { goal: 'reparcellization', site: TOKYO_SITE, cadastreParcelIds: [] };
        expect(resolveProposalPolygon(proposal)).toMatchObject({ polygon: [TOKYO_RING], polygonOrder: 'lnglat' });
        const options = await buildThumbnailRenderOptions(null, proposal, 'explore');
        const frame = computeStitchFrame(options);
        expect(frame.lngMin).toBeLessThan(139.70885396);
        expect(frame.lngMax).toBeGreaterThan(139.71024870);
        expect(frame.latMin).toBeGreaterThan(35.6);
    });

    it('a real explore park record (structure geometry + site) renders its frame', async () => {
        const proposal = { goal: 'park', site: TOKYO_SITE, structureProposal: { geometry: { type: 'Polygon', coordinates: [TOKYO_RING] } }, cadastreParcelIds: [] };
        const frame = computeStitchFrame(await buildThumbnailRenderOptions(null, proposal, 'explore'));
        expect(frame.lngMin).toBeGreaterThan(139);
        expect(frame.latMin).toBeLessThan(36);
    });
});
