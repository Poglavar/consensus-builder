// The building card's facts client (frontend/js/buildings/building-facts.js): which buildings the
// shared API's facts contract answers, the live read, and the card's rows in words.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const facts = require('../../frontend/js/buildings/building-facts.js');

const t = (key, params = {}) => `${key}(${Object.values(params).join('|')})`;
const answer = building => ({ buildings: [building], fields: ['storeys', 'built', 'roof_shape', 'parapet', 'height_m'], sources: [{ id: 'osm' }] });
const KEYS = { storeys: 'building:levels', built: 'start_date', roof_shape: 'roof:shape', parapet: 'building:parapet', height_m: 'height' };
const house = {
    id: 'osm:way/123', found: true,
    facts: { storeys: { value: 3, source: 'osm', key: 'building:levels', raw: '3' }, built: { value: { from: null, to: 1912 }, source: 'osm', key: 'start_date', raw: 'before 1913' },
        roof_shape: null, parapet: null, height_m: null, heritage: null },
    unknown_reasons: { heritage: { code: 'row-uncertain', message: 'A listed entry on this row may cover this house.',
        entries: [{ reference: '1195683', name: 'NUMBERS 26 TO 50', grade: 'II', url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683' }] } },
    edit: { url: 'https://www.openstreetmap.org/edit?editor=id&way=123', source: 'OpenStreetMap', keys: KEYS },
};

describe('building facts client', () => {
    it('names OSM ways and relations as the contract does, and nothing else', () => {
        expect(facts.factIdOf({ id: 'w123', properties: {} })).toBe('osm:way/123');
        expect(facts.factIdOf({ properties: { osm_id: 'r45' } })).toBe('osm:relation/45');
        expect(facts.factIdOf({ properties: {} }, 'osm:w7')).toBe('osm:way/7');
        // A 2D pool building: its id is in properties, its key is `osm:<id>`.
        expect(facts.factIdOf({ properties: { id: 'w31025114', source: 'osm' } })).toBe('osm:way/31025114');
        expect(facts.factIdOf({ id: 4711, properties: { object_id: 4711 } }, '4711')).toBeNull();
        expect(facts.factIdOf({ id: 'n9', properties: {} })).toBeNull();
    });
    it('reads one building live from the contract, and fails loudly on a bad answer', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify(answer(house))));
        const building = await facts.read('osm:way/123', { fetchFn, base: 'https://example.test/api' });
        expect(fetchFn).toHaveBeenCalledWith('https://example.test/api/building-facts?ids=osm%3Away%2F123', { cache: 'no-store' });
        // Check again asks the API to read the source again rather than answer from its 5-minute cache.
        await facts.read('osm:way/123', { fetchFn, base: 'https://example.test/api', fresh: true });
        expect(fetchFn).toHaveBeenLastCalledWith('https://example.test/api/building-facts?ids=osm%3Away%2F123&fresh=1', { cache: 'no-store' });
        expect(building.facts.storeys.value).toBe(3);
        await expect(facts.read('osm:way/123', { fetchFn: async () => new Response('busy', { status: 502 }) })).rejects.toThrow('HTTP 502');
        await expect(facts.read('osm:way/9', { fetchFn: async () => new Response(JSON.stringify(answer(house))) })).rejects.toThrow('Invalid');
    });
    // OpenStreetMap shows an edit on Overpass a minute or two after it is saved: Check again keeps
    // reading until a building's version moves, and gives up after its last attempt.
    it('after an edit, reads again until the source shows a change', async () => {
        const at = version => ({ id: 'osm:way/1', found: true, facts: {}, source_version: { version } });
        const shown = new Map([['osm:way/1', at(5)], ['osm:way/2', at(1)]]);
        const versions = [5, 5, 6];
        const read = vi.fn(async ids => new Map(ids.map(id => [id, id === 'osm:way/1' ? at(versions.shift()) : at(1)])));
        const waits = [], waiting = [];
        const result = await facts.readUntilChanged(['osm:way/1', 'osm:way/2'], shown, read, { wait: async ms => { waits.push(ms); }, onWaiting: attempt => waiting.push(attempt) });
        expect(result.changed).toBe(true);
        expect(result.answer.get('osm:way/1').source_version.version).toBe(6);
        expect(read).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([30_000, 30_000]);
        expect(waiting).toEqual([1, 2]);
        // Nothing changes: seven reads, about three minutes, then it says so.
        const still = vi.fn(async ids => new Map(ids.map(id => [id, at(id === 'osm:way/1' ? 5 : 1)])));
        expect((await facts.readUntilChanged(['osm:way/1', 'osm:way/2'], shown, still, { wait: async () => {} })).changed).toBe(false);
        expect(still).toHaveBeenCalledTimes(7);
        // The card closed: it stops after the wait instead of reading again.
        const closed = vi.fn(async ids => new Map(ids.map(id => [id, at(5)])));
        await facts.readUntilChanged(['osm:way/1'], shown, closed, { wait: async () => {}, stillWanted: () => false });
        expect(closed).toHaveBeenCalledTimes(1);
        // A building first found (none shown before) counts as a change.
        expect((await facts.readUntilChanged(['osm:way/1'], new Map(), still, { wait: async () => {} })).changed).toBe(true);
    });
    it('puts spans of years in words', () => {
        expect(facts.builtWords({ from: 1890, to: 1890 }, t)).toBe('1890');
        expect(facts.builtWords({ from: null, to: 1912 }, t)).toBe('builtBefore(1913)');
        expect(facts.builtWords({ from: 1823, to: null }, t)).toBe('builtAfter(1823)');
        expect(facts.builtWords({ from: 1860, to: 1869 }, t)).toBe('builtBetween(1860|1869)');
    });
    it('lists each card fact in words, unknown ones as null with the key to add them under', () => {
        const rows = facts.cardRows(house, t);
        expect(rows.map(row => [row.field, row.text, row.key])).toEqual([
            ['storeys', '3', 'building:levels'], ['built', 'builtBefore(1913)', 'start_date'],
            ['roof_shape', null, 'roof:shape'], ['parapet', null, 'building:parapet'], ['heritage', null, null],
        ]);
        // A register fact has no OpenStreetMap key: its row names why it is unknown and links the entry in question.
        expect(rows[4]).toMatchObject({ reason: 'heritageUnknown.rowUncertain()', link: { url: 'https://historicengland.org.uk/listing/the-list/list-entry/1195683', text: 'heritageEntry(1195683)' } });
        const parapet = { ...house, facts: { ...house.facts, parapet: { value: true, source: 'osm', key: 'building:parapet', raw: 'yes' } } };
        expect(facts.cardRows(parapet, t)[3].text).toBe('parapetYes()');
        // A build date from a building register links its record (the licence's attribution) and has no OSM key.
        const registered = { ...house, facts: { ...house.facts, built: { value: { from: 1920, to: 1939 }, source: 'colouring-britain', key: 'date_year',
            raw: '1930 (1920–1939), Historical map [5]', label: 'Colouring Britain (Colouring London)', url: 'https://colouringbritain.org/view/age/5' } } };
        expect(facts.cardRows(registered, t)[1]).toMatchObject({ text: 'builtBetween(1920|1939)', key: null,
            link: { url: 'https://colouringbritain.org/view/age/5', text: 'Colouring Britain (Colouring London)' } });
    });
    it('puts a heritage listing in words with the grade as the register states it, and links its entry or register', () => {
        const value = (listed, grade, extra = {}) => ({ value: { listed, grade, register: 'National Heritage List for England', reference: listed ? '1195683' : null, name: null,
            url: listed ? 'https://historicengland.org.uk/listing/the-list/list-entry/1195683' : 'https://www.planning.data.gov.uk/dataset/listed-building', basis: listed ? 'outline' : 'none', ...extra }, source: 'gb-eng-nhle', key: 'listed-building', raw: 'x' });
        const row = heritage => facts.cardRows({ ...house, unknown_reasons: {}, facts: { ...house.facts, heritage } }, t)[4];
        expect(row(value(true, 'II*'))).toMatchObject({ text: 'heritageListed(II*)', reason: null, link: { text: 'heritageEntry(1195683)' } });
        expect(row(value(true, null)).text).toBe('heritageListedNoGrade()');
        expect(row(value(false, null))).toMatchObject({ text: 'heritageNotListed()', link: { url: 'https://www.planning.data.gov.uk/dataset/listed-building', text: 'heritageRegister()' } });
        // Outside every register: unknown, with the reason and no link.
        const outside = facts.cardRows({ ...house, unknown_reasons: { heritage: { code: 'no-register', message: 'x' } } }, t)[4];
        expect(outside).toMatchObject({ text: null, reason: 'heritageUnknown.noRegister()', link: null });
    });
    it('uses a local shared API only on a local page that asks for one', () => {
        const at = (hostname, search) => ({ hostname, search });
        expect(facts.apiRoot(at('localhost', '?sharedApi=http://localhost:3201/api'))).toBe('http://localhost:3201/api');
        expect(facts.apiRoot(at('localhost', '?sharedApi=https://evil.test/api'))).toBe(facts.API_ROOT);
        expect(facts.apiRoot(at('urbangametheory.xyz', '?sharedApi=http://localhost:3201/api'))).toBe(facts.API_ROOT);
    });
});
