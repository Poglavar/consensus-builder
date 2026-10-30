// The ordered source list of a concept (frontend/js/source-list.js): the city's declared sources, the
// person's order and switches over them, and the list given in the URL.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SourceList = require('../../frontend/js/source-list.js');

const zagreb = { id: 'zagreb', buildings: { sources: [{ id: 'gdi-3d' }, { id: 'dgu', use: false }, { id: 'osm', use: false }] } };

function page(search = '', stored = {}) {
    const store = new Map(Object.entries(stored));
    const events = [];
    const global = {
        location: { search, href: `https://example.test/${search}` },
        history: { state: null, replaceState(_state, _title, href) { global.location.href = href; global.location.search = new URL(href).search; } },
        getBackendBase: () => 'https://api.example.test',
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        dispatchEvent: event => events.push(event),
        ParcelSourceSettings: { decodeChoice: id => (id === 'building.mine' ? { name: 'my survey' } : null) }
    };
    return { global, store, events };
}

describe('source list', () => {
    it("reads the city's list with names, every source in use unless declared otherwise", () => {
        expect(SourceList.cityList(zagreb)).toEqual([
            { id: 'gdi-3d', name: 'Zagreb 3D model (GDI)', attribution: null, use: true, outline: false, city: true },
            { id: 'dgu', name: 'DGU cadastre', attribution: null, use: false, outline: false, city: true },
            { id: 'osm', name: 'OpenStreetMap', attribution: null, use: false, outline: false, city: true }
        ]);
        expect(SourceList.inUse(SourceList.cityList(zagreb))).toEqual(['gdi-3d']);
    });

    it("puts the person's order first, drops what is unknown and appends the city's sources left out", () => {
        const list = SourceList.resolve(SourceList.cityList(zagreb), [
            { id: 'building.mine', use: true }, { id: 'nonsense' }, { id: 'osm', use: false, outline: true }
        ], id => (id === 'building.mine' ? { name: 'my survey' } : null));
        expect(list.map(entry => [entry.id, entry.use, entry.outline, entry.city])).toEqual([
            ['building.mine', true, false, false], ['osm', false, true, true], ['gdi-3d', true, false, true], ['dgu', false, false, true]
        ]);
        expect(SourceList.inUse(list)).toEqual(['building.mine', 'gdi-3d']);
        expect(SourceList.outlined(list).map(entry => entry.id)).toEqual(['osm']);
    });

    it('takes the list in the URL as the sources in use, in order, every other one not in use', () => {
        const { global } = page('?buildingSources=osm,gdi-3d');
        expect(SourceList.inUse(SourceList.forConfig(zagreb, global))).toEqual(['osm', 'gdi-3d']);
    });

    it('saves and resets per backend and city, announcing each change and clearing a URL list', () => {
        const { global, store, events } = page('?buildingSources=osm');
        const list = SourceList.forConfig(zagreb, global).map(entry => (entry.id === 'dgu' ? { ...entry, outline: true } : entry));
        SourceList.save('zagreb', list, global);
        expect(JSON.parse(store.get('cb_building_sources:https://api.example.test:zagreb'))).toEqual([
            { id: 'osm', use: true, outline: false }, { id: 'gdi-3d', use: false, outline: false }, { id: 'dgu', use: false, outline: true }
        ]);
        expect(global.location.search).toBe('');
        expect(SourceList.outlined(SourceList.forConfig(zagreb, global)).map(entry => entry.id)).toEqual(['dgu']);
        SourceList.reset('zagreb', global);
        expect(SourceList.forConfig(zagreb, global).map(entry => [entry.id, entry.use])).toEqual([['gdi-3d', true], ['dgu', false], ['osm', false]]);
        expect(events.map(event => [event.type, event.detail])).toEqual([
            ['sourceListChanged', { cityId: 'zagreb', concept: 'buildings' }], ['sourceListChanged', { cityId: 'zagreb', concept: 'buildings' }]
        ]);
    });

    it('tells a URL source, read in the browser, from a database source', () => {
        expect(SourceList.isUrlSource('building.eyJ')).toBe(true);
        expect(['gdi-3d', 'dgu', 'osm'].some(id => SourceList.isUrlSource(id))).toBe(false);
    });
});
