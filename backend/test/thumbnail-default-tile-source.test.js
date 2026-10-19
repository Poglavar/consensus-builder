// Server thumbnails must use the keyed MapTiler 256px raster: keyless Carto tiles are watermarked
// "API KEY REQUIRED", and a missing key must fail loudly instead of rendering a blank basemap.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTileUrl } from '../thumbnails/tile-stitch.js';

const saved = process.env.MAPTILER_API_KEY;
afterEach(() => {
    if (saved === undefined) delete process.env.MAPTILER_API_KEY;
    else process.env.MAPTILER_API_KEY = saved;
});

describe('default thumbnail tile source', () => {
    it('uses the MapTiler basic-v2 256px raster with the configured key', () => {
        process.env.MAPTILER_API_KEY = 'test-key';
        const url = defaultTileUrl();
        expect(url).toBe('https://api.maptiler.com/maps/basic-v2/256/{z}/{x}/{y}.png?key=test-key');
        expect(url).not.toContain('cartocdn');
    });

    it('throws when no key is configured', () => {
        delete process.env.MAPTILER_API_KEY;
        expect(() => defaultTileUrl()).toThrow(/MAPTILER_API_KEY/);
    });
});
