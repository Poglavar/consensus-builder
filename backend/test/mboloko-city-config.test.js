import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(read('../../frontend/js/city-config.js'), createContext(cityContext));

describe('Mboloko city config', () => {
    const city = cityContext.CityConfigManager.getCityConfig('mboloko');

    it('uses the bounded CGS North West Erven source scope', () => {
        expect(city).toBeTruthy();
        expect(city).toMatchObject({
            id: 'mboloko',
            currency: { locale: 'en-ZA', code: 'ZAR' },
            map: {
                defaultCenter: [-25.4662366387406, 27.8447650141456],
                defaultZoom: 18
            },
            parcels: {
                strategy: 'grid',
                gridSize: 0.0025,
                source: 'parcel-source',
                sourceId: 'za-cgs-northwest-erven',
                idPrefix: 'ZA-CGS-NW-',
                ownership: false
            }
        });
        expect(city.parcels.attribution).toContain('CGS North West Erven');
        expect(city.parcels.attribution).toContain('Surveyed approved parcels');
        expect(city.parcels.attribution).toContain('Mboloko entry area verified');
        expect(city.parcels.attribution).toContain('2017-10-13');
        expect(city.parcels.attribution).toContain('currentness and registration unestablished');
        expect(city.parcels.attribution).toContain('https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/46');
    });

    it('has a city label in every supported locale', () => {
        for (const locale of ['en', 'hr', 'sr', 'es']) {
            expect(JSON.parse(read(`../../frontend/i18n/${locale}.json`)).city.labels.mboloko).toBeTruthy();
        }
    });
});
