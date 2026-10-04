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
    // In the app getBackendBase() reads the city config, and the city config asks for this choice, so
    // the key lookup re-enters choiceForCity. That once spun every page load without ?backend= (the
    // try/catch swallowed each stack overflow and the callers retried).
    it('answers the nested lookup from the backend resolution instead of recursing', () => {
        const source = choice('test_city');
        const global = globalFor();
        let resolutions = 0;
        global.getBackendBase = () => { resolutions++; settings.choiceForCity('test_city', global); return 'https://api.example'; };
        global.localStorage.setItem('cb_parcel_source:https://api.example:test_city', source.id);
        expect(settings.choiceForCity('test_city', global)).toMatchObject({ id: source.id });
        expect(resolutions).toBe(1);
    });
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

describe('building source choices', () => {
    const buildingConfig = city => ({ ...config(city), kind: 'building', outFields: ['parcelid', 'OBJECTID', 'height'], heightField: 'height', heightUnit: 'm' });
    const buildingId = city => encodeCustomSource(buildingConfig(city));

    it('keeps building and parcel choices apart: ids, storage keys and decoding', () => {
        const global = globalFor();
        const id = buildingId('test_city');
        expect(id.startsWith('building.')).toBe(true);
        expect(settings.decodeChoice(id, 'test_city', 'building')).toMatchObject({ id, heightField: 'height', name: 'public.example (arcgis)' });
        expect(settings.decodeChoice(id, 'test_city')).toBeNull();
        expect(settings.decodeChoice(choice('test_city').id, 'test_city', 'building')).toBeNull();
        expect(settings.storageKey('test_city', global, 'building')).not.toBe(settings.storageKey('test_city', global));
        settings.saveChoice('test_city', { id }, global, 'building');
        expect(settings.choiceForCity('test_city', global, 'building')).toMatchObject({ id });
        expect(settings.choiceForCity('test_city', global)).toBeNull();
    });

    it('lets ?buildingSource= win over the stored building choice', () => {
        const stored = buildingId('test_city');
        const other = encodeCustomSource({ ...buildingConfig('test_city'), endpoint: 'https://other.example/FeatureServer/0' });
        const global = globalFor({ search: '?buildingSource=' + other });
        settings.saveChoice('test_city', { id: stored }, global, 'building');
        expect(settings.choiceForCity('test_city', global, 'building').id).toBe(other);
    });

    it('replaces the city buildings with the chosen source and keeps the default on record', () => {
        const id = buildingId('zagreb');
        const global = globalFor({ search: '?buildingSource=' + id });
        const { manager } = bootCity('zagreb', global);
        expect(manager.getCityConfig('zagreb').buildings).toMatchObject({ source: 'custom', sourceId: id, defaultSource: 'gdi' });
        expect(manager.getBuildingSourceId()).toBe(id);
        const plain = bootCity('zagreb', globalFor()).manager;
        expect(plain.getBuildingSourceId()).toBeUndefined();
    });
});

describe('building failure banner', () => {
    // A minimal document: elements with ids, children and click listeners.
    function fakeDocument() {
        const byId = new Map();
        const make = tag => {
            const node = { tag, children: [], listeners: {}, attributes: {}, textContent: '', parent: null,
                set id(value) { this._id = value; byId.set(value, this); }, get id() { return this._id; },
                setAttribute(name, value) { this.attributes[name] = value; },
                append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } },
                addEventListener(type, fn) { this.listeners[type] = fn; },
                querySelector(selector) { return selector === 'p' ? this.children.find(child => child.tag === 'p') : null; },
                remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); if (this._id) byId.delete(this._id); } };
            return node;
        };
        const body = make('body');
        return { body, createElement: make, getElementById: id => byId.get(id) || null };
    }

    it('says whose data failed and when to try again, and always offers a source of your own', () => {
        const global = {};
        expect(settings.buildingFailureMessage(global, { origin: 'osm', retryAfter: 90 }))
            .toBe('Building data could not be loaded right now: the OpenStreetMap server is busy. Try again in about 2 min, or plug in your own mirror or source.');
        expect(settings.buildingFailureMessage(global, { origin: 'custom' }))
            .toBe('Your building source did not answer, so buildings could not be loaded here. Try again later, or plug in your own mirror or source.');
        expect(settings.buildingFailureMessage(global, { origin: 'other' })).toMatch(/^Building data could not be loaded right now\. Try again later/);
    });

    it('keeps one building banner beside the parcel one, updates it in place, and retries with the latest callback', () => {
        const document = fakeDocument();
        const global = { document };
        settings.reportFailure(global, 'parcels failed');
        const firstRetry = vi.fn(), latestRetry = vi.fn();
        settings.reportFailure(global, 'buildings failed', 'building', firstRetry);
        settings.reportFailure(global, 'buildings still failing', 'building', latestRetry);
        const stack = document.getElementById('source-status-stack');
        expect(stack.children.map(node => node.id)).toEqual(['parcel-source-status', 'building-source-status']);
        const banner = document.getElementById('building-source-status');
        expect(banner.querySelector('p').textContent).toBe('buildings still failing');
        const [retry, choose] = banner.children.filter(node => node.tag === 'button');
        expect([retry.textContent, choose.textContent]).toEqual(['Retry buildings', 'Choose a building source']);
        retry.listeners.click();
        expect(latestRetry).toHaveBeenCalledTimes(1);
        expect(firstRetry).not.toHaveBeenCalled();
        expect(document.getElementById('building-source-status')).toBeNull();
        settings.clearFailure(global);
        expect(stack.children).toEqual([]);
    });

    it('accepts an OpenStreetMap mirror as a building choice only', () => {
        const id = encodeCustomSource({ adapter: 'overpass', endpoint: 'https://mirror.example/api/interpreter', cityIds: ['lima'], kind: 'building' });
        expect(settings.decodeChoice(id, 'lima', 'building')).toMatchObject({ adapter: 'overpass', name: 'mirror.example (overpass)' });
        expect(settings.decodeChoice(id, 'lima', 'parcel')).toBeNull();
    });
});
