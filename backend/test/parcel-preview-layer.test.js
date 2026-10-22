// The parcel preview layer's pure part: which previewed parcels are new and inside the view.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const source = readFileSync(path.join(REPO, 'frontend/js/parcels/preview-layer.js'), 'utf8');

function load() {
    const window = { addEventListener: () => {} };
    vm.runInNewContext(source, { window, globalThis: window, Map, Array, Infinity, Math, Object });
    return window.ParcelPreview;
}
const square = (id, lon, lat, size = 0.0001, preview = true) => ({ type: 'Feature', id, properties: { id, preview },
    geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]] } });

describe('parcel preview layer', () => {
    it('adds each previewed parcel once, inside the view only, and never a resolved parcel', () => {
        const preview = load();
        const known = new Map();
        const inside = square('A', 0.0001, 51.0001), again = square('A', 0.0001, 51.0001);
        const outside = square('B', 0.5, 51.5), resolved = square('C', 0.0002, 51.0002, 0.0001, false);
        expect(preview.mergePreview(known, [inside, outside, resolved], [0, 51, 0.001, 51.001]).map(f => f.id)).toEqual(['A']);
        expect(preview.mergePreview(known, [again], [0, 51, 0.001, 51.001])).toEqual([]);
        expect(known.size).toBe(1);
    });
    it('without a view every previewed parcel counts, and a parcel touching the view edge is inside', () => {
        const preview = load();
        expect(preview.mergePreview(new Map(), [square('A', 0.5, 51.5)]).length).toBe(1);
        expect(preview.boundsOverlap(square('A', 0.001, 51.001), [0, 51, 0.001, 51.001])).toBe(true);
        expect(preview.boundsOverlap(square('A', 0.0011, 51.001), [0, 51, 0.001, 51.001])).toBe(false);
    });
    it('shows nothing without a map and reports its count', () => {
        const preview = load();
        expect(preview.show([square('A', 0.0001, 51.0001)], [0, 51, 0.001, 51.001])).toBe(1);
        expect(preview.count()).toBe(1);
        preview.clear();
        expect(preview.count()).toBe(0);
    });
});
