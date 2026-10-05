// The map search box's pure model (frontend/js/ui/search-model.js) and its wiring in index.html:
// query classification, parcel-id candidates, city/proposal ranking, group ordering, where a
// geocoded place sits relative to the cities, recent searches, keyboard selection — plus every
// string the search box and the command palette use being translated in all four locales.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/ui/search-model.js');

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const indexHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const LANGS = ['en', 'hr', 'es', 'sr'];
const dictionaries = Object.fromEntries(LANGS.map(lang => [
    lang, JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', `${lang}.json`), 'utf8'))
]));
const lookup = (dict, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);

const CITIES = [
    { id: 'zagreb', label: 'Zagreb, Croatia', center: [45.8045, 15.9788], parcelSource: 'oss-wfs' },
    { id: 'split', label: 'Split, Croatia', center: [43.5081, 16.4402], parcelSource: 'oss-wfs' },
    { id: 'ljubljana', label: 'Ljubljana, Slovenia', center: [46.0569, 14.5058], parcelSource: 'si' },
    { id: 'belgrade', label: 'Belgrade, Serbia', center: [44.8125, 20.4612], parcelSource: 'rs' },
    { id: 'new_york', label: 'New York, USA', center: [40.7128, -74.006], parcelSource: 'nyc' }
];

describe('query classification', () => {
    const kinds = q => Model.classifyQuery(q).kinds;

    it('treats an empty query as empty', () => {
        expect(Model.classifyQuery('   ')).toMatchObject({ empty: true, kinds: [] });
    });

    it('reads a city or street name as city, proposal, address and command — not a parcel', () => {
        expect(kinds('Split')).toEqual(['city', 'proposal', 'address', 'command']);
        expect(kinds('Ilica 1')).toEqual(['city', 'proposal', 'address', 'command']);
    });

    it('reads cadastral ids as parcels, never as addresses', () => {
        for (const q of ['1813/6', '1813', '335550-1813/6', 'HR-335550-1813/6', 'hr-335550-1813/6', '1000010010', '001-005-027A', 'US-NY-1000010010', 'SR-70122-1234']) {
            expect(Model.looksLikeParcelId(q), q).toBe(true);
            expect(kinds(q), q).toContain('parcel');
            expect(kinds(q), q).not.toContain('address');
        }
        expect(kinds('HR-335550-1813/6')).not.toContain('city');
    });

    it('does not call words or spaced text a parcel id', () => {
        for (const q of ['Ilica', 'Ilica 1', 'HR-', 'measure', '1813 6']) {
            expect(Model.looksLikeParcelId(q), q).toBe(false);
        }
    });

    it('needs three characters for an address and two for a proposal', () => {
        expect(kinds('Il')).toEqual(['city', 'proposal', 'command']);
        expect(kinds('I')).toEqual(['city', 'command']);
    });

    it('takes a leading > as "commands only"', () => {
        expect(Model.classifyQuery('> measure')).toMatchObject({ commandsOnly: true, text: 'measure', kinds: ['command'] });
    });
});

describe('parcel id candidates', () => {
    const loaded = ['HR-335550-1813/6', 'HR-335258-1813/6', 'HR-335550-1813/61', 'HR-335550-7/1'];

    it('expands a bare number to the matching ids loaded on the map', () => {
        const result = Model.parcelIdCandidates('1813/6', { cityId: 'zagreb', parcelSource: 'oss-wfs', loadedIds: loaded });
        expect(result.ids).toEqual(['HR-335258-1813/6', 'HR-335550-1813/6']);
        expect(result.needsMunicipality).toBe(false);
    });

    it('asks for the cadastral municipality when a Croatian bare number matches nothing loaded', () => {
        const result = Model.parcelIdCandidates('999/1', { cityId: 'zagreb', parcelSource: 'oss-wfs', loadedIds: loaded });
        expect(result).toEqual({ ids: [], needsMunicipality: true });
    });

    it('prefixes HR- to a municipality-number id, and keeps a full id as typed (upper-cased)', () => {
        expect(Model.parcelIdCandidates('335550-1813/6', { cityId: 'split', parcelSource: 'oss-wfs' }).ids).toEqual(['HR-335550-1813/6']);
        expect(Model.parcelIdCandidates('hr-335550-1813/6', { cityId: 'zagreb', parcelSource: 'oss-wfs' }).ids).toEqual(['HR-335550-1813/6']);
    });

    it('adds the city prefix the cadastre transport expects elsewhere', () => {
        expect(Model.parcelIdCandidates('1000010010', { cityId: 'new_york' }).ids).toEqual(['US-NY-1000010010']);
        expect(Model.parcelIdCandidates('70122-1234', { cityId: 'belgrade' }).ids).toEqual(['SR-70122-1234']);
        expect(Model.parcelIdCandidates('001-005-027A', { cityId: 'buenos_aires' }).ids).toEqual(['001-005-027A']);
    });

    it('offers nothing for text that is not an id', () => {
        expect(Model.parcelIdCandidates('Ilica 1', { cityId: 'zagreb', parcelSource: 'oss-wfs', loadedIds: loaded }).ids).toEqual([]);
    });
});

describe('ranking', () => {
    it('lists every city for an empty query, the current one first', () => {
        const ranked = Model.rankCities('', CITIES, 'split');
        expect(ranked[0]).toMatchObject({ id: 'split', current: true });
        expect(ranked).toHaveLength(CITIES.length);
    });

    it('ranks exact, then prefix, then word-start city matches, accent-insensitively', () => {
        expect(Model.rankCities('split', CITIES, 'zagreb').map(c => c.id)).toEqual(['split']);
        expect(Model.rankCities('york', CITIES, 'zagreb').map(c => c.id)).toEqual(['new_york']);
        expect(Model.rankCities('BELGR', CITIES, 'zagreb')[0]).toMatchObject({ id: 'belgrade', rank: 1 });
        expect(Model.rankCities('croatia', CITIES, 'zagreb').map(c => c.id).sort()).toEqual(['split', 'zagreb']);
        expect(Model.matchRank('Šibenik, Croatia', 'sibenik')).toBe(1);
    });

    it('finds a city by its English alias when the label is translated', () => {
        const serbian = CITIES.map(city => (city.id === 'belgrade'
            ? { ...city, label: 'Beograd, Srbija', aliases: ['Belgrade, Serbia'] } : city));
        expect(Model.rankCities('beograd', serbian, 'zagreb')[0]).toMatchObject({ id: 'belgrade', label: 'Beograd, Srbija', rank: 1 });
        expect(Model.rankCities('belgrade', serbian, 'zagreb')[0]).toMatchObject({ id: 'belgrade', label: 'Beograd, Srbija' });
        expect(Model.rankCities('nowhere', serbian, 'zagreb')).toEqual([]);
    });

    it('has a translated name for every configured city in every locale', () => {
        // map-search.js shows city.labels.<id>; a missing key falls back to the English label.
        const source = fs.readFileSync(path.join(FRONTEND, 'js/city-config.js'), 'utf8');
        const block = source.slice(source.indexOf('const CITY_CONFIGS'), source.indexOf('\n    };', source.indexOf('const CITY_CONFIGS')));
        const ids = [...block.matchAll(/^ {8}([a-z_]+): \{\n {12}id: '([a-z_]+)'/gm)].map(m => m[2]).filter(id => id !== 'explore');
        expect(ids).toEqual(expect.arrayContaining(['zagreb', 'split', 'sibenik', 'belgrade', 'ljubljana', 'buenos_aires', 'colorado', 'new_york']));
        for (const lang of LANGS) for (const id of ids) expect(lookup(dictionaries[lang], `city.labels.${id}`), `${lang} ${id}`).toEqual(expect.any(String));
    });

    it('resolves a proposal city id or code, and leaves placeholders unknown', () => {
        const ids = CITIES.map(c => c.id).concat('explore');
        expect(Model.resolveProposalCityId('zagreb', ids, { zg: 'zagreb' })).toBe('zagreb');
        expect(Model.resolveProposalCityId('ZG', ids, { zg: 'zagreb' })).toBe('zagreb');
        expect(Model.resolveProposalCityId('city', ids, { zg: 'zagreb' })).toBeNull();
        expect(Model.resolveProposalCityId('', ids, {})).toBeNull();
        expect(Model.resolveProposalCityId('explore', ids, {})).toBe('explore');
    });

    it('puts proposals in the current city first and otherwise keeps the server order', () => {
        const ranked = Model.rankProposals([
            { id: 1, cityId: 'split' }, { id: 2, cityId: 'zagreb' }, { id: 3, cityId: null }, { id: 4, cityId: 'zagreb' }
        ], 'zagreb');
        expect(ranked.map(p => p.id)).toEqual([2, 4, 1, 3]);
    });

    it('finds unpublished local proposals by title, author or durable id', () => {
        const local = Model.rankLocalProposals([
            { proposalId: 'draft-42', title: 'Tokyo pocket park', author: 'Mina' },
            { proposalId: 'draft-99', title: 'River crossing', author: 'Sam' }
        ], 'mina');
        expect(local).toHaveLength(1);
        expect(local[0]).toMatchObject({ proposalId: 'draft-42', localOnly: true, searchRank: 0 });
        expect(Model.rankLocalProposals([{ proposalId: 'draft-42', title: 'Tokyo pocket park' }], '42')[0])
            .toMatchObject({ proposalId: 'draft-42', localOnly: true });
    });

    it('keeps a local copy once when the server search also finds its uploaded row', () => {
        const local = [{ proposalId: 'draft-42', serverProposalId: '701', localOnly: true }];
        const merged = Model.mergeProposalSearchResults(local, [
            { id: '701', cityId: 'zagreb' }, { id: '702', cityId: 'zagreb' }
        ], 'zagreb');
        expect(merged.map(proposal => proposal.id || proposal.proposalId)).toEqual(['draft-42', '702']);
    });

    it('orders groups by their best match, drops empty ones and cuts each to its limit', () => {
        const items = n => Array.from({ length: n }, (_, i) => ({ key: i, rank: 3 }));
        const groups = Model.orderGroups([
            { id: 'cities', items: [{ rank: 3 }] },
            { id: 'places', items: items(9) },
            { id: 'commands', items: [{ rank: 0 }] },
            { id: 'parcels', items: [] },
            { id: 'proposals', items: [], status: { kind: 'pending' } }
        ]);
        // A group still loading (status, no items) has no match yet, so it goes last.
        expect(groups.map(g => g.id)).toEqual(['commands', 'cities', 'places', 'proposals']);
        expect(groups.find(g => g.id === 'places').items).toHaveLength(Model.GROUP_LIMITS.places);
    });

    it('puts parcels first for an id-looking query (rank 0) and keeps the fixed order on ties', () => {
        const groups = Model.orderGroups([
            { id: 'proposals', items: [{}] },
            { id: 'parcels', items: [{ rank: 0 }] }
        ]);
        expect(groups.map(g => g.id)).toEqual(['parcels', 'proposals']);
        expect(Model.orderGroups([{ id: 'cities', items: [{ rank: 0 }] }, { id: 'recent', items: [{ rank: 0 }] }]).map(g => g.id))
            .toEqual(['recent', 'cities']);
    });
});

describe('geocoded places', () => {
    const photon = {
        features: [
            { geometry: { coordinates: [15.9649, 45.8126] }, properties: { osm_type: 'W', osm_id: 1, type: 'street', name: 'Ilica', district: 'Donji grad', city: 'Zagreb', country: 'Hrvatska' } },
            { geometry: { coordinates: [15.97, 45.81] }, properties: { osm_type: 'N', osm_id: 2, type: 'house', street: 'Ilica', housenumber: '1', city: 'Zagreb', country: 'Hrvatska' } },
            { geometry: { coordinates: ['x', 1] }, properties: { name: 'broken' } }
        ]
    };

    it('turns Photon features into named places and drops broken ones', () => {
        const places = Model.parsePhoton(photon);
        expect(places).toHaveLength(2);
        expect(places[0]).toMatchObject({ key: 'W1', name: 'Ilica', context: 'Donji grad, Zagreb, Hrvatska', type: 'street', lat: 45.8126, lon: 15.9649 });
        expect(places[1]).toMatchObject({ name: 'Ilica 1', type: 'house' });
    });

    it('zooms close for houses and streets, out for bigger places', () => {
        expect(Model.placeZoom('house')).toBe(18);
        expect(Model.placeZoom('street')).toBe(18);
        expect(Model.placeZoom('city')).toBeLessThan(18);
        expect(Model.placeZoom('country')).toBeLessThan(Model.placeZoom('city'));
    });

    it('calls a place in the current city "here"', () => {
        expect(Model.classifyPlaceLocation({ lat: 45.81, lon: 15.96 }, CITIES, 'zagreb').kind).toBe('here');
    });

    it('keeps a place near another city on the same cadastre "here" (Croatia is one cadastre)', () => {
        expect(Model.classifyPlaceLocation({ lat: 43.51, lon: 16.44 }, CITIES, 'zagreb')).toMatchObject({ kind: 'here', city: { id: 'split' } });
    });

    it('offers the other city when its parcels come from elsewhere', () => {
        expect(Model.classifyPlaceLocation({ lat: 46.05, lon: 14.5 }, CITIES, 'zagreb')).toMatchObject({ kind: 'other-city', city: { id: 'ljubljana' } });
    });

    it('gives a point in a countrywide-live country to the city the coverage names', () => {
        // Rijeka: >60 km from every Croatian city centre, but Croatia's cadastre is countrywide.
        const rijeka = { lat: 45.327, lon: 14.442 };
        expect(Model.classifyPlaceLocation(rijeka, CITIES, 'zagreb').kind).toBe('world');
        expect(Model.classifyPlaceLocation(rijeka, CITIES, 'zagreb', { liveCityId: 'zagreb' })).toMatchObject({ kind: 'here', city: { id: 'zagreb' } });
        expect(Model.classifyPlaceLocation(rijeka, CITIES, 'new_york', { liveCityId: 'zagreb' })).toMatchObject({ kind: 'other-city', city: { id: 'zagreb' } });
    });

    it('calls a place far from every city a world place', () => {
        expect(Model.classifyPlaceLocation({ lat: 48.85, lon: 2.35 }, CITIES, 'zagreb').kind).toBe('world');
        expect(Model.classifyPlaceLocation({ lat: NaN, lon: 2 }, CITIES, 'zagreb').kind).toBe('world');
    });
});

describe('recent searches and keyboard state', () => {
    it('keeps the newest first, one per query (case/accents folded), at most eight', () => {
        let list = [];
        for (let i = 0; i < 10; i += 1) list = Model.pushRecent(list, `q${i}`);
        expect(list).toHaveLength(Model.RECENT_MAX);
        expect(list[0]).toBe('q9');
        list = Model.pushRecent(list, 'Q5');
        expect(list[0]).toBe('Q5');
        expect(list.filter(item => item.toLowerCase() === 'q5')).toHaveLength(1);
        expect(Model.pushRecent(['a', 3, null, ''], '  ')).toEqual(['a']);
    });

    it('wraps the arrow keys and starts from nothing selected', () => {
        expect(Model.moveSelection(-1, 1, 3)).toBe(0);
        expect(Model.moveSelection(-1, -1, 3)).toBe(2);
        expect(Model.moveSelection(2, 1, 3)).toBe(0);
        expect(Model.moveSelection(0, -1, 3)).toBe(2);
        expect(Model.moveSelection(0, 1, 0)).toBe(-1);
    });

    it('maps keys to move / run / close, and Enter with nothing selected runs the first result', () => {
        expect(Model.keyAction('ArrowDown', -1, 4)).toEqual({ type: 'move', index: 0 });
        expect(Model.keyAction('ArrowUp', 0, 4)).toEqual({ type: 'move', index: 3 });
        expect(Model.keyAction('Enter', 2, 4)).toEqual({ type: 'run', index: 2 });
        expect(Model.keyAction('Enter', -1, 4)).toEqual({ type: 'run', index: 0 });
        expect(Model.keyAction('Enter', -1, 0)).toBeNull();
        expect(Model.keyAction('Escape', 1, 4)).toEqual({ type: 'close' });
        expect(Model.keyAction('a', 1, 4)).toBeNull();
    });

    // "Ilica 20" + a quick Enter: the geocoder had not answered, the only row was the "Commands…"
    // hint, and Enter opened the command palette instead of going to the address.
    it('makes a bare Enter wait for pending results and never default to the palette hint', () => {
        const loading = [{ key: 'hint:palette', kind: 'hint' }];
        const opts = list => ({ pending: true, defaultIndex: Model.defaultEnterIndex(list) });
        expect(Model.keyAction('Enter', -1, loading.length, opts(loading))).toEqual({ type: 'wait' });
        expect(Model.keyAction('Enter', -1, 0, { pending: true })).toEqual({ type: 'wait' });

        // Settled with nothing but the hint: Enter does nothing rather than open the palette.
        expect(Model.keyAction('Enter', -1, loading.length, { defaultIndex: Model.defaultEnterIndex(loading) })).toBeNull();

        // Settled with a place: Enter goes to it.
        const settled = [{ key: 'place:N1', kind: 'place' }, { key: 'hint:palette', kind: 'hint' }];
        expect(Model.keyAction('Enter', -1, settled.length, { defaultIndex: Model.defaultEnterIndex(settled) }))
            .toEqual({ type: 'run', index: 0 });
        // An explicitly highlighted row runs even while searches are pending (the hint included).
        expect(Model.keyAction('Enter', 1, settled.length, { pending: true })).toEqual({ type: 'run', index: 1 });
    });

    it('lets the keyboard reach only enabled items, in display order', () => {
        const groups = [{ items: [{ key: 'a' }, { key: 'info', disabled: true }] }, { items: [{ key: 'b' }] }];
        expect(Model.selectableItems(groups).map(item => item.key)).toEqual(['a', 'b']);
    });
});

describe('index.html wiring', () => {
    const scriptIndex = name => indexHtml.indexOf(`'${name}'`);

    it('loads the model, the world coverage lookup and the commands before the search box and the palette', () => {
        for (const name of ['js/ui/search-model.js', 'js/world/world-coverage.js', 'js/ui/map-search.js', 'js/ui/command-palette.js']) {
            expect(scriptIndex(name), name).toBeGreaterThan(-1);
        }
        expect(scriptIndex('js/ui/search-model.js')).toBeLessThan(scriptIndex('js/ui/map-search.js'));
        expect(scriptIndex('js/world/world-coverage.js')).toBeLessThan(scriptIndex('js/ui/map-search.js'));
        expect(scriptIndex('js/ui/commands.js')).toBeLessThan(scriptIndex('js/ui/command-palette.js'));
        expect(indexHtml).toContain("'css/map-search.css'");
        expect(indexHtml).toContain("'css/command-palette.css'");
        expect(indexHtml).toMatch(/initializeMapShell\(\);\s*window\.MapSearch\.initialize\(\);\s*window\.CommandPalette\.initialize\(\);/);
    });

    it('no longer has the old city row or Locate input, which the search box replaced', () => {
        for (const id of ['city-select', 'detect-city-button', 'locateParcelInput', 'locateParcelButton', 'locateParcelError']) {
            expect(indexHtml, id).not.toContain(`id="${id}"`);
        }
        expect(indexHtml).toContain('id="command-palette-button"');
    });
});

describe('translations', () => {
    // Every literal key the search box and the palette pass to t(), in all four locales.
    const sources = ['js/ui/map-search.js', 'js/ui/command-palette.js'].map(file => fs.readFileSync(path.join(FRONTEND, file), 'utf8'));
    const keys = new Set();
    sources.forEach(src => {
        for (const match of src.matchAll(/\bt\('((?:mapSearch|commandPalette|sidebar|world|modal)\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1]);
    });
    const dynamic = [
        ...['recent', 'cities', 'parcels', 'proposals', 'places', 'commands'].map(g => `mapSearch.groups.${g}`),
        ...['disabledIn3D', 'busy', 'hiddenForCity', 'disabled'].map(r => `commandPalette.reason.${r}`),
        ...['live', 'source', 'none', 'unknown'].flatMap(tier => [`world.tier.${tier}.short`, `world.tier.${tier}.text`])
    ];

    it('finds the keys it is checking', () => {
        expect(keys.size).toBeGreaterThan(25);
    });

    it('has every key in en, hr, es and sr', () => {
        for (const key of [...keys, ...dynamic]) {
            for (const lang of LANGS) {
                const value = lookup(dictionaries[lang], key);
                expect(typeof value, `${lang}: ${key}`).toBe('string');
                expect(value.length, `${lang}: ${key}`).toBeGreaterThan(0);
            }
        }
    });

    it('names every command group the palette shows, in all four locales', () => {
        const UiCommands = require('../../frontend/js/ui/commands.js');
        const groups = new Set(UiCommands.listCommands().map(entry => entry.group));
        for (const group of groups) {
            for (const lang of LANGS) {
                expect(typeof lookup(dictionaries[lang], `commandPalette.groups.${group}`), `${lang}: ${group}`).toBe('string');
            }
        }
    });
});
