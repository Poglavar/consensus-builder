// World-view coverage lookups (frontend/js/world/world-coverage.js) against the committed
// frontend/data/world-coverage.json: tier at a point and place search.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const WorldCoverage = require(path.join(REPO, 'frontend/js/world/world-coverage.js'));
const data = JSON.parse(readFileSync(path.join(REPO, 'frontend/data/world-coverage.json'), 'utf8'));
const coverage = WorldCoverage.create(data);

describe('liveSummary', () => {
    it('counts configured live cities and countries, excluding registry-only city and country entries', () => {
        const sample = WorldCoverage.create({
            countries: [
                { cc: 'AA', name: 'Live country', tier: 'live', coverage: 'partial', rings: [] },
                { cc: 'BB', name: 'Registry source country', tier: 'source', coverage: 'partial', rings: [] },
                { cc: 'CC', name: 'Registry live country', tier: 'live', coverage: 'full', rings: [] }
            ],
            cities: [
                { id: 'registry-source', name: 'Source City', cc: 'BB', tier: 'source', lat: 0, lon: 0, note: '' },
                { id: 'registry-live', name: 'Registry City', cc: 'CC', tier: 'live', lat: 1, lon: 1, note: '' }
            ],
            liveCities: [
                { id: 'configured-1', name: 'Configured One', cc: 'AA', lat: 10, lon: 10 },
                { id: 'configured-2', name: 'Configured Two', cc: 'AA', lat: 20, lon: 20 }
            ]
        });

        expect(sample.liveSummary).toEqual({ cityCount: 2, countryCount: 1 });
    });

    it('deduplicates live city IDs and country codes and ignores empty values', () => {
        const sample = WorldCoverage.create({
            countries: [],
            cities: [],
            liveCities: [
                { id: 'same-city', cc: 'AA' },
                { id: 'same-city', cc: 'AA' },
                { id: ' same-city ', cc: ' AA ' },
                { id: 'other-city', cc: 'AA' },
                { id: 'third-city', cc: 'BB' },
                { id: '', cc: '' },
                { id: '   ', cc: '  ' }
            ]
        });

        expect(sample.liveSummary).toEqual({ cityCount: 3, countryCount: 2 });
        expect(Object.isFrozen(sample.liveSummary)).toBe(true);
    });

    it('returns zero counts when there are no configured live cities', () => {
        const sample = WorldCoverage.create({ countries: [], cities: [], liveCities: [] });
        expect(sample.liveSummary).toEqual({ cityCount: 0, countryCount: 0 });
    });
});

describe('tierAt', () => {
    it.each([
        ['sydney', 'au-nsw-six-cadastre-lot', -33.8585, 151.0795, 'Sydney', -33.8585, 151.4],
        ['sao_paulo', 'br-sp-geosampa-lote-cidadao', -23.55052, -46.6333, 'São Paulo', -23.55052, -46.3],
        ['birmingham', 'gb-arcgis-geodom-land-registry-inspire-2021', 52.4975, -1.978, 'Birmingham', 52.4975, -1.6],
        ['lusaka', 'zm-lusaka-mtendere-east-agol-unofficial', -15.40478133, 28.38004999, 'Lusaka', -15.40478133, 28.8],
        ['osaka', 'jp-moj-geospatial-2026', 34.677750586, 135.532507321, 'Osaka', 34.67775, 135.9],
        ['tokyo', 'jp-moj-geospatial-2026', 35.696623934, 139.766899192, 'Tokyo', 35.44, 139.64],
        ['nagoya', 'jp-moj-geospatial-2026', 35.163716454, 136.984010139, 'Nagoya', 35.16, 137.3],
        ['los_angeles', 'us-ca-lacounty-assessor-parcels', 34.0522, -118.2437, 'Los Angeles', 33.74, -117.88],
        ['miami', 'us-fl-miamidade-pa-parcels', 25.7749, -80.1936, 'Miami', 26.12, -80.14],
        ['washington_dc', 'us-dc-dcgis-tax-lots', 38.91025, -77.0425, 'Washington', 38.89, -77.08],
        ['cotonou', 'bj-andf-efoncier-geoserver', 6.38646680667236, 2.3895186609943, 'Cotonou', 6.38, 2.8],
        ['dortmund', 'de-nrw-lika-flurstueck', 51.51494, 7.466, 'Dortmund', 51.51494, 7.8],
        ['bamako', 'ml-sprdf-ninacad-parcelle-wfs', 12.6765, -8.04225, 'Bamako', 12.8, -8.04],
        ['luanda', 'ao-arcgis-luanda-agt-property-polygons', -8.83675, 13.234, 'Luanda', -9.05, 13.23],
        ['lima', 'pe-sedapal-publicaciones-lotes', -12.015, -76.96825, 'Lima', -12.2, -76.97],
        ['lyon', 'fr-ign-parcellaire-express', 45.764, 4.8357, 'Lyon', 45.764, 5.15],
        ['rotterdam', 'nl-pdok-brk-kadastrale-kaart', 51.9225, 4.4792, 'Rotterdam', 51.9225, 4.8],
        ['cologne', 'de-nrw-lika-flurstueck', 50.9375, 6.9603, 'Cologne', 50.9375, 7.3],
        ['paris', 'fr-ign-parcellaire-express', 48.8491, 2.3556, 'Paris', 48.85, 2.7],
        ['melbourne', 'au-vic-vicmap-parcel', -37.8136, 144.9631, 'Melbourne', -38.15, 144.96],
        ['hong_kong', 'hk-landsd-lot-index-api', 22.315, 114.1838, 'Hong Kong', 22.54, 114.06],
        ['berlin', 'de-be-alkis-flurstuecke-wfs', 52.52, 13.405, 'Berlin', 52.39, 13.07],
        ['essen', 'de-nrw-lika-flurstueck', 51.4556, 7.0123, 'Essen', 52.52, 13.405],
        ['san_francisco', 'us-ca-sf-datasf-active-parcels', 37.79125, -122.4065, 'San Francisco', 37.8, -122.27],
        ['antwerp', 'be-vlaanderen-grb-adp', 51.2110, 4.4010, 'Antwerp', 50.85, 4.35],
        ['amsterdam', 'nl-pdok-brk-kadastrale-kaart', 52.3725, 4.9000, 'Amsterdam', 52.37, 5.25],
        ['cape_town', 'za-cct-land-parcels', -33.9258, 18.4194, 'Cape Town', -33.9258, 18.75],
        ['montreal', 'ca-qc-cadastre-bd-allegee', 45.50375, -73.569, 'Montreal', 45.50375, -73.4]
    ])('routes %s through its source and respects its bounded entry area', (cityId, sourceId, lat, lon, name, outsideLat, outsideLon) => {
        expect(coverage.tierAt(lat, lon)).toMatchObject({ kind: 'live-city', cityId, sourceId });
        expect(coverage.searchPlaces(name)[0]).toMatchObject({ cityId, sourceId });
        expect(coverage.tierAt(outsideLat, outsideLon).cityId).not.toBe(cityId);
    });

    it('opens Bogotá through its source and keeps neighbouring municipalities outside the entry area', () => {
        expect(coverage.tierAt(4.60975, -74.08175)).toMatchObject({ kind: 'live-city', cityId: 'bogota', sourceId: 'co-bogota-uaecd-lote' });
        expect(coverage.searchPlaces('bogota')[0]).toMatchObject({ cityId: 'bogota', sourceId: 'co-bogota-uaecd-lote', dataVersion: '2021-12' });
        expect(coverage.tierAt(4.58, -74.22).cityId).not.toBe('bogota');
    });
    it('opens the Toronto streaming source and respects its limited entry area', () => {
        expect(coverage.tierAt(43.6535, -79.3825)).toMatchObject({ kind: 'live-city', cityId: 'toronto', sourceId: 'ca-on-toronto-property-boundary' });
        expect(coverage.searchPlaces('toronto')[0]).toMatchObject({ cityId: 'toronto', sourceId: 'ca-on-toronto-property-boundary' });
        expect(coverage.tierAt(43.85, -79.32).cityId).not.toBe('toronto');
        expect(coverage.tierAt(43.59, -79.64).cityId).not.toBe('toronto');
    });
    it('opens a configured city near its centre', () => {
        const place = coverage.tierAt(45.83, 16.05); // eastern Zagreb, a few km from the centre
        expect(place).toMatchObject({ kind: 'live-city', tier: 'live', cityId: 'zagreb', cc: 'HR', country: 'Croatia' });
    });

    it('treats Croatia as live and full coverage, opening the nearest Croatian city', () => {
        const osijek = coverage.tierAt(45.55, 18.69);
        expect(osijek).toMatchObject({ kind: 'country', tier: 'live', cc: 'HR', cityId: 'zagreb' });
        const dubrovnik = coverage.tierAt(42.65, 18.09);
        expect(dubrovnik.tier).toBe('live');
        expect(['split', 'sibenik']).toContain(dubrovnik.cityId);
        expect(coverage.searchPlaces('Croatia')[0]).toMatchObject({
            kind: 'country', cc: 'HR', tier: 'live', coverage: 'full',
            coverageSources: expect.arrayContaining([expect.objectContaining({
                url: 'https://catalog.uredjenazemlja.hr/katalogpodataka/atom-usluga-preuzimanja-dkp-a'
            })])
        });
    });

    it('keeps Serbia partial while Belgrade still resolves to its single configured live entry', () => {
        expect(coverage.searchPlaces('Serbia')[0]).toMatchObject({
            kind: 'country', cc: 'RS', tier: 'source', coverage: 'partial'
        });
        const belgradeHits = coverage.searchPlaces('Belgrade');
        expect(belgradeHits).toHaveLength(1);
        expect(belgradeHits[0]).toMatchObject({ kind: 'live-city', cityId: 'belgrade', cc: 'RS' });
    });

    it('shows Sarajevo as unknown with the city-specific access note', () => {
        expect(coverage.searchPlaces('Sarajevo')).toMatchObject([{
            kind: 'city', tier: 'unknown', cc: 'BA', placeKey: 'geonames:3191281', lat: 43.8486, lon: 18.3564,
            note: expect.stringMatching(/sign-in.*inconclusive|inconclusive.*sign-in/i)
        }]);
    });

    it('opens Tokyo through its configured partial-ward entry', () => {
        expect(coverage.tierAt(35.696623934, 139.766899192)).toMatchObject({ kind: 'live-city', tier: 'live', name: 'Tokyo', cc: 'JP', placeKey: 'live:tokyo' });
    });

    it('marks Jakarta as researched with nothing open', () => {
        expect(coverage.tierAt(-6.2, 106.85)).toMatchObject({ kind: 'city', tier: 'none', name: 'Jakarta' });
    });

    it('returns unknown ocean in the mid-Atlantic', () => {
        expect(coverage.tierAt(30, -40)).toMatchObject({ kind: 'ocean', tier: 'unknown', cc: null, placeKey: 'point:30.0,-40.0' });
    });

    it('falls back to the country polygon away from any city', () => {
        const kansas = coverage.tierAt(38.5, -98.5);
        expect(kansas).toMatchObject({ kind: 'country', cc: 'US', tier: 'source', placeKey: 'country:US' });
        const siberia = coverage.tierAt(62, 100);
        expect(siberia).toMatchObject({ kind: 'country', cc: 'RU' });
    });

    it('prefers a live city over a registry city at the same place', () => {
        expect(coverage.tierAt(40.71, -74.0)).toMatchObject({ tier: 'live', cityId: 'new_york' });
    });

    it('rejects non-numeric input rather than returning a real-looking place', () => {
        expect(() => coverage.tierAt(null, 10)).toThrow();
        expect(() => coverage.tierAt(Number.NaN, 10)).toThrow();
    });
});

describe('country coverage axis', () => {
    const scopeSources = [{ title: 'National parcel scope', url: 'https://scope.example.test/national' }];
    const sample = WorldCoverage.create({
        schemaVersion: 1,
        countries: [{
            cc: 'AA', name: 'Sampleland', tier: 'live', coverage: 'partial', note: 'Verified in some regions',
            coverageSources: scopeSources, center: [0.5, 0.5], rings: [[0, 0, 1, 0, 1, 1, 0, 1, 0, 0]]
        }],
        cities: [], liveCities: []
    });

    it('carries geographic coverage and its evidence into country point hits and search results', () => {
        const point = sample.tierAt(0.5, 0.5);
        const search = sample.searchPlaces('Sampleland')[0];
        expect(point).toMatchObject({ kind: 'country', tier: 'live', coverage: 'partial', coverageSources: scopeSources });
        expect(search).toMatchObject({ kind: 'country', tier: 'live', coverage: 'partial', coverageSources: scopeSources });
    });

    it.each(['full', 'partial', 'none', 'unknown'])('uses the %s coverage label for country places', coverageLevel => {
        expect(WorldCoverage.statusKey({ kind: 'country', tier: 'live', coverage: coverageLevel })).toBe(`world.coverage.${coverageLevel}`);
    });

    it('keeps city and live-city labels on their operational tier', () => {
        expect(WorldCoverage.statusKey({ kind: 'city', tier: 'source', coverage: 'full' })).toBe('world.tier.source');
        expect(WorldCoverage.statusKey({ kind: 'live-city', tier: 'live', coverage: 'unknown' })).toBe('world.tier.live');
    });
});

describe('searchPlaces', () => {
    it('is diacritic-insensitive both ways', () => {
        expect(coverage.searchPlaces('sibenik')[0]).toMatchObject({ kind: 'live-city', cityId: 'sibenik', name: 'Šibenik' });
        expect(coverage.searchPlaces('São')[0].name).toBe('São Paulo');
        expect(coverage.searchPlaces('sao paulo')[0].name).toBe('São Paulo');
    });

    it('ranks prefix matches above substrings and configured cities above others', () => {
        const hits = coverage.searchPlaces('bel');
        expect(hits[0]).toMatchObject({ kind: 'live-city', cityId: 'belgrade' });
        const idx = name => hits.findIndex(h => h.name === name);
        if (idx('Belgium') >= 0) expect(idx('Belgium')).toBeGreaterThan(0);
    });

    it('finds countries with a flyable centre', () => {
        const japan = coverage.searchPlaces('japan')[0];
        expect(japan).toMatchObject({ kind: 'country', cc: 'JP', tier: 'source' });
        expect(Number.isFinite(japan.lat) && Number.isFinite(japan.lon)).toBe(true);
    });

    it('does not list a registry duplicate of a configured city', () => {
        const names = coverage.searchPlaces('new york').map(h => h.name);
        expect(names[0]).toBe('New York');
        expect(names).not.toContain('New York City');
    });

    it('returns nothing for an empty query and honours the limit', () => {
        expect(coverage.searchPlaces('   ')).toEqual([]);
        expect(coverage.searchPlaces('a', { limit: 3 })).toHaveLength(3);
    });
});

// The explore city chip's name (js/ui/world-entry.js): where the map is, from local data only.
describe('nameAt (the explore chip)', () => {
    it('names the city the map is on', () => {
        expect(coverage.nameAt(35.68, 139.76, 14)).toMatchObject({ kind: 'city', name: 'Tokyo', cc: 'JP' });
        expect(coverage.nameAt(45.81, 15.97, 14)).toMatchObject({ kind: 'city', name: 'Zagreb', cc: 'HR' });
    });

    it('falls back to the country away from any registry city (Yokohama is not Tokyo)', () => {
        expect(coverage.nameAt(35.44, 139.64, 14)).toMatchObject({ kind: 'country', name: 'Japan', cc: 'JP' });
        // A bounded configured entry does not advertise its city at Yokohama.
        expect(coverage.tierAt(35.44, 139.64)).toMatchObject({ kind: 'country', name: 'Japan' });
    });

    it('has no name on open water or for a continent-wide view (the default world view is over Libya)', () => {
        expect(coverage.nameAt(34.5, 141.5, 10)).toEqual({ kind: 'ocean', name: '', cc: null });
        expect(coverage.nameAt(30, 15, 3)).toEqual({ kind: 'world', name: '', cc: null });
        expect(coverage.nameAt(30, 15, 8)).toMatchObject({ kind: 'country', name: 'Libya' });
    });

    it('refuses a non-finite point', () => {
        expect(() => coverage.nameAt(NaN, 1, 10)).toThrow(/finite/);
    });

    it('the chip is renamed from nameAt on every settled move, not once at boot', () => {
        const source = readFileSync(path.join(REPO, 'frontend/js/ui/world-entry.js'), 'utf8');
        expect(source).toMatch(/state\.explorePlace = place;/);
        expect(source).toMatch(/cov\.nameAt\(view\.lat, view\.lon, view\.zoom\)/);
        const moveend = source.slice(source.indexOf("map.on('moveend'"));
        expect(moveend.slice(0, 600)).toMatch(/identifyExplorePlace\(view\)/);
    });
});
