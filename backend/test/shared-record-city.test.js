// A shared /proposals/<id> link must find the city of the record it opens by the same rule storage
// applies when importing it (proposals/data.js proposalCityOf). The shared route used to read only
// `record.city`, so an old record without one was imported into whatever city was on screen — and
// refused there, or applied against another city's parcel source ("Parcel source is unavailable" in
// New York for a Zagreb park). Found by the headed spec world-city-publication.spec.ts.
//
// Executed, not scanned: sharedRecordCityOf (sharing-routes.js) and proposalCityOf (data.js) are
// lifted out of the shipped sources and run together against a fake city manager.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = file => readFileSync(fileURLToPath(new URL(`../../frontend/js/proposals/${file}`, import.meta.url)), 'utf8');

function lift(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`no longer declares ${signature}`);
    const end = source.indexOf('\n}\n', start);
    if (end < 0) throw new Error(`could not find the end of ${signature}`);
    return source.slice(start, end + 2);
}

function load(current) {
    const cities = { zagreb: 'oss-wfs', sibenik: 'oss-wfs', new_york: 'nyc', paris: 'fr' };
    const window = {
        CityConfigManager: {
            resolveCityId: id => (id && cities[String(id).toLowerCase()] ? String(id).toLowerCase() : null),
            getCurrentCityId: () => current,
            getCitiesByParcelSource: source => Object.keys(cities).filter(id => cities[id] === source).map(id => ({ id }))
        },
        parcelIdToCityId: id => (/^FR-/.test(id) ? 'paris' : null)
    };
    const context = vm.createContext({ window, console });
    context.globalThis = context;
    vm.runInContext(`${lift(read('data.js'), 'function proposalCityOf(')}
${lift(read('sharing-routes.js'), 'function sharedRecordCityOf(')}
globalThis.__cityOf = sharedRecordCityOf;`, context);
    return context.__cityOf;
}

describe('the city of a shared record', () => {
    it('is the city it names, flat or inside proposal_data', () => {
        const cityOf = load('new_york');
        expect(cityOf({ city: 'zagreb', cadastreParcelIds: ['FR-1'] })).toBe('zagreb');
        expect(cityOf({ proposal_data: { city: 'paris' } })).toBe('paris');
    });

    it('without a city, is where its parcels are: Croatian ids to the Croatian city on screen, else the first', () => {
        expect(load('new_york')({ cadastreParcelIds: ['HR-335754-1234'] })).toBe('zagreb');
        expect(load('sibenik')({ cadastreParcelIds: ['HR-335754-1234'] })).toBe('sibenik');
        expect(load('new_york')({ proposal_data: { cadastreParcelIds: ['FR-1'] } })).toBe('paris');
    });

    it('with a city the app does not know (the old placeholder), goes by its parcels too', () => {
        expect(load('new_york')({ city: 'city', cadastreParcelIds: ['HR-335754-1234'] })).toBe('zagreb');
    });

    it('is null when nothing places it: there is no city to go to', () => {
        const cityOf = load('new_york');
        expect(cityOf({ city: null, cadastreParcelIds: [] })).toBe(null);
        expect(cityOf(null)).toBe(null);
    });
});
