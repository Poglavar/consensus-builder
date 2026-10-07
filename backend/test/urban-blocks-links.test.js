// Headless tests for shareable OSM block links: stable identity, bounded reload geometry, and
// controller loading independent of the current map viewport.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const links = require('../../frontend/js/urban-blocks-links.js');
const controller = require('../../frontend/js/urban-blocks-controller.js');

describe('urban block deep links', () => {
    const bbox = [2.350, 48.840, 2.352, 48.842];
    const baseUrl = 'https://example.test/proposal/123?backend=staging&lang=hr&reduceMotion=1&proposal=abc&blocks=0#section';

    it('round-trips block identity, bounds, city, and supported target size', () => {
        const url = links.build({ baseUrl, city: 'paris', blockId: 'osm-block-a13f', bbox, targetSideM: 150 });
        expect(new URL(url).pathname).toBe('/');
        expect(links.parse(url)).toEqual({ blockId: 'osm-block-a13f', bbox, targetSideM: 150, city: 'paris' });
        expect(new URL(url).searchParams.get('at')).toBe('48.841,2.351,17');
    });

    it('drops proposal path and unrelated query/hash while preserving backend and display preferences', () => {
        const url = new URL(links.build({ baseUrl, city: 'explore', blockId: 'osm-block-abc', bbox }));
        expect(url.pathname).toBe('/');
        expect(url.hash).toBe('');
        expect(url.searchParams.get('proposal')).toBeNull();
        expect(url.searchParams.get('blocks')).toBe('1');
        expect(url.searchParams.get('backend')).toBe('staging');
        expect(url.searchParams.get('lang')).toBe('hr');
        expect(url.searchParams.get('reduceMotion')).toBe('1');
        expect(url.searchParams.get('block')).toBe('osm-block-abc');
    });

    it('does not require an at parameter to parse, and defaults unsupported target sizes', () => {
        const url = new URL('https://example.test/?block=osm-block-1234&blockBounds=2,48,2.001,48.001&blockSize=999');
        expect(links.parse(url.toString())).toEqual({
            blockId: 'osm-block-1234', bbox: [2, 48, 2.001, 48.001], targetSideM: 100, city: null
        });
    });

    it.each([
        'https://example.test/?block=bad&blockBounds=2,48,2.001,48.001',
        'https://example.test/?block=osm-block-ABC&blockBounds=2,48,2.001,48.001',
        'https://example.test/?block=osm-block-123&blockBounds=2,48,2.001',
        'https://example.test/?block=osm-block-123&blockBounds=2,48,2.06,48.001',
        'https://example.test/?block=osm-block-123&blockBounds=181,48,181.001,48.001',
        'https://example.test/?block=osm-block-123&blockBounds=2,91,2.001,91.001'
    ])('rejects malformed ids or invalid bounds in %s', href => {
        expect(links.parse(href)).toBeNull();
    });

    it('refuses to build links for invalid IDs or bounds', () => {
        expect(links.build({ baseUrl, city: 'paris', blockId: 'wrong', bbox })).toBeNull();
        expect(links.build({ baseUrl, city: 'paris', blockId: 'osm-block-ab12', bbox: [2, 48, 2.06, 48.001] })).toBeNull();
    });

    it('pads valid bounds while keeping requests within world edges and the maximum span', () => {
        const padded = links.loadBounds([179.999, 89.999, 180, 90]);
        expect(padded[0]).toBeLessThan(180);
        expect(padded[2]).toBe(180);
        expect(padded[1]).toBeLessThan(90);
        expect(padded[3]).toBe(90);
        expect(padded[2] - padded[0]).toBeLessThan(0.06);
        expect(padded[3] - padded[1]).toBeLessThan(0.06);
        const maxInput = [0, 0, 0.059999, 0.059999];
        const maxPadded = links.loadBounds(maxInput);
        expect(maxPadded[2] - maxPadded[0]).toBeLessThan(0.06);
        expect(maxPadded[3] - maxPadded[1]).toBeLessThan(0.06);
        expect(links.loadBounds([0, 0, 0.06, 0.01])).toBeNull();
    });

    it('returns null for bounds that cannot be safely loaded', () => {
        for (const invalid of [null, [0, 0, 0, 1], [0, 0, 1, 1], [-181, 0, -180, 0.001], [0, -91, 0.001, -90]]) {
            expect(links.loadBounds(invalid)).toBeNull();
        }
    });
});

describe('loading a linked block through the controller', () => {
    it('loads supplied block bounds directly, without requiring a viewport zoom', async () => {
        const bbox = [2, 48, 2.002, 48.002];
        const fetchRoads = vi.fn(async bounds => ({ type: 'FeatureCollection', features: [], bounds }));
        const detect = vi.fn(async (_roads, bounds) => ({ type: 'FeatureCollection', features: [], bounds }));
        const view = controller.create({ fetchRoads, detect, onChange: vi.fn() });
        view.setEnabled(true);
        await view.loadBounds(links.loadBounds(bbox));
        expect(fetchRoads).toHaveBeenCalledWith(links.loadBounds(bbox), expect.any(AbortSignal));
        expect(detect).toHaveBeenCalledTimes(1);
        expect(view.snapshot()).toMatchObject({ phase: 'ready', coverage: links.loadBounds(bbox) });
    });
});
