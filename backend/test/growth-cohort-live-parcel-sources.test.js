// Keep the two new growth-cohort city bindings tied to their configured live sources.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import proj4 from 'proj4';
import { parcelSourceForCity, parcelSourceForIds, clearParcelSourceRuntimeCache } from '../parcels/sources.js';
import { computeBinding } from '../proposals/binding.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const cases = [
    { city: 'new_hope', source: 'us-nc-wake-raleigh-parcels', prefix: 'US-NC-WAKE-', srid: 32617, currency: 'USD' },
    { city: 'venjaramoodu', source: 'kerala-entebhoomi-ilms-map-proxy', prefix: 'IN-KL-ENTEBHOOMI-010309-', srid: 32643, currency: 'INR', exactConcurrency: 16 }
];

afterEach(() => {
    vi.unstubAllGlobals();
    clearParcelSourceRuntimeCache();
});

describe('growth-cohort live parcel source contracts', () => {
    it.each(cases)('$city resolves its published source and native-ID prefix', sample => {
        const result = parcelSourceForCity(sample.city);
        expect(result.descriptor.id).toBe(sample.source);
        expect(result.descriptor.idPrefix).toBe(sample.prefix);
        expect(result.descriptor.metricSrid).toBe(sample.srid);
        if (sample.exactConcurrency) expect(result.descriptor.exactConcurrency).toBe(sample.exactConcurrency);
        expect(parcelSourceForIds([sample.prefix + 'sample-native-id']).descriptor.id).toBe(sample.source);

        const context = { console, URL, URLSearchParams }; context.window = context;
        // CityConfigManager is a classic script, so evaluate it in an isolated browser-like context.
        runInNewContext(read('frontend/js/city-config.js'), context);
        const city = context.CityConfigManager.getCityConfig(sample.city);
        expect(city.parcels).toMatchObject({ sourceId: sample.source, idPrefix: sample.prefix, ownership: false });
        expect(city.projection.metricCrs).toBe(`EPSG:${sample.srid}`);
        expect(city.currency.code).toBe(sample.currency);
        for (const locale of ['en', 'es', 'hr', 'sr']) {
            const translations = JSON.parse(read(`frontend/i18n/${locale}.json`));
            expect(translations.city.labels[sample.city]).toBeTruthy();
        }
    });

    it('binds Venjaramoodu through the Ente Bhoomi adapter without imported-parcel SQL', async () => {
        const fixture = JSON.parse(read('world-parcels/research/growth-top20-integration-2026-10-07/kerala-parcel-sample.geojson'));
        const feature = fixture.features[0];
        const descriptor = parcelSourceForCity('venjaramoodu').descriptor;
        const nativeId = feature.properties.parcel_gid;
        const parcelId = descriptor.idPrefix + nativeId;
        const mapCoordinates = coordinates => {
            if (coordinates.length >= 2 && coordinates.slice(0, 2).every(Number.isFinite)) {
                return proj4('EPSG:4326', 'EPSG:32643', coordinates.slice(0, 2));
            }
            return coordinates.map(mapCoordinates);
        };
        const metricCollection = { type: 'FeatureCollection', features: [{
            ...feature, geometry: { ...feature.geometry, coordinates: mapCoordinates(feature.geometry.coordinates) }
        }] };
        const page = `<html><meta name="_csrf_header" content="X-CSRF-TOKEN"><meta name="_csrf" content="csrf-value"><select id="districtGid"><option value="${descriptor.districtGid}">Configured district</option></select></html>`;
        const calls = [];
        vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
            const url = new URL(input); calls.push({ url, options });
            if (url.pathname === '/web/ilms/map') return new Response(page, { headers: { 'set-cookie': 'session=fixture; Path=/' } });
            if (url.pathname === '/web/taluk/gid') return Response.json({ dataPojo: { talukids: [{ gid: descriptor.talukGid, talukName: 'Configured taluk' }] } });
            if (url.pathname === '/web/village/gid') return Response.json({ dataPojo: { villageids: [{ gid: descriptor.villageGid, villageName: 'Configured village' }] } });
            if (url.pathname === '/web/ilms/map/view') {
                const config = { location_code: descriptor.locationCode,
                    fgb_url: `https://bhunaksha.entebhoomi.kerala.gov.in/bhunaksha_v5_emaps/core/v2/map/export/fgb/${descriptor.locationCode}?auth_key=fixture-key` };
                return new Response(`<div id="initdata" value='${JSON.stringify(config)}'></div>`);
            }
            if (url.pathname === `/bhunaksha_v5_emaps/core/v2/map/export/geojson/${descriptor.locationCode}`) {
                return Response.json(metricCollection, { headers: { 'content-type': 'application/geo+json' } });
            }
            throw new Error(`Unexpected fixture request: ${url.pathname}`);
        }));

        const db = { query: vi.fn(async () => { throw new Error('Live source binding must not query imported parcel tables.'); }) };
        const { binding } = await computeBinding(db, { city: 'venjaramoodu', site: feature.geometry, toleranceM: 0 });
        expect(db.query).not.toHaveBeenCalled();
        expect(binding).toMatchObject({ coverage: 'complete', source: `server:${descriptor.id}` });
        expect(binding.parcels.map(parcel => parcel.parcelId)).toContain(parcelId);
        expect(calls.some(call => call.url.pathname.endsWith(`/geojson/${descriptor.locationCode}`))).toBe(true);
        const selectorCall = calls.find(call => call.url.pathname === '/web/ilms/map/view');
        expect(Object.fromEntries(new URLSearchParams(selectorCall.options.body))).toEqual({
            districtGid: descriptor.districtGid, talukGid: descriptor.talukGid, villageGid: descriptor.villageGid
        });
        expect(calls.find(call => call.url.pathname.endsWith(`/geojson/${descriptor.locationCode}`)).options.headers.Cookie).toBe('session=fixture');
    });
});
