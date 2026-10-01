// The selection tray's count and total area (frontend/js/ui/selection-tray.js summarizeSelection):
// every selected parcel counts, only measurable ones add area, and an unknown total is null, not 0.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeSelection } = require('../../frontend/js/ui/selection-tray.js');

const features = {
    a: { geometry: { type: 'Polygon' }, area: 400 },
    b: { geometry: { type: 'Polygon' }, area: 250.5 },
    nogeom: { geometry: null, area: null },
    nan: { geometry: { type: 'Polygon' }, area: NaN },
    negative: { geometry: { type: 'Polygon' }, area: -3 },
    throws: { geometry: { type: 'Polygon' }, area: 'throw' }
};
const featureFor = id => features[id] || null;
const areaOf = feature => {
    if (feature.area === 'throw') throw new Error('bad ring');
    return feature.area;
};

describe('selection tray summary', () => {
    it('counts the parcels and sums their measured area', () => {
        expect(summarizeSelection(['a', 'b'], { featureFor, areaOf })).toEqual({ count: 2, area: 650.5, unmeasured: 0 });
    });

    it('counts parcels it cannot measure without adding anything for them', () => {
        expect(summarizeSelection(['a', 'missing', 'nogeom', 'nan', 'negative', 'throws'], { featureFor, areaOf }))
            .toEqual({ count: 6, area: 400, unmeasured: 5 });
    });

    it('reports an unknown total as null, never 0', () => {
        expect(summarizeSelection(['missing', 'nan'], { featureFor, areaOf })).toEqual({ count: 2, area: null, unmeasured: 2 });
        expect(summarizeSelection(['a'], { featureFor })).toEqual({ count: 1, area: null, unmeasured: 1 });
        expect(summarizeSelection([], { featureFor, areaOf })).toEqual({ count: 0, area: null, unmeasured: 0 });
    });

    it('survives no selection and no collaborators', () => {
        expect(summarizeSelection(null)).toEqual({ count: 0, area: null, unmeasured: 0 });
        expect(summarizeSelection(['a', 'b'])).toEqual({ count: 2, area: null, unmeasured: 2 });
    });
});
