import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { area, bboxPolygon } from '@turf/turf';
import { encodeCustomSource, decodeCustomSource } from '../parcels/custom-source-config.js';

const settings = createRequire(import.meta.url)('../../frontend/js/parcel-source-settings.js');
const config = city => ({ adapter: 'arcgis', endpoint: 'https://public.example/FeatureServer/0', cityIds: [city], metricSrid: 32633,
    idField: 'parcelid', objectIdField: 'OBJECTID', idType: 'string', outFields: ['parcelid', 'OBJECTID'] });
const choice = city => decodeCustomSource(encodeCustomSource(config(city)));
function storage() {
    const data = new Map();
    return { data, getItem: key => data.get(key) ?? null, setItem: (key,value) => data.set(key,String(value)), removeItem: key => data.delete(key) };
}
function globalFor({ backend = 'https://api.example', search = '', localStorage = storage() } = {}) {
    return { getBackendBase: () => backend, location: { search, href: 'https://game.example/' + search, pathname: '/' }, localStorage };
}
function bootCity(city, global) {
    const scopes = [];
    const persistent = { getItem: () => null, setItem() {}, setScope: id => scopes.push(id) };
    const window = { ...global, ParcelSourceSettings: settings, PersistentStorage: persistent, dispatchEvent() {} };
    window.location = { ...global.location, search: '?city=' + city + (global.location.search ? '&' + global.location.search.slice(1) : '') };
    const context = createContext({ window, localStorage: window.localStorage, PersistentStorage: persistent, URL, URLSearchParams });
    runInContext(readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8'), context);
    return { manager: window.CityConfigManager, scopes };
}

describe('recent custom source checks', () => {
    it('retains bounded failure metadata across reopening without storing parcel features', () => {
        const global = globalFor();
        for (let i = 0; i < 12; i++) settings.recordCheck('sample', `https://public.example/source/${i}`, {
            code: 'no-available-adapter', features: [{ geometry: 'must not persist' }],
            attempts: [{ adapter: 'wfs', status: 'rejected', error: { code: 'missing-stable-id', message: 'No stable parcel key.' } }]
        }, global);
        const history = settings.recentChecks('sample', global);
        expect(history).toHaveLength(10);
        expect(history[0].url).toBe('https://public.example/source/2');
        expect(history.at(-1).attempts[0]).toMatchObject({ adapter: 'wfs', code: 'missing-stable-id' });
        expect(JSON.stringify(history)).not.toContain('must not persist');
        expect(settings.recentChecks('other', global)).toEqual([]);
        expect(settings.recentChecks('sample', globalFor({ backend: 'https://different.example', localStorage: global.localStorage }))).toEqual([]);
    });
    it('does not retain credentials and tolerates unavailable audit storage', () => {
        const global = globalFor();
        for (const url of ['https://user:password@public.example/', 'https://public.example/?token=secret', 'http://public.example/']) {
            settings.recordCheck('sample', url, { code: 'invalid-source-url' }, global);
        }
        expect(settings.recentChecks('sample', global)).toEqual([]);
        global.localStorage.setItem = () => { throw new Error('storage denied'); };
        expect(() => settings.recordCheck('sample', 'https://public.example/', {}, global)).not.toThrow();
    });
});

describe('browser-owned portable source choices', () => {
    it('decodes portable gateway metadata only for its declared city', () => {
        const source = choice('test_city');
        expect(settings.decodeChoice(source.id, 'test_city')).toMatchObject({ id: source.id, endpoint: source.endpoint,
            idPrefix: source.idPrefix, name: 'public.example (arcgis)' });
        expect(settings.decodeChoice(source.id, 'other_city')).toBeNull();
        for (const id of ['', 'custom.not_json', 'other.e30', 'custom.' + 'a'.repeat(3401)]) expect(settings.decodeChoice(id, 'test_city')).toBeNull();
        const parsed = JSON.parse(Buffer.from(source.id.slice(7), 'base64url').toString('utf8'));
        for (const change of [{ idPrefix: 'AR-' }, { endpoint: 'http://public.example' }, { endpoint: 'https://user:secret@public.example' },
            { cityIds: ['test_city', 'other_city'] }]) {
            const id = 'custom.' + Buffer.from(JSON.stringify({ ...parsed, ...change })).toString('base64url');
            expect(settings.decodeChoice(id, 'test_city')).toBeNull();
        }
    });
    it('saves durably across a fresh window while isolating city and backend', () => {
        const store = storage(), global = globalFor({localStorage:store}), source = choice('test_city');
        settings.saveChoice('test_city', source, global);
        expect(settings.choiceForCity('test_city', globalFor({localStorage:store})).id).toBe(source.id);
        expect(settings.choiceForCity('other_city', global)).toBeNull();
        expect(settings.choiceForCity('test_city', globalFor({backend:'https://other-api.example',localStorage:store}))).toBeNull();
        expect(store.data.get('cb_parcel_source:https://api.example:test_city')).toBe(source.id);
        expect(settings.storageKey('test_city',globalFor({backend:'https://api.example///'}))).toBe(settings.storageKey('test_city',global));
        expect(() => settings.saveChoice('other_city',source,global)).toThrow(/Invalid source choice/);
    });
    it('uses the effective backend helper before the URL backend and scopes query-only backends correctly', () => {
        const helper=globalFor({search:'?backend=https%3A%2F%2Fquery.example'});
        expect(settings.storageKey('test_city',helper)).toBe('cb_parcel_source:https://api.example:test_city');
        delete helper.getBackendBase;
        expect(settings.storageKey('test_city',helper)).toBe('cb_parcel_source:https://query.example:test_city');
    });
    it('gives an explicit custom query precedence and ignores a stored custom for an explicit city default/live/foreign choice', () => {
        const global=globalFor(), stored=choice('test_city'), explicit=decodeCustomSource(encodeCustomSource({...config('test_city'), endpoint:'https://other.example/FeatureServer/0'}));
        settings.saveChoice('test_city',stored,global);
        global.location.search='?parcelSource='+encodeURIComponent(explicit.id);
        expect(settings.choiceForCity('test_city',global).id).toBe(explicit.id);
        for(const requested of ['default','live','unknown',choice('other_city').id]) {
            global.location.search='?parcelSource='+encodeURIComponent(requested);
            expect(settings.choiceForCity('test_city',global)).toBeNull();
        }
        global.location.search='';expect(settings.choiceForCity('test_city',global).id).toBe(stored.id);
    });
    it('reports storage write/readback failures and falls back honestly when storage reads are unavailable', () => {
        const source=choice('test_city');
        const unavailable=globalFor({localStorage:{getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}}});
        expect(settings.choiceForCity('test_city',unavailable)).toBeNull();
        expect(()=>settings.saveChoice('test_city',source,unavailable)).toThrow();
        const lost=globalFor({localStorage:{getItem:()=>null,setItem:vi.fn()}});
        expect(()=>settings.saveChoice('test_city',source,lost)).toThrow(/could not be saved/);
    });
});

describe('bounded source discovery probes', () => {
    it.each([[45,15],[0,0],[89.9,0],[-89.9,0],[90,180],[-90,-180],[45,179.9999],[45,-179.9999],[45,181],[45,540],[45,-541]])('produces a valid <=1km² probe near %j', (lat,lng) => {
        const bounds=settings.smallProbeBounds({getCenter:()=>({lat,lng})});
        expect(bounds.every(Number.isFinite)).toBe(true);
        expect(bounds[0]).toBeGreaterThanOrEqual(-180);expect(bounds[2]).toBeLessThanOrEqual(180);
        expect(bounds[1]).toBeGreaterThanOrEqual(-90);expect(bounds[3]).toBeLessThanOrEqual(90);
        expect(bounds[0]).toBeLessThan(bounds[2]);expect(bounds[1]).toBeLessThan(bounds[3]);
        expect(area(bboxPolygon(bounds))).toBeGreaterThan(0);expect(area(bboxPolygon(bounds))/1e6).toBeLessThanOrEqual(1);
    });
    it.each([{lat:NaN,lng:0},{lat:0,lng:Infinity},{lat:undefined,lng:15}])('rejects a nonfinite map center %#', center => {
        expect(()=>settings.smallProbeBounds({getCenter:()=>center})).toThrow();
    });
});

describe('city configuration with a browser-owned custom source', () => {
    it('overrides only parcel runtime properties while preserving the city and its storage scope', () => {
        const global=globalFor(), selected=choice('zagreb');settings.saveChoice('zagreb',selected,global);
        const normal=bootCity('zagreb',globalFor()), custom=bootCity('zagreb',global);
        expect(normal.manager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
        expect(custom.manager.getCurrentCityConfig()).toMatchObject({id:'zagreb',parcels:{source:'parcel-source',sourceId:selected.id,
            idPrefix:selected.idPrefix,strategy:'grid',gridSize:100,requiresBackend:true,ownership:false}});
        expect(custom.scopes).toEqual(normal.scopes);
        expect(custom.manager.getCityConfig('ljubljana').parcels.source).not.toBe('parcel-source');
        expect(normal.manager.getCurrentCityConfig().parcels.sourceId).not.toBe(selected.id);
    });
    it('keeps DB defaults without a choice and honors explicit defaults despite a saved custom', () => {
        const global=globalFor(), selected=choice('zagreb');settings.saveChoice('zagreb',selected,global);
        global.location.search='?parcelSource=default';
        expect(bootCity('zagreb',global).manager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
        expect(bootCity('ljubljana',globalFor()).manager.getCurrentCityConfig().parcels.source).not.toBe('parcel-source');
    });
    it('uses a degree grid for a city with an existing degree grid instead of a metre-sized value', () => {
        const global=globalFor(), selected=choice('belgrade');settings.saveChoice('belgrade',selected,global);
        expect(bootCity('belgrade',global).manager.getCurrentCityConfig().parcels).toMatchObject({sourceId:selected.id,gridSize:0.001,ownership:false});
    });
});
