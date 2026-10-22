// HMLR tile rows must decode to exactly the feature the GML reader produced, including rare
// coordinates finer than a millimetre, and parcels must land in every tile their box touches.
import { describe, expect, it } from 'vitest';
import { decodeTileRow, encodeTileRow, idBucket, indexShardKey, tileRange } from '../parcels/hmlr-tile-format.js';

const feature = (id, geometry) => ({ type: 'Feature', id, properties: { INSPIREID: id }, geometry });
const ring = [[417000.87, 293128.49], [417001.27, 293122.79], [417004.602, 293067.144], [417000.87, 293128.49]];

describe('HMLR tile format', () => {
    it('round-trips millimetre coordinates through integer deltas, for polygons and multipolygons', () => {
        for (const geometry of [{ type: 'Polygon', coordinates: [ring] },
            { type: 'MultiPolygon', coordinates: [[ring], [ring.map(([x, y]) => [x + 50, y - 20.001])]] }]) {
            const { row, raw } = encodeTileRow(feature('0012345', geometry));
            expect(raw).toBe(false);
            expect(row[0]).toBe('12345');
            const back = decodeTileRow(JSON.parse(JSON.stringify(row)));
            expect(JSON.stringify(back.geometry)).toBe(JSON.stringify(geometry));
            expect(back.properties.INSPIREID).toBe('12345');
        }
    });
    it('keeps a row with sub-millimetre coordinates raw instead of rounding it', () => {
        const fine = { type: 'Polygon', coordinates: [[[417000.8765, 293128.49], [417001.27, 293122.79], [417004.6, 293067.1], [417000.8765, 293128.49]]] };
        const { row, raw } = encodeTileRow(feature('7', fine));
        expect(raw).toBe(true);
        expect(decodeTileRow(JSON.parse(JSON.stringify(row))).geometry).toEqual(fine);
    });
    it('covers every 1 km tile the box touches and names index and ID shards', () => {
        const { bbox } = encodeTileRow(feature('1', { type: 'Polygon', coordinates: [ring] }));
        expect(tileRange(bbox)).toEqual([417, 293, 417, 293]);
        expect(tileRange([416999.5, 292000, 418000, 293999.9])).toEqual([416, 292, 418, 293]);
        expect(indexShardKey(417, 293)).toBe('41_29');
        expect(idBucket('123456')).toBe('1234');
        expect(idBucket('12')).toBe('12');
    });
    it('rejects malformed rows', () => {
        expect(() => decodeTileRow(['x', 0, []])).toThrow();
        expect(() => decodeTileRow(['1', 3, []])).toThrow();
    });
});
