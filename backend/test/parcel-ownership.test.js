// Behaviour of the pluggable ownership layer: registry dispatch by parcel source, the
// parcel-ownership/1 contract check, the linked-endpoint adapter, the five built-in adapters, the
// one route, and the frontend request built from a parcel's source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createRouteApp } from './helpers/create-route-app.js';
import { setupParcelOwnershipRoute } from '../routes/parcel-ownership.js';
import { createOwnershipRegistry, BUILTIN_OWNERSHIP_ADAPTERS } from '../ownership/registry.js';
import { buildOwnershipRecord, ownershipRecordProblems, OwnershipContractError } from '../ownership/contract.js';
import { __clearCache } from '../routes/nyc-condo-owners.js';

const ANSWER = { parcelId: 'X-1', owners: [{ name: 'GRAD ZAGREB', shareText: '1/1', sharePercent: 100 }], observedAt: '2024', retrievedAt: null };

function fakeAdapter(name, answer = ANSWER) {
    return { name, lookup: vi.fn(async ({ parcelId }) => (answer ? { ...answer, parcelId } : answer)) };
}

function appWith(catalog, adapters, fetchImpl) {
    const registry = createOwnershipRegistry({ catalog, adapters, fetchImpl });
    return createRouteApp(setupParcelOwnershipRoute, { query: vi.fn() }, { registry });
}

// A pool that answers one statement: the adapters each run exactly one query.
function poolAnswering(rows) {
    return { query: vi.fn(async () => ({ rows })) };
}

afterEach(() => vi.restoreAllMocks());

describe('registry dispatch by parcel source', () => {
    const catalog = {
        sources: [{ id: 'src-a', ownership: { adapter: 'a', attribution: 'Register A' } }],
        databaseSources: [{ id: 'src-b', ownership: { adapter: 'b', attribution: 'Register B', licence: 'CC-BY-4.0' } }]
    };

    it('sends each source to its own declared adapter and stamps that source\'s attribution', async () => {
        const a = fakeAdapter('a'), b = fakeAdapter('b');
        const app = appWith(catalog, { a, b });
        const res = await request(app).get('/parcel-ownership/src-b/X-1');
        expect(res.status).toBe(200);
        expect(b.lookup).toHaveBeenCalledOnce();
        expect(a.lookup).not.toHaveBeenCalled();
        expect(res.body).toEqual({
            contract: 'parcel-ownership/1', sourceId: 'src-b', parcelId: 'X-1',
            owners: [{ name: 'GRAD ZAGREB', shareText: '1/1', sharePercent: 100, ownerType: 'government' }],
            ownershipType: 'government', observedAt: '2024', retrievedAt: null,
            attribution: 'Register B', licence: 'CC-BY-4.0'
        });
        expect(ownershipRecordProblems(res.body)).toEqual([]);
    });

    it('passes a parcel id with slashes through whole', async () => {
        const a = fakeAdapter('a'), b = fakeAdapter('b');
        const res = await request(appWith(catalog, { a, b })).get(`/parcel-ownership/src-a/${encodeURIComponent('HR-335258-4341/2')}`);
        expect(res.status).toBe(200);
        expect(a.lookup.mock.calls[0][0].parcelId).toBe('HR-335258-4341/2');
        expect((await request(appWith(catalog, { a, b })).get('/parcel-ownership/src-a/HR-335258-4341/2')).body.parcelId).toBe('HR-335258-4341/2');
    });

    it('answers 404 no-ownership-adapter for a source that declares none, without touching any adapter', async () => {
        const a = fakeAdapter('a');
        const res = await request(appWith({ sources: [...catalog.sources, { id: 'geometry-only' }] }, { a })).get('/parcel-ownership/geometry-only/P-1');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('no-ownership-adapter');
        expect(a.lookup).not.toHaveBeenCalled();
    });

    it('answers 404 ownership-not-found when the adapter knows no such parcel', async () => {
        const res = await request(appWith(catalog, { a: fakeAdapter('a', null), b: fakeAdapter('b') })).get('/parcel-ownership/src-a/X-9');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ownership-not-found');
    });

    it('refuses a broken declaration at startup', () => {
        const build = ownership => () => createOwnershipRegistry({ catalog: { sources: [{ id: 's', ownership }] }, adapters: { a: fakeAdapter('a') } });
        expect(build({ adapter: 'missing', attribution: 'x' })).toThrow(/unknown adapter/);
        expect(build({ adapter: 'a' })).toThrow(/attribution/);
        expect(build({ adapter: 'a', http: { urlTemplate: 'https://e.org/{parcelId}' }, attribution: 'x' })).toThrow(/exactly one/);
        expect(build({ http: { urlTemplate: 'http://e.org/{parcelId}' }, attribution: 'x' })).toThrow(/https/);
        expect(build({ http: { urlTemplate: 'https://e.org/parcel' }, attribution: 'x' })).toThrow(/\{parcelId\}/);
    });

    it('binds the five database-backed cities to the five built-in adapters, and Denver to none', async () => {
        const catalog = JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8'));
        const bound = Object.fromEntries(catalog.databaseSources.map(source => [source.id, source.ownership.adapter]));
        expect(bound).toEqual({ 'oss-wfs': 'hr-oss', 'parcel-ba': 'ar-caba', 'parcel-bg': 'rs-bg', 'parcel-lj': 'si-gurs', 'parcel-nyc': 'us-nyc' });
        const registry = createOwnershipRegistry({ catalog });
        expect(registry.sourceIds().sort()).toEqual(Object.keys(bound).sort());
        const res = await request(createRouteApp(setupParcelOwnershipRoute, { query: vi.fn() }, { registry }))
            .get('/parcel-ownership/us-co-oit-public-parcels-denver/US-CO-1');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('no-ownership-adapter');
    });
});

describe('the parcel-ownership/1 contract', () => {
    const wrap = answer => buildOwnershipRecord(answer, { sourceId: 's', parcelId: 'X-1', attribution: 'A' });

    it.each([
        ['an owner without a name', { ...ANSWER, owners: [{ name: ' ' }] }, /name must be a non-empty string/],
        ['a share above 100 %', { ...ANSWER, owners: [{ name: 'A', sharePercent: 150 }] }, /sharePercent/],
        ['a missing observedAt', { parcelId: 'X-1', owners: [] }, /observedAt is required/],
        ['a fetch-style timestamp in the wrong format', { ...ANSWER, observedAt: 'yesterday' }, /observedAt must be/],
        ['an answer for another parcel', { ...ANSWER, parcelId: 'X-2' }, /parcelId must be "X-1"/],
        ['an unknown field', { ...ANSWER, wallet: '0xabc' }, /unknown field "wallet"/],
        ['owners that are not a list', { ...ANSWER, owners: { name: 'A' } }, /owners must be an array/],
        ['an owner type outside the vocabulary', { ...ANSWER, owners: [{ name: 'A', ownerType: 'alien' }] }, /ownerType/]
    ])('rejects %s', (_label, answer, message) => {
        expect(() => wrap(answer)).toThrow(OwnershipContractError);
        expect(() => wrap(answer)).toThrow(message);
    });

    it('turns an adapter that breaks the contract into a 502 the UI never renders', async () => {
        const app = appWith({ sources: [{ id: 's', ownership: { adapter: 'bad', attribution: 'A' } }] },
            { bad: fakeAdapter('bad', { ...ANSWER, owners: [{ name: '' }] }) });
        const res = await request(app).get('/parcel-ownership/s/X-1');
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('ownership-contract-violation');
        expect(res.body).not.toHaveProperty('owners');
    });
});

describe('http adapter (a linked endpoint)', () => {
    const catalog = { sources: [{ id: 'linked', ownership: {
        http: { urlTemplate: 'https://owners.example.org/parcels/{parcelId}', timeoutMs: 50 },
        attribution: 'Example register', licence: 'ODbL-1.0'
    } }] };
    const ok = body => ({ ok: true, status: 200, json: async () => body });

    it('fetches only the registered URL, with the id encoded, and validates the answer', async () => {
        const fetchImpl = vi.fn(async () => ok({ parcelId: 'LN-7/1', owners: [{ name: 'Acme d.o.o.', shareText: '1/2', sharePercent: 50 }], observedAt: '2026-09-30' }));
        const res = await request(appWith(catalog, BUILTIN_OWNERSHIP_ADAPTERS, fetchImpl))
            .get(`/parcel-ownership/linked/${encodeURIComponent('LN-7/1')}?url=${encodeURIComponent('https://attacker.example/')}`);
        expect(res.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][0]).toBe('https://owners.example.org/parcels/LN-7%2F1');
        expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(res.body).toMatchObject({ sourceId: 'linked', attribution: 'Example register', licence: 'ODbL-1.0', observedAt: '2026-09-30',
            owners: [{ name: 'Acme d.o.o.', shareText: '1/2', sharePercent: 50, ownerType: 'company' }] });
    });

    it('fails loudly when the endpoint answers the wrong shape', async () => {
        const fetchImpl = vi.fn(async () => ok({ parcelId: 'LN-1', owner: 'Somebody' }));
        const res = await request(appWith(catalog, BUILTIN_OWNERSHIP_ADAPTERS, fetchImpl)).get('/parcel-ownership/linked/LN-1');
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('ownership-contract-violation');
        expect(res.body.error).toMatch(/unknown field "owner"/);
    });

    it('maps an endpoint 404 to ownership-not-found and other failures to 502', async () => {
        const notFound = vi.fn(async () => ({ ok: false, status: 404 }));
        expect((await request(appWith(catalog, BUILTIN_OWNERSHIP_ADAPTERS, notFound)).get('/parcel-ownership/linked/LN-1')).body.code).toBe('ownership-not-found');
        const broken = vi.fn(async () => ({ ok: false, status: 500 }));
        const res = await request(appWith(catalog, BUILTIN_OWNERSHIP_ADAPTERS, broken)).get('/parcel-ownership/linked/LN-1');
        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/HTTP 500/);
    });

    it('gives up after the registered timeout with a 504', async () => {
        const hanging = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        const res = await request(appWith(catalog, BUILTIN_OWNERSHIP_ADAPTERS, hanging)).get('/parcel-ownership/linked/LN-1');
        expect(res.status).toBe(504);
        expect(res.body.error).toMatch(/50 ms/);
    });
});

describe('built-in adapters', () => {
    const lookup = (name, parcelId, pool, extra = {}) => BUILTIN_OWNERSHIP_ADAPTERS[name].lookup({ parcelId, pool, ...extra });

    it('hr-oss reads the latest parcel-info by KO and the full parcel number, slash included', async () => {
        const pool = poolAnswering([{ date_added: new Date('2026-02-28T12:21:16Z'), details: { upisaneOsobe: [
            { naziv: 'Ana Horvat', udio: '1/2' }, { naziv: 'GRAD ZAGREB', udio: '1/2' }, { naziv: '', udio: '1/1' }
        ] } }]);
        const answer = await lookup('hr-oss', 'HR-335258-4341/2', pool);
        expect(pool.query.mock.calls[0][1]).toEqual([335258, '4341/2']);
        expect(answer).toEqual({ parcelId: 'HR-335258-4341/2', observedAt: null, retrievedAt: '2026-02-28T12:21:16.000Z', owners: [
            { name: 'Ana Horvat', shareText: '1/2', sharePercent: 50 }, { name: 'GRAD ZAGREB', shareText: '1/2', sharePercent: 50 }
        ] });
        await expect(lookup('hr-oss', '335258-4341/2', pool)).rejects.toMatchObject({ status: 400 });
        expect(await lookup('hr-oss', 'HR-1-1', poolAnswering([]))).toBeNull();
    });

    it('ar-caba lists horizontal-property units with their percentages', async () => {
        const pool = poolAnswering([{ date_updated: '2025-12-02T20:33:10Z', property_horizontal: { phs: [
            { dpto: '0001', piso: 'PB', porcentual: '3.16' }, { dpto: '', porcentual: null }
        ] } }]);
        const answer = await lookup('ar-caba', 'AR-001-001-008A', pool);
        expect(pool.query.mock.calls[0][1]).toEqual(['001-001-008A']);
        expect(answer.owners).toEqual([
            { name: 'dpto 0001, piso PB', shareText: '3.16%', sharePercent: 3.16 },
            { name: 'unidad 2', shareText: null, sharePercent: null }
        ]);
        await expect(lookup('ar-caba', '001-001-008A', pool)).rejects.toMatchObject({ status: 400 });
    });

    it('rs-bg answers a known parcel with no owners, since the layer publishes none', async () => {
        const pool = poolAnswering([{ '?column?': 1 }]);
        expect(await lookup('rs-bg', 'SR-703648-1119/1', pool)).toEqual({ parcelId: 'SR-703648-1119/1', owners: [], observedAt: null, retrievedAt: null });
        expect(pool.query.mock.calls[0][1]).toEqual([703648, '1119/1']);
        expect(await lookup('rs-bg', 'SR-1-1', poolAnswering([]))).toBeNull();
    });

    it('si-gurs gives each current right its share and dates the state by the newest right', async () => {
        const pool = poolAnswering([
            { oseba_id: 2786, share_num: 1, share_den: 2, meta: {}, datum_od: new Date('2022-05-30T08:41:43Z'), date_added: new Date('2025-12-27T16:43:27Z') },
            { oseba_id: 9001, share_num: 1, share_den: 2, meta: { naziv: 'Mestna občina Ljubljana' }, datum_od: new Date('2023-01-10T00:00:00Z'), date_added: new Date('2025-12-27T16:43:27Z') }
        ]);
        const answer = await lookup('si-gurs', 'SI-100100000277831217', pool);
        expect(pool.query.mock.calls[0][1]).toEqual(['100100000277831217']);
        expect(answer.owners).toEqual([
            { name: 'Owner 2786', shareText: '1/2', sharePercent: 50 },
            { name: 'Mestna občina Ljubljana', shareText: '1/2', sharePercent: 50 }
        ]);
        expect(answer.observedAt).toBe('2023-01-10T00:00:00.000Z');
        expect(answer.retrievedAt).toBe('2025-12-27T16:43:27.000Z');
    });

    describe('us-nyc', () => {
        beforeEach(() => __clearCache());
        const pvad = rows => vi.fn(async () => ({ ok: true, json: async () => rows, text: async () => '' }));

        it('replaces UNAVAILABLE OWNER with DOF condo unit owners and dates them by the DOF roll year', async () => {
            const pool = poolAnswering([{ swis_sbl_id: '6201001005527502', sbl: '1005527502', roll_yr: 2024, date_updated: '2026-02-03T02:43:44Z', primary_owner: ['UNAVAILABLE OWNER'] }]);
            const fetchImpl = pvad([
                { lot: '7502', year: '2027', owner: 'UNAVAILABLE OWNER', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
                { lot: '1101', year: '2027', owner: 'JOEL SHARIR', housenum_lo: '106', street_name: 'WAVERLY PLACE' },
                { lot: '1102', year: '2026', owner: 'JANE DOE', housenum_lo: '106', street_name: 'WAVERLY PLACE' }
            ]);
            const answer = await lookup('us-nyc', 'US-NY-6201001005527502', pool, { fetchImpl });
            expect(answer.owners.map(owner => owner.name).sort()).toEqual(['JANE DOE', 'JOEL SHARIR']);
            expect(answer.owners.every(owner => owner.shareText === null && owner.sharePercent === null)).toBe(true);
            expect(answer.observedAt).toBe('2027');
        });

        it('keeps the roll owner and roll year without calling DOF when the parcel has a real owner', async () => {
            const pool = poolAnswering([{ swis_sbl_id: '100001', sbl: '1000010001', roll_yr: 2024, date_updated: '2026-02-03T02:43:44Z', primary_owner: ['City of New York'] }]);
            const fetchImpl = vi.fn();
            const answer = await lookup('us-nyc', 'US-NY-100001', pool, { fetchImpl });
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(answer).toMatchObject({ owners: [{ name: 'City of New York' }], observedAt: '2024', retrievedAt: '2026-02-03T02:43:44.000Z' });
        });

        it('shows no owner rather than the placeholder when DOF resolves nobody', async () => {
            const pool = poolAnswering([{ swis_sbl_id: '6201001005527502', sbl: '1005527502', roll_yr: 2024, primary_owner: ['UNAVAILABLE OWNER'] }]);
            const answer = await lookup('us-nyc', 'US-NY-6201001005527502', pool, { fetchImpl: pvad([]) });
            expect(answer.owners).toEqual([]);
        });
    });
});

describe('frontend ownership request', () => {
    function loadUi(parcels) {
        const scope = {
            console, document: { getElementById: () => null, querySelector: () => null },
            fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ contract: 'parcel-ownership/1',
                owners: [{ name: 'Ana Horvat', shareText: '1/2', sharePercent: 50, ownerType: 'private individual' }] }) })),
            getBackendBase: () => 'http://localhost:3000/',
            formatPercentValue: value => `${value}%`, formatSharePercent: value => value,
            CityConfigManager: { getCurrentCityConfig: () => ({ parcels }) }
        };
        scope.window = scope;
        const context = createContext(scope);
        for (const file of ['ownership.js', 'ownership-ui.js']) {
            runInContext(readFileSync(new URL(`../../frontend/js/parcels/${file}`, import.meta.url), 'utf8'), context);
        }
        return scope;
    }

    it.each([
        ['Zagreb (database)', { source: 'oss-wfs' }, 'HR-335258-4341/2', '/parcel-ownership/oss-wfs/HR-335258-4341%2F2'],
        ['Buenos Aires (database), AR- prefix kept', { source: 'parcel-ba' }, 'AR-001-001-008A', '/parcel-ownership/parcel-ba/AR-001-001-008A'],
        ['Belgrade (database)', { source: 'parcel-bg' }, 'SR-703648-1119/1', '/parcel-ownership/parcel-bg/SR-703648-1119%2F1'],
        ['Ljubljana (database)', { source: 'parcel-lj' }, 'SI-100100000277831217', '/parcel-ownership/parcel-lj/SI-100100000277831217'],
        ['New York (database)', { source: 'parcel-nyc' }, 'US-NY-6201001000167509', '/parcel-ownership/parcel-nyc/US-NY-6201001000167509'],
        ['a catalog source', { source: 'parcel-source', sourceId: 'gb-hmlr-london-v2', idPrefix: 'GB-HMLR-LONDON-V2-',
            historicalSources: [{ sourceId: 'gb-hmlr-city-of-london', idPrefix: 'GB-HMLR-LONDON-' }] }, 'GB-HMLR-LONDON-123', '/parcel-ownership/gb-hmlr-city-of-london/GB-HMLR-LONDON-123']
    ])('asks the one route with the parcel source of %s', async (_label, parcels, parcelId, path) => {
        const scope = loadUi(parcels);
        const owners = await scope.ParcelsOwnershipUi.fetchOwnersFromBackend(parcelId);
        expect(scope.fetch).toHaveBeenCalledOnce();
        expect(scope.fetch.mock.calls[0][0]).toBe(`http://localhost:3000${path}`);
        expect(owners).toEqual([expect.objectContaining({ name: 'Ana Horvat', ownership: '1/2', percentageShare: 50, ownerType: 'private individual' })]);
    });

    it('asks nothing for a city whose config says it has no ownership', async () => {
        const scope = loadUi({ source: 'parcel-source', sourceId: 'us-co-oit-public-parcels-denver', ownership: false });
        expect(await scope.ParcelsOwnershipUi.fetchOwnersFromBackend('US-CO-1')).toEqual([]);
        expect(scope.fetch).not.toHaveBeenCalled();
    });

    it('rejects an answer that is not a contract record', async () => {
        const scope = loadUi({ source: 'oss-wfs' });
        scope.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ possessionSheets: [] }) });
        await expect(scope.ParcelsOwnershipUi.fetchOwnersFromBackend('HR-1-1')).rejects.toThrow(/parcel-ownership\/1/);
    });
});
