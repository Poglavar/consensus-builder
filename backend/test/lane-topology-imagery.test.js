import { describe, expect, it } from 'vitest';
import {
    LANE_IMAGERY_SOURCES,
    fetchImageryCrop,
    imageryCropSpec,
    withinImageryCoverage,
    publicImagerySource,
    resolveImagerySource
} from '../lane-topology/imagery.js';

const SAVSKA_BBOX = [15.9610346, 45.7979133, 15.9622577, 45.7986894];

describe('lane topology orthophoto evidence', () => {
    it('publishes the reusable high-resolution Zagreb source with provenance', () => {
        const source = resolveImagerySource('zagreb_cdof_2022');
        expect(source).toBe(LANE_IMAGERY_SOURCES.zagreb_cdof_2022);
        expect(publicImagerySource(source)).toEqual(expect.objectContaining({
            label: 'City of Zagreb CDOF 2022',
            capturedAt: '2022',
            nativeGsdM: 0.15,
            wmsLayer: 'ZG_CDOF2022'
        }));
    });

    it('requests a north-up, bounded WMS crop and reports its effective resolution', () => {
        const spec = imageryCropSpec(
            LANE_IMAGERY_SOURCES.zagreb_cdof_2022,
            SAVSKA_BBOX
        );
        const url = new URL(spec.url);

        expect(spec.width).toBeGreaterThan(500);
        expect(spec.height).toBeGreaterThan(500);
        expect(Math.max(spec.width, spec.height)).toBeLessThanOrEqual(2048);
        expect(spec.effectiveGsdM).toBeCloseTo(0.15, 2);
        expect(spec.northUp).toBe(true);
        expect(url.searchParams.get('SRS')).toBe('EPSG:4326');
        expect(url.searchParams.get('BBOX')).toBe(SAVSKA_BBOX.join(','));
        expect(url.searchParams.get('LAYERS')).toBe('ZG_CDOF2022');
    });

    it('caps large viewports and makes the lost image resolution explicit', () => {
        const spec = imageryCropSpec(
            LANE_IMAGERY_SOURCES.zagreb_cdof_2022,
            [15.94, 45.79, 16.02, 45.83]
        );
        expect(Math.max(spec.width, spec.height)).toBe(2048);
        expect(spec.effectiveGsdM).toBeGreaterThan(1);
    });

    it('fetches image bytes while rejecting non-image WMS responses', async () => {
        const good = await fetchImageryCrop(
            LANE_IMAGERY_SOURCES.zagreb_cdof_2022,
            SAVSKA_BBOX,
            {
                fetchImpl: async () => new Response(Buffer.from([0xff, 0xd8, 0xff]), {
                    status: 200,
                    headers: { 'content-type': 'image/png' }
                })
            }
        );
        expect(good.buffer).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(good.contentType).toBe('image/jpeg');
        expect(good.metadata.url).toBeUndefined();
        expect(good.metadata.byteLength).toBe(3);

        await expect(fetchImageryCrop(
            LANE_IMAGERY_SOURCES.zagreb_cdof_2022,
            SAVSKA_BBOX,
            {
                fetchImpl: async () => new Response('<ServiceException>bad layer</ServiceException>', {
                    status: 200,
                    headers: { 'content-type': 'text/xml' }
                })
            }
        )).rejects.toThrow('text/xml');
    });

    // Outside its extent this WMS answers 200 with a SOLID WHITE image — not an error, not
    // transparency. As a map layer that blanks the screen with no explanation; as model input it is
    // a blank photograph that a recognition run would confidently describe. The point that found
    // it was 900 m west of the western edge, near Jastrebarsko.
    describe('coverage', () => {
        const source = LANE_IMAGERY_SOURCES.zagreb_cdof_2022;

        it('carries the extent the server itself declares', () => {
            // From the WMS GetCapabilities LatLonBoundingBox, not a guess at the city limits.
            expect(source.bounds).toEqual([15.7643127, 45.6055652, 16.2692342, 45.9855807]);
        });

        it('rejects a bbox wholly outside it', () => {
            // The Jastrebarsko viewport: west of the coverage, and it blanked the whole map.
            expect(withinImageryCoverage(source, [15.7519, 45.6730, 15.7539, 45.6745])).toBe(false);
        });

        it('accepts one inside it, and one that merely overlaps the edge', () => {
            expect(withinImageryCoverage(source, [15.9780, 45.8070, 15.9800, 45.8085])).toBe(true);
            // Straddling the western edge still has imagery in part of it.
            expect(withinImageryCoverage(source, [15.7600, 45.6730, 15.7700, 45.6800])).toBe(true);
        });

        it('does not gate a source that declares no extent', () => {
            expect(withinImageryCoverage({ key: 'x' }, [0, 0, 1, 1])).toBe(true);
        });
    });
});
