// The parcel zoom gate (frontend/js/parcels/utils/fetch-config.js, read by map-core's isZoomWithinParcelRange):
// the city's map.parcelZoomRange decides where parcels load and show, and the shared floor is zoom 16.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseCityConfigs } from '../../scripts/lib/city-configs.mjs';

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

    it('starts at zoom 16 when no city sets a range', () => {
        expect(getZoomRange()).toEqual({ min: 16, max: Infinity });
        globalThis.CityConfigManager = { getParcelZoomRange: () => null };
        expect(getZoomRange()).toEqual({ min: 16, max: Infinity });
    });

    it('uses zoom 16 for cities, except the measured Alatau and Hong Kong floors', () => {
        const configs = parseCityConfigs(readFileSync(new URL('../../frontend/data/city-configs.js', import.meta.url), 'utf8'));
        for (const [id, config] of Object.entries(configs)) {
            const expected = id === 'alatau' ? 15 : id === 'hong_kong' ? 17 : 16;
            expect(config.map.parcelZoomRange.min, id).toBe(expected);
        }
        expect(configs.alatau.map.initialView.zoom).toBe(18);
        expect(configs.alatau.map.defaultZoom).toBe(18);
    });
});
