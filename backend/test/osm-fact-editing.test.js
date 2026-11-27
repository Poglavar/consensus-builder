// Saving building facts to OpenStreetMap from the app: sign-in with PKCE (frontend/js/osm/osm-account.js),
// one changeset that changes only the given tags (osm-edit.js), and the editable facts, their choices
// and the saved buildings that answer until OSM's copy catches up (osm-fact-edits.js, building-facts.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const account = require('../../frontend/js/osm/osm-account.js');
const edit = require('../../frontend/js/osm/osm-edit.js');
const factEdits = require('../../frontend/js/osm/osm-fact-edits.js');
const buildingFacts = require('../../frontend/js/buildings/building-facts.js');

const KEYS = { storeys: 'building:levels', built: 'start_date', roof_shape: 'roof:shape', parapet: 'building:parapet', height_m: 'height' };
const house = (id, facts = {}, version = 4) => ({ id, found: true, facts: { storeys: null, built: null, roof_shape: null, parapet: null, ...facts },
    edit: { url: 'https://www.openstreetmap.org/edit?editor=id&way=1', source: 'OpenStreetMap', keys: KEYS }, source_version: { version, changed: '2026-11-27T10:00:00Z' } });

describe('signing in with OpenStreetMap', () => {
    const store = new Map();
    beforeEach(() => {
        store.clear();
        globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    });
    afterEach(() => { delete globalThis.localStorage; delete globalThis.location; });

    it('makes the PKCE challenge of RFC 7636 and asks only to read the account and edit the map', async () => {
        expect(await account.challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
        const url = new URL(account.authorizeUrl({ redirect: 'https://urbangametheory.xyz/osm-callback.html', state: 's', challenge: 'c' }));
        expect(url.origin + url.pathname).toBe('https://www.openstreetmap.org/oauth2/authorize');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', scope: 'read_prefs write_api', code_challenge_method: 'S256', state: 's', code_challenge: 'c' });
        expect(account.randomString()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
    it('returns to our callback on the registered sites and local pages, and nowhere else', () => {
        const at = href => { const u = new URL(href); return account.redirectUri({ origin: u.origin, hostname: u.hostname }); };
        expect(at('https://urbangametheory.xyz/')).toBe('https://urbangametheory.xyz/osm-callback.html');
        expect(at('http://127.0.0.1:5611/')).toBe('http://127.0.0.1:5611/osm-callback.html');
        expect(at('https://example.org/')).toBeNull();
    });
    it('opens the popup, takes the code from the callback page, trades it for a token and remembers the account', async () => {
        globalThis.location = { origin: 'http://127.0.0.1:5611', hostname: '127.0.0.1' };
        const popup = { location: { href: 'about:blank' } };
        let channel;
        const fetchFn = vi.fn(async (url, options) => (url.endsWith('/oauth2/token')
            ? new Response(JSON.stringify({ access_token: 'tok' }))
            : new Response(JSON.stringify({ user: { id: 7, display_name: 'mapper' } }))));
        const signing = account.signIn({ open: () => popup, fetchFn, channel: () => (channel = { close: vi.fn() }) });
        await vi.waitFor(() => expect(popup.location.href).toMatch(/^https:\/\/www\.openstreetmap\.org\/oauth2\/authorize\?/));
        const state = new URL(popup.location.href).searchParams.get('state');
        channel.onmessage({ data: { type: 'cb-osm-auth', state: 'someone-else', code: 'x' } });
        channel.onmessage({ data: { type: 'cb-osm-auth', state, code: 'the-code' } });
        expect(await signing).toEqual({ id: 7, name: 'mapper' });
        const body = Object.fromEntries(fetchFn.mock.calls[0][1].body);
        expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'http://127.0.0.1:5611/osm-callback.html' });
        expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe('Bearer tok');
        expect(account.token()).toBe('tok');
        expect(account.user()).toEqual({ id: 7, name: 'mapper' });
        account.signOut();
        expect(account.token()).toBeNull();
    });
    it('says so when the person declines or the popup is blocked', async () => {
        globalThis.location = { origin: 'http://127.0.0.1:5611', hostname: '127.0.0.1' };
        await expect(account.signIn({ open: () => null, channel: () => ({ close() {} }) })).rejects.toThrow('blocked');
        const popup = { location: { href: '' } };
        let channel;
        const signing = account.signIn({ open: () => popup, channel: () => (channel = { close() {} }) });
        await vi.waitFor(() => expect(popup.location.href).toContain('authorize'));
        channel.onmessage({ data: { type: 'cb-osm-auth', state: new URL(popup.location.href).searchParams.get('state'), error: 'access_denied' } });
        await expect(signing).rejects.toThrow('OpenStreetMap: access_denied');
        expect(account.token()).toBeNull();
    });
});

describe('saving tags in one changeset', () => {
    const way = (id, version, tags = {}) => ({ type: 'way', id, version, nodes: [1, 2, 3, 1], tags: { building: 'house', ...tags } });
    const osm = (elements, { conflict = false } = {}) => {
        const calls = [];
        const fetchFn = vi.fn(async (url, options = {}) => {
            calls.push([options.method || 'GET', url.replace('https://api.openstreetmap.org/api/0.6/', ''), options.body]);
            if (url.includes('/ways.json')) return new Response(JSON.stringify({ elements }));
            if (url.endsWith('changeset/create')) return new Response('555');
            if (url.endsWith('/upload')) return conflict ? new Response('Version mismatch', { status: 409 })
                : new Response(`<diffResult>${elements.map(e => `<way old_id="${e.id}" new_id="${e.id}" new_version="${e.version + 1}"/>`).join('')}</diffResult>`);
            return new Response('');
        });
        return { fetchFn, calls };
    };
    it('reads the buildings, changes only the given tags, uploads with the versions read, and closes the changeset', async () => {
        const { fetchFn, calls } = osm([way(36, 6, { 'building:parapet': 'yes', name: 'A & B' }), way(37, 2)]);
        const result = await edit.saveTags([{ id: 'osm:way/36', tags: { 'roof:shape': 'butterfly' } }, { id: 'osm:way/37', tags: { 'roof:shape': 'butterfly' } }],
            { token: 'tok', comment: 'Add roof:shape to 2 buildings', fetchFn });
        expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual(['GET ways.json?ways=36,37', 'PUT changeset/create', 'POST changeset/555/upload', 'PUT changeset/555/close']);
        expect(calls[1][2]).toContain('<tag k="comment" v="Add roof:shape to 2 buildings"/>');
        const upload = calls[2][2];
        expect(upload).toContain('<way id="36" version="6" changeset="555"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/>');
        expect(upload).toContain('<tag k="name" v="A &amp; B"/>');
        expect(upload).toContain('<tag k="building:parapet" v="yes"/>');
        expect(upload.match(/<tag k="roof:shape" v="butterfly"\/>/g)).toHaveLength(2);
        expect(result).toEqual({ changeset: 555, versions: new Map([['osm:way/36', 7], ['osm:way/37', 3]]) });
        expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    });
    it('opens no changeset when every building already says so', async () => {
        const { fetchFn, calls } = osm([way(36, 6, { 'roof:shape': 'flat' })]);
        expect(await edit.saveTags([{ id: 'osm:way/36', tags: { 'roof:shape': 'flat' } }], { token: 't', comment: 'c', fetchFn })).toEqual({ changeset: null, versions: new Map([['osm:way/36', 6]]) });
        expect(calls).toHaveLength(1);
    });
    it('refuses to overwrite a building someone changed meanwhile, and still closes the changeset', async () => {
        const { fetchFn, calls } = osm([way(36, 6)], { conflict: true });
        await expect(edit.saveTags([{ id: 'osm:way/36', tags: { 'roof:shape': 'flat' } }], { token: 't', comment: 'c', fetchFn })).rejects.toThrow('Someone else changed way 36');
        expect(calls.at(-1).slice(0, 2)).toEqual(['PUT', 'changeset/555/close']);
    });
    it('writes relations with their members', () => {
        expect(edit.elementXml({ type: 'relation', id: 9, version: 1, members: [{ type: 'way', ref: 5, role: 'outer' }], tags: { type: 'multipolygon' } }, 2))
            .toBe('<relation id="9" version="1" changeset="2"><member type="way" ref="5" role="outer"/><tag k="type" v="multipolygon"/></relation>');
        expect(edit.parseDiffResult('<diffResult><relation old_id="9" new_id="9" new_version="2"/></diffResult>').get('osm:relation/9')).toBe(2);
    });
});

describe('the facts a person can add', () => {
    it('offers the unknown facts the source names a key for, with their choices', () => {
        expect(factEdits.missingEditable(house('osm:way/36', { parapet: { value: true } }))).toEqual(['roof_shape', 'storeys']);
        expect(factEdits.missingEditable(house('osm:way/36'), ['parapet'])).toEqual(['parapet']);
        expect(factEdits.missingEditable({ ...house('osm:way/36'), found: false })).toEqual([]);
        expect(factEdits.factValue('parapet', 'yes')).toBe(true);
        expect(factEdits.factValue('storeys', '3')).toBe(3);
        expect(factEdits.factValue('storeys', '0')).toBeNull();
        expect(factEdits.factValue('roof_shape', 'onion')).toBeNull();
        expect(factEdits.editsOf([{ building: house('osm:way/36'), values: { roof_shape: 'butterfly', parapet: '' } }, { building: house('osm:way/37'), values: {} }]))
            .toEqual([{ id: 'osm:way/36', tags: { 'roof:shape': 'butterfly' } }]);
        expect(() => factEdits.editsOf([{ building: house('osm:way/36'), values: { parapet: 'maybe' } }])).toThrow('Not a choice');
    });
    it('signs in first when needed, saves, and answers with the saved facts until the source has the new version', async () => {
        let token = null;
        const accountFake = { token: () => token, signIn: vi.fn(async () => { token = 'tok'; }), signOut: vi.fn() };
        const editFake = { saveTags: vi.fn(async () => ({ changeset: 555, versions: new Map([['osm:way/36', 7]]) })) };
        const entries = [{ building: house('osm:way/36', {}, 6), values: { roof_shape: 'butterfly' } }];
        const result = await factEdits.save(entries, { comment: factEdits.commentFor(entries), account: accountFake, edit: editFake, now: () => '2026-11-27T16:00:00Z' });
        expect(accountFake.signIn).toHaveBeenCalledOnce();
        expect(editFake.saveTags).toHaveBeenCalledWith([{ id: 'osm:way/36', tags: { 'roof:shape': 'butterfly' } }], { token: 'tok', comment: 'Add roof:shape to 1 building' });
        const saved = result.buildings.get('osm:way/36');
        expect(saved.facts.roof_shape).toEqual({ value: 'butterfly', source: 'osm', key: 'roof:shape', raw: 'butterfly' });
        expect(saved.source_version).toEqual({ version: 7, changed: '2026-11-27T16:00:00Z' });
        // The API still answers version 6 (Overpass and its cache lag): the saved building answers.
        const answer = version => async () => new Response(JSON.stringify({ buildings: [house('osm:way/36', {}, version)], sources: [] }));
        expect((await buildingFacts.read('osm:way/36', { fetchFn: answer(6), base: 'https://example.test/api' })).facts.roof_shape.value).toBe('butterfly');
        // Once it answers version 7, the source's own read is shown and the saved one forgotten.
        expect((await buildingFacts.read('osm:way/36', { fetchFn: answer(7), base: 'https://example.test/api' })).facts.roof_shape).toBeNull();
        expect((await buildingFacts.read('osm:way/36', { fetchFn: answer(6), base: 'https://example.test/api' })).facts.roof_shape).toBeNull();
    });
    it('forgets a refused token, so the next save signs in again', async () => {
        const accountFake = { token: () => 'old', signIn: vi.fn(), signOut: vi.fn() };
        const editFake = { saveTags: async () => { throw new Error('OpenStreetMap opening a changeset HTTP 401: Unauthorized'); } };
        await expect(factEdits.save([{ building: house('osm:way/36'), values: { parapet: 'yes' } }], { comment: 'c', account: accountFake, edit: editFake })).rejects.toThrow('401');
        expect(accountFake.signOut).toHaveBeenCalledOnce();
        await expect(factEdits.save([{ building: house('osm:way/36'), values: {} }], { comment: 'c', account: accountFake, edit: editFake })).rejects.toThrow('Choose at least one');
    });
});
