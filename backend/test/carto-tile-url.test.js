// Verify authenticated CARTO thumbnail URLs and unchanged alternative tile providers.
import { describe, it, expect } from 'vitest';
import { expandTileUrl } from '../thumbnails/tile-stitch.js';

describe('CARTO thumbnail requests', () => {
    const template = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
    it('expands coordinates and adds the configured key', () => {
        const url = new URL(expandTileUrl(template, 4, 5, 12, 'test_key'));
        expect(url.pathname).toBe('/light_all/12/4/5.png');
        expect(url.searchParams.get('key')).toBe('test_key');
    });
    it('fails before issuing an unauthenticated CARTO request', () => {
        expect(() => expandTileUrl(template, 4, 5, 12, '')).toThrow('CARTO_BASEMAP_API_KEY');
    });
    it('preserves other query parameters and replaces an old key', () => {
        const url = new URL(expandTileUrl(template + '?foo=bar&key=old', 4, 5, 12, 'test_key'));
        expect(url.searchParams.get('foo')).toBe('bar');
        expect(url.searchParams.getAll('key')).toEqual(['test_key']);
    });
    it('leaves non-CARTO providers unchanged without needing a key', () => {
        expect(expandTileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png', 4, 5, 12, '')).
            toBe('https://tile.openstreetmap.org/12/4/5.png');
    });
});
