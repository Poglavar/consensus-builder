// Backend binding preserves the consumer-selected source and metadata, without city lookup.
import { describe, it, expect, vi } from 'vitest';
import { publicationCityOf, computeBinding, parcelActBinding } from '../proposals/binding.js';
import { cityConfigSource } from './helpers/city-config-source.js';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const site = {type:'Polygon',coordinates:[[[15.97,45.81],[15.971,45.81],[15.971,45.811],[15.97,45.811],[15.97,45.81]]]};
// The browser names a publication's city and source from its site (CityConfigManager.getParcelContext,
// the boot's jurisdiction rule); the server keeps what it is given.
describe('publication city from the site', () => {
    const context = { URLSearchParams, console, WorldCoverage: require('../../frontend/js/world/world-coverage.js'),
        BOOT_COVERAGE: require('../../frontend/data/world-coverage.json') };
    context.window = context;
    runInNewContext(cityConfigSource(), context);
    const square = (lon, lat) => ({ type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.001, lat], [lon + 0.001, lat + 0.001], [lon, lat + 0.001], [lon, lat]]] });
    it.each([
        ['Croydon', 'london', square(-0.0982, 51.3762)], ['Kingston upon Thames', 'london', square(-0.3064, 51.4085)],
        ['Sutton Coldfield', 'birmingham', square(-1.8226, 52.5636)], ['Solihull', 'solihull', square(-1.7780, 52.4130)],
        ['Liverpool city centre', 'liverpool', square(-2.9916, 53.4084)], ['Anfield', 'liverpool', square(-2.9608, 53.4308)],
        ['Birkenhead', 'wirral', square(-3.0148, 53.3934)], ['Stockport', 'stockport', square(-2.1494, 53.4083)]
    ])('files a design drawn at %s, from any session, under %s with the HM Land Registry source', (_name, city, site) => {
        for (const session of ['birmingham', 'zagreb', null]) {
            const parcelContext = context.CityConfigManager.getParcelContext(site, session);
            expect(parcelContext).toEqual({ city, parcelSourceId: 'gb-hmlr-browser-v1' });
            expect(publicationCityOf({ site, ...parcelContext })).toEqual({ city, parcelSourceId: 'gb-hmlr-browser-v1' });
        }
    });
    it('files a Scottish site under no cadastre (explore), as before', () => {
        expect(context.CityConfigManager.getParcelContext(square(-3.1883, 55.9533), 'london')).toMatchObject({ city: 'explore' });
    });
});

describe('explicit consumer source contract', () => {
    it('preserves a selected source even when the geometry and consumer label differ', () => {
        expect(publicationCityOf({site, city:'any-consumer', parcelSourceId:'parcel-nyc'}))
            .toEqual({city:'any-consumer', parcelSourceId:'parcel-nyc'});
    });
    it('refuses a missing source before reading any dataset', async () => {
        const db = {query:vi.fn()};
        await expect(computeBinding(db,{site,city:'zagreb'})).rejects.toMatchObject({status:400,code:'invalid-parcel-source'});
        await expect(parcelActBinding(db,['HR-123-1'])).rejects.toMatchObject({status:400,code:'invalid-parcel-source'});
        expect(db.query).not.toHaveBeenCalled();
    });
    it('distinguishes an explicit no-cadastre choice from a missing source', async () => {
        const db = {query:vi.fn()};
        const result = await computeBinding(db,{site,parcelSourceId:'none',city:'arbitrary-consumer'});
        expect(result.binding).toMatchObject({coverage:'none',parcels:[],unknownM2:0});
        expect(result.binding.unsurveyedM2).toBeGreaterThan(0);
        expect(db.query).not.toHaveBeenCalled();
    });
});
