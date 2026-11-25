// A city admitted on a source whose coverage names a boundary dataset (HM Land Registry: the ONS
// districts) is written with its administrative extent (scripts/admit-qualified-cities.mjs).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { admissionExtent, cityConfigEntry } from '../../scripts/admit-qualified-cities.mjs';
import { extentAreaFor, extentRings, loadBoundaries, parseCityConfigs } from '../../scripts/build-world-coverage.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8')).sources;
const hmlr = catalog.find(source => source.id === 'gb-hmlr-browser-v1');
const boundaries = loadBoundaries();
const item = (name, lat, lon, catalogSource = hmlr) => ({ appCityId: name.toLowerCase(), name, center: [lat, lon], catalogSource });
const extentOf = (...args) => admissionExtent(item(...args), { boundaries, extentAreaFor });

describe('admission extent', () => {
    it('names the HM Land Registry coverage dataset', () => {
        expect(hmlr.coverage).toMatchObject({ type: 'regions', regions: ['GB-ENG', 'GB-WLS'], extents: 'ons-lad-2023' });
    });

    it('takes the district named after the city, wherever its settlement locator fell', () => {
        expect(extentOf('Brighton', 50.832718747559, -0.232087060115579)).toEqual({ dataset: 'ons-lad-2023', areas: ['E06000043'] }); // locator in Adur
        expect(extentOf('Manchester', 53.4932710593779, -2.25653313803415)).toEqual({ dataset: 'ons-lad-2023', areas: ['E08000003'] }); // locator in Salford
        expect(extentOf('Cardiff', 51.4942, -3.1837)).toEqual({ dataset: 'ons-lad-2023', areas: ['W06000015'] });
    });

    it('else the district holding its centre', () => {
        expect(extentOf('Kidderminster', 52.3867, -2.2504)).toEqual({ dataset: 'ons-lad-2023', areas: ['E07000239'] }); // Wyre Forest
        expect(extentOf('Nowhere', 55.95, -3.19)).toBeNull(); // Edinburgh: no English or Welsh district
    });

    it('leaves a source without an extent dataset on its circle', () => {
        const other = catalog.find(source => source.id === 'fr-ign-parcellaire-express');
        expect(extentOf('Lyon', 45.764, 4.8357, other)).toBeNull();
    });

    it('writes the extent into the config entry, where the coverage build reads it', () => {
        const entry = cityConfigEntry({ ...item('Brighton', 50.82404, -0.14265), appCityId: 'brighton_test', code: '1', label: 'Brighton, United Kingdom',
            currency: { locale: 'en-GB', code: 'GBP' }, descriptor: hmlr, extent: extentOf('Brighton', 50.82404, -0.14265) });
        const [parsed] = parseCityConfigs(`const CITY_CONFIGS = {\n${entry}\n    };`);
        expect(parsed).toMatchObject({ id: 'brighton_test', cadastre: 'gb-hmlr-browser-v1', extent: { dataset: 'ons-lad-2023', areas: ['E06000043'] } });
        expect(extentRings(boundaries[parsed.extent.dataset], parsed.extent.areas).length).toBeGreaterThan(0);
        // Without one the entry is as before.
        expect(cityConfigEntry({ ...item('Lyon', 45.764, 4.8357), code: '2', label: 'Lyon, France', currency: { locale: 'fr-FR', code: 'EUR' }, descriptor: hmlr }))
            .not.toMatch(/extent:/);
    });
});
