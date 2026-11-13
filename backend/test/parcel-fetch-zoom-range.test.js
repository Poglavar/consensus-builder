// The parcel zoom gate (frontend/js/parcels/utils/fetch-config.js, read by map-core's isZoomWithinParcelRange):
// the city's map.parcelZoomRange decides where parcels load and show, and the shared floor is zoom 15.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../../frontend/js/parcels/utils/fetch-config.js');
const { getZoomRange } = globalThis.ParcelFetchConfig;

describe('parcel zoom range', () => {
    afterEach(() => { delete globalThis.CityConfigManager; });

    it("takes the city's range", () => {
        globalThis.CityConfigManager = { getParcelZoomRange: () => ({ min: 17, max: Infinity }) };
        expect(getZoomRange()).toEqual({ min: 17, max: Infinity });
        globalThis.CityConfigManager = { getParcelZoomRange: () => ({ min: 15, max: 20 }) };
        expect(getZoomRange()).toEqual({ min: 15, max: 20 });
    });

    it('starts at zoom 15 when no city sets a range', () => {
        expect(getZoomRange()).toEqual({ min: 15, max: Infinity });
        globalThis.CityConfigManager = { getParcelZoomRange: () => null };
        expect(getZoomRange()).toEqual({ min: 15, max: Infinity });
    });
});
