// Every configured city must be one isInCity knows about.
//
// This is the quietest failure in the app, so it gets a test that cannot be forgotten rather than a
// list someone has to remember to update. A city absent from isInCity does not degrade — it fails
// totally and silently: isInCity answers false for the city's OWN parcels, rebuildAppliedFabric
// filters every applied proposal out of the replay, and the rebuild reports a cheerful
// {ok: true, applied: 0}. Proposals there mark themselves applied, cut nothing, draw nothing, and
// come back invisible after a reload, with no error logged anywhere.
//
// Šibenik and Split were both in that state: configured cities, fully working parcels, and every
// proposal applied in them silently did nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const storageSource = read('../../frontend/js/proposals/storage.js');
const cityConfigSource = read('../../frontend/js/city-config.js');
const cityContext = { URLSearchParams, console };
cityContext.window = cityContext;
runInContext(cityConfigSource, createContext(cityContext));
const cityManager = cityContext.CityConfigManager;

// The cities the app actually offers, taken from the config rather than restated here — restating
// them is what let two of them drift out of isInCity in the first place.
function configuredCityIds() {
    const ids = new Set();
    // `explore: true` marks the explore city (no cadastre, so no parcel-id space): not a city here.
    const pattern = /^\s{12}id:\s*'([a-z_]+)',?\n(\s{12}explore:\s*true)?/gm;
    let match;
    while ((match = pattern.exec(cityConfigSource)) !== null) if (!match[2]) ids.add(match[1]);
    return [...ids];
}

// isInCity's own table and the function itself, lifted out of the classic script so the real source
// is what gets exercised.
function loadIsInCity(manager = cityManager) {
    const start = storageSource.indexOf('const CITY_PARCEL_ID_PREFIXES');
    expect(start).toBeGreaterThan(-1);
    const marker = '\nfunction isInCity(';
    const functionStart = storageSource.indexOf(marker, start);
    expect(functionStart).toBeGreaterThan(-1);
    const end = storageSource.indexOf('\n}', functionStart);
    expect(end).toBeGreaterThan(-1);
    const snippet = storageSource.slice(start, end + 2);
    // eslint-disable-next-line no-new-func
    return new Function('CityConfigManager', `${snippet}; return { isInCity, CITY_PARCEL_ID_PREFIXES };`)(manager);
}

const { isInCity, CITY_PARCEL_ID_PREFIXES } = loadIsInCity();

describe('isInCity covers every configured city', () => {
    it('finds the cities in the config at all', () => {
        const ids = configuredCityIds();
        expect(ids).toContain('zagreb');
        expect(ids).toContain('sibenik');
        expect(ids.length).toBeGreaterThanOrEqual(6);
    });

    it('knows a parcel-id space for each of them', () => {
        const configuredPrefixes = cityManager.getAvailableCities().filter(city => city.parcels?.idPrefix).map(city => city.id);
        const known = new Set([...Object.keys(CITY_PARCEL_ID_PREFIXES), ...configuredPrefixes, 'buenos_aires']);
        const unhandled = configuredCityIds().filter(id => !known.has(id));
        expect(unhandled).toEqual([]);
    });

    it('accepts each city its own parcels rather than refusing them', () => {
        const sample = {
            zagreb: 'HR-335533-4090/1',
            split: 'HR-334286-1',
            sibenik: 'HR-330264-628',
            belgrade: 'SR-70123-456',
            ljubljana: 'SI-1234-56',
            buenos_aires: '001-002-3A',
            colorado: 'US-CO-12345',
            new_york: 'US-NY-1-100',
            sydney: 'AU-NSW-11111',
            sao_paulo: 'BR-SP-GEOSAMPA-1958754',
            birmingham: 'GB-HMLR-23394370',
            london: 'GB-HMLR-LONDON-23394370',
            manchester: 'GB-HMLR-MANCHESTER-23394370',
            madrid: 'ES-DGC-28079000000001',
            barcelona: 'ES-DGC-08019000000001',
            savar: 'BD-DLRS-201901-4105-010510026-001-0001',
            lusaka: 'ZM-LUSAKA-GID-11111111-2222-3333-4444-555555555555',
            osaka: 'JP-MOJ-2026-27128~sheet1~H000000001',
            tokyo: 'JP-MOJ-2026-13101~sheet1~H000000001',
            nagoya: 'JP-MOJ-2026-23101~sheet1~H000000001',
            shenzhen: 'CN-SZ-LANDCERTAIN-TEST-1',
            toronto: 'CA-ON-TORONTO-5455132',
            montreal: 'CA-QC-CADASTRE-11111111-2222-3333-4444-555555555555',
            bogota: 'CO-BOGOTA-006106001009',
            los_angeles: 'US-CA-LA-5149001915',
            miami: 'US-FL-MIAMI-DADE-{C9D13CB3-3718-4F70-B8BB-CA6F9FE127F4}',
            washington_dc: 'US-DC-{1B157667-518C-4B56-9DFC-1DAEC1559EAB}',
            paris: 'FR-PCI-75105000AD0011',
            lyon: 'FR-PCI-69385000AA0001',
            bamako: 'ML-NINACAD-00103010001',
            cotonou: 'BJ-ANDF-101413974',
            luanda: 'AO-LUANDA-AGT-11111111-2222-3333-4444-555555555555',
            lima: 'PE-SEDAPAL-LOT-{11111111-2222-3333-4444-555555555555}',
            rotterdam: 'NL-BRK-11460432670000',
            cologne: 'DE-NRW-05344102100105______',
            dortmund: 'DE-NRW-05913000000012345678',
            melbourne: 'AU-VIC-PARCEL-152244627',
            cape_town: 'ZA-CCT-C0160007000951650000000000',
            amsterdam: 'NL-BRK-11460432670000',
            antwerp: 'BE-GRB-ADP-4455664',
            essen: 'DE-NRW-05344102100105______',
            san_francisco: 'US-CA-SF-0256005',
            berlin: 'DE-BE-11000181900016____',
            hong_kong: 'HK-LANDSD-LOT-1800293576',
            montgomery: 'US-AL-MONTGOMERY-1004181031004000',
            juneau: 'US-AK-CBJ-1C060C250020',
            phoenix: 'US-AZ-MARICOPA-11221002',
            little_rock: 'US-AR-PULASKI-34L-032.00-016.00',
            sacramento: 'US-CA-SACRAMENTO-00600360310000',
            hartford: "US-CT-HARTFORD-247451213",
            dover: "US-DE-KENT-2-05-07709-03-1500-00001",
            atlanta: "US-GA-FULTON-14 007600021238",
            honolulu: "US-HI-HONOLULU-121017020",
            boise: "US-ID-ADA-R0190710010",
            springfield: "US-IL-SPRINGFIELD-22040426013",
            baton_rouge: "US-LA-EBR-001-0170-2",
            augusta: "US-ME-AUGUSTA-00026 00001 00000",
            annapolis: "US-MD-ANNAPOLIS-7143",
            boston: "US-MA-BOSTON-F_775089_2955798",
            indianapolis: "US-IN-MARION-1050626",
            des_moines: "US-IA-77-02001125002000",
            lansing: "US-MI-33-01-01-16-306-001",
            saint_paul: "US-MN-RAMSEY-312922440077",
            jefferson_city: "US-MO-JEFFERSON_CITY-1103070004016001",
            helena: "US-MT-HELENA-05188831233037000",
            lincoln: "US-NE-LINCOLN-1026215016000",
            concord: "US-NH-CONCORD-07046-2917",
            trenton: "US-NJ-TRENTON-1111_15001_1",
            santa_fe: "US-NM-SANTA-FE-99306489",
            albany: "US-NY-ALBANY-01010007600700010010000000",
            raleigh: "US-NC-WAKE-1703678831",
            bismarck: "US-ND-BURLEIGH-1-064-005",
            columbus: "US-OH-FRANKLIN-010-007484",
            salem: "US-OR-MARION-073W22DC04500",
            nashville: "US-TN-NASHVILLE-09306100100",
            austin: "US-TX-TRAVIS-0205011101",
            salt_lake_city: "US-UT-SALTLAKE-15014290110000",
            montpelier: "US-VT-MONTPELIER-405-126-11382",
            richmond: "US-VA-RICHMOND-5176000050747",
            carson_city: "US-NV-CARSON_CITY-00311313",
            charleston: "US-WV-CHARLESTON-20110013000100000000",
            cheyenne: "US-WY-CHEYENNE-LARAMIE-14663125900400",
            columbia: "US-SC-COLUMBIA-08916-10-16",
            harrisburg: "US-PA-HARRISBURG-06-016-053",
            jackson: "US-MS-JACKSON-001840000001000000",
            madison: "US-WI-MADISON-DANE-070922101020",
            olympia: "US-WA-OLYMPIA-THURSTON-09850005000",
            providence: "US-RI-PROVIDENCE-240405",
            tallahassee: "US-FL-TALLAHASSEE-2136252231785",
            topeka: "US-KS-TOPEKA-1330602013011000"
        };
        configuredCityIds().forEach(city => {
            expect(sample[city], `no sample parcel id for configured city ${city}`).toBeTruthy();
            expect(isInCity(sample[city], city), `${city} refuses its own parcel`).toBe(true);
        });
    });

    it('uses a new source prefix from city config without another proposal-storage entry', () => {
        const { isInCity: configured } = loadIsInCity({
            getCityConfig: city => city === 'future_city' ? { parcels: { idPrefix: 'XX-FUTURE-' } } : null
        });
        expect(configured('XX-FUTURE-00001', 'future_city')).toBe(true);
        expect(configured('CO-BOGOTA-006106001009', 'future_city')).toBe(false);
    });
});

describe('isInCity still separates the id spaces', () => {
    it('keeps a Croatian parcel out of a foreign city', () => {
        expect(isInCity('HR-330264-628', 'belgrade')).toBe(false);
        expect(isInCity('HR-330264-628', 'new_york')).toBe(false);
        expect(isInCity('SR-70123-456', 'zagreb')).toBe(false);
    });

    it('treats the Croatian cities as one id space, because they share one national dataset', () => {
        // Not a looseness introduced here: Zagreb has always accepted any HR- id, and there is no
        // per-city cadastre to distinguish them by.
        ['zagreb', 'split', 'sibenik'].forEach(city => {
            expect(isInCity('HR-330264-628', city)).toBe(true);
        });
    });

    it('refuses an unknown city instead of waving its parcels through', () => {
        expect(isInCity('HR-330264-628', 'atlantis')).toBe(false);
        expect(isInCity('HR-330264-628', '')).toBe(false);
        expect(isInCity('', 'zagreb')).toBe(false);
        expect(isInCity(null, 'zagreb')).toBe(false);
    });
});
