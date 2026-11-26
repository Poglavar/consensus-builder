// Unit tests for the chain and IPFS reader (frontend/js/chain/ipfs-read.js, chain-reader.js) and the
// loaders that fall back to it (named-plans.js, proposals/design-sync.js) on fake gateways, a fake
// index and a stub agreement client: only bytes that hash to the requested CID are accepted, a gateway
// that answers wrongly is passed over, a loader asks the index first and reads IPFS when the index
// cannot answer, and a design read from IPFS gets a binding derived in the browser.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IpfsRead = require('../../frontend/js/chain/ipfs-read.js');
const ChainReader = require('../../frontend/js/chain/chain-reader.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const AgreementRecord = require('../../frontend/js/agreement-record.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const turf = require('@turf/turf');

const API = 'https://api.example.test';
const GATEWAYS = ['https://one.example/ipfs/', 'https://two.example/ipfs/', 'https://three.example/ipfs/'];
const SPONSOR = 'HZde4bPhD1NFSDXxgLE2UfMjBCAfXLBm5HpB9Dks4auu';
const square = (x, y, size = 0.001) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
const bytesOf = value => Cid.canonicalBytes(value);
const response = (status, bytes = new Uint8Array()) => ({ ok: status >= 200 && status < 300, status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)) });

// The objects one minted agreement names: a design, the plan linking it, and the agreement.
const design = DesignRecord.published({ proposalId: 'road-1', goal: 'road', title: 'New lane', author: 'Ana', city: 'london',
    site: square(-0.1, 51.5), createdAt: '2026-10-21T10:00:00.000Z', roadProposal: { definition: { widthM: 9 } } });
const designCid = Cid.cidOfObject(design);
const plan = PlanRecord.create('Lane plan', [designCid], { city: 'london', at: '51.5,-0.1,17', mode: '2d', language: 'en' });
const planCid = Cid.cidOfObject(plan);
const agreement = { schema: AgreementRecord.PUBLISHED_SCHEMA, title: 'Lane agreement', planCid, sponsor: SPONSOR, city: 'london' };
const agreementCid = Cid.cidOfObject(agreement);
const objects = new Map([[designCid, design], [planCid, plan], [agreementCid, agreement]]);

// Gateways by base URL: 'good' serves the object, 'tampered' serves other bytes under its CID,
// 'down' answers 504, and a request to the index (API) fails as an unreachable server does.
function network(behaviour = {}) {
    const asked = [];
    const fetch = vi.fn(async url => {
        asked.push(String(url));
        if (String(url).startsWith(API)) throw new TypeError('fetch failed');
        const gateway = GATEWAYS.find(base => String(url).startsWith(base));
        const cid = String(url).slice(gateway.length);
        const mode = behaviour[gateway] || 'good';
        if (mode === 'down' || !objects.has(cid)) return response(504);
        if (mode === 'tampered') return response(200, bytesOf({ ...objects.get(cid), title: 'Tampered' }));
        return response(200, bytesOf(objects.get(cid)));
    });
    return { fetch, asked };
}

describe('reading a CID from IPFS gateways', () => {
    it('accepts only bytes that hash to the CID, passing over a gateway that answers with other bytes', async () => {
        const { fetch, asked } = network({ [GATEWAYS[0]]: 'tampered', [GATEWAYS[1]]: 'down' });
        const read = await IpfsRead.fetchObject(planCid, { gateways: GATEWAYS, fetchImpl: fetch, schema: PlanRecord.SCHEMA });
        expect(read).toEqual({ cid: planCid, content: plan, gateway: GATEWAYS[2] });
        expect(asked).toEqual(GATEWAYS.map(base => `${base}${planCid}`));
    });

    it('reports every attempt when no gateway returns the bytes, and refuses what is not a CID', async () => {
        const { fetch } = network({ [GATEWAYS[0]]: 'tampered', [GATEWAYS[1]]: 'tampered', [GATEWAYS[2]]: 'down' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = await IpfsRead.fetchBytes(planCid, { gateways: GATEWAYS, fetchImpl: fetch }).catch(e => e);
        expect(error.code).toBe('ipfs-unavailable');
        expect(error.attempts.map(attempt => attempt.error)).toEqual(['cid-mismatch', 'cid-mismatch', 'HTTP 504']);
        expect(error.attempts[0].computed).toBe(Cid.cidOfObject({ ...plan, title: 'Tampered' }));
        await expect(IpfsRead.fetchBytes('not-a-cid', { gateways: GATEWAYS, fetchImpl: fetch })).rejects.toMatchObject({ code: 'invalid-cid' });
        warn.mockRestore();
    });

    it('refuses an object of another schema and reads several objects without one missing failing the rest', async () => {
        const { fetch } = network();
        await expect(IpfsRead.fetchObject(planCid, { gateways: GATEWAYS, fetchImpl: fetch, schema: DesignRecord.SCHEMA }))
            .rejects.toMatchObject({ code: 'invalid-object' });
        const absent = Cid.cidOfObject({ absent: true });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const read = await IpfsRead.fetchObjects([designCid, absent, designCid], { gateways: GATEWAYS, fetchImpl: fetch });
        warn.mockRestore();
        expect([...read.rows.keys()]).toEqual([designCid]);
        expect(read.missing.map(entry => entry.cid)).toEqual([absent]);
    });

    it('takes the configured gateways when any are named, else the defaults', () => {
        expect(IpfsRead.gateways(['https://gw.example/ipfs'])).toEqual(['https://gw.example/ipfs/']);
        expect(IpfsRead.gateways([])).toEqual([...IpfsRead.DEFAULT_GATEWAYS]);
    });
});

describe('falling back from the index', () => {
    it('answers from the server when it can, and from the fallback with the server error kept when both fail', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fallback = vi.fn(async () => 'ipfs');
        expect(await ChainReader.withFallback('x', async () => 'server', fallback)).toBe('server');
        expect(fallback).not.toHaveBeenCalled();
        expect(await ChainReader.withFallback('x', async () => { throw new Error('down'); }, fallback)).toBe('ipfs');
        const error = await ChainReader.withFallback('x', async () => { throw new Error('down'); }, async () => { throw new Error('gone'); }).catch(e => e);
        expect(error.message).toBe('down');
        expect(error.fallbackError.message).toBe('gone');
        info.mockRestore(); warn.mockRestore();
    });

    it('lists an agreement account with its chain creation time and status in the index spelling', () => {
        const row = ChainReader.chainRowOf({ address: 'Acc1', cid: agreementCid, authority: SPONSOR, status: 'Executed', decision: 'Satisfied', createdAt: 1_790_000_000 },
            { programId: 'Prog', observedAt: '2026-11-27T10:00:00.000Z' });
        expect(row).toEqual({ cid: agreementCid, createdAt: '2026-09-21T14:13:20.000Z', source: 'chain', onchain: {
            chain: 'solana', cluster: 'devnet', programId: 'Prog', account: 'Acc1', sponsor: SPONSOR, status: 'executed', decision: 'satisfied', observedAt: '2026-11-27T10:00:00.000Z' } });
    });
});

// A browser window with the reader and its collaborators: the index unreachable, the gateways as
// `behaviour` says, and the agreement account read from a stub client.
function readerWindow(behaviour = {}, extra = {}) {
    const { fetch, asked } = network(behaviour);
    const account = { address: 'AgreementPda1', cid: agreementCid, authority: SPONSOR, status: 'Active', decision: 'Pending', createdAt: 1_790_000_000 };
    const win = {
        fetch, IPFS_READ_GATEWAYS: GATEWAYS, IpfsRead, Cid, PlanRecord, DesignRecord, AgreementRecord,
        solanaWeb3: { Connection: class {} },
        SolanaChainDataLoader: { getVerifiedConnection: vi.fn(async cluster => ({ cluster })) },
        AgreementClient: {
            constants: { AGREEMENT_PROGRAM_ID: 'ProgramId1' },
            listAgreements: vi.fn(async () => [account]),
            fetchAgreement: vi.fn(async (_connection, { cid, authority }) => (cid === agreementCid && authority === SPONSOR ? account : null))
        },
        ...extra
    };
    win.ChainReader = { ...ChainReader, ...ChainReader.browser(win) };
    return { win, asked };
}

describe('the chain reader in the browser', () => {
    it('lists agreements from the program accounts on the genesis-checked devnet connection', async () => {
        const { win } = readerWindow();
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const rows = await win.ChainReader.listAgreements();
        info.mockRestore();
        expect(win.SolanaChainDataLoader.getVerifiedConnection).toHaveBeenCalledWith('devnet');
        expect(win.AgreementClient.listAgreements).toHaveBeenCalledWith({ cluster: 'devnet' }, { programId: 'ProgramId1' });
        expect(rows).toEqual([expect.objectContaining({ cid: agreementCid, source: 'chain', onchain: expect.objectContaining({ account: 'AgreementPda1', status: 'active' }) })]);
    });

    it('reads an agreement and its plan from IPFS with the state of its account', async () => {
        const { win } = readerWindow({ [GATEWAYS[0]]: 'tampered' });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const read = await win.ChainReader.fetchAgreement(agreementCid);
        info.mockRestore(); warn.mockRestore();
        expect(read).toMatchObject({ cid: agreementCid, content: agreement, status: 'active', source: 'ipfs', gateway: GATEWAYS[1],
            plan: { cid: planCid, content: plan }, designCids: [designCid], onchain: { account: 'AgreementPda1', sponsor: SPONSOR, programId: 'ProgramId1' } });
    });

    it('derives a binding for a design read from IPFS: open ground without parcels, else by the private-plan binder', async () => {
        const binding = { parcels: [{ parcelId: 'p1' }], coverage: 'complete' };
        const bindPrivateRows = vi.fn(async members => new Map(members.map(member => [member.cid, { cid: member.cid, binding }])));
        let withoutParcels = true;
        const { win } = readerWindow({}, { turf, __siteBinding: siteBinding, PlanAnalysis: { bindPrivateRows },
            ParcelGroundFallback: { isWithoutParcels: () => withoutParcels }, DesignSync: { parcelSourceIdOf: () => 'hmlr' } });
        const row = { cid: designCid, content: design, source: 'ipfs' };
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const open = (await win.ChainReader.withDerivedBindings([row])).get(designCid).binding;
        expect(open).toMatchObject({ parcels: [], coverage: 'none', source: 'browser:none' });
        expect(bindPrivateRows).not.toHaveBeenCalled();
        withoutParcels = false;
        expect((await win.ChainReader.withDerivedBindings([row])).get(designCid).binding).toBe(binding);
        expect(bindPrivateRows).toHaveBeenCalledWith([{ cid: designCid, content: design, source: null }]);
        // A row that has a binding already keeps it.
        const indexed = { cid: designCid, content: design, binding: { parcels: [], coverage: 'complete' } };
        expect((await win.ChainReader.withDerivedBindings([indexed])).get(designCid)).toBe(indexed);
        info.mockRestore();
    });
});

describe('loaders asking the index first', () => {
    it('opens a plan from IPFS when the index is unreachable, checked against its CID', async () => {
        const { win, asked } = readerWindow({ [GATEWAYS[0]]: 'tampered' }, {
            location: new URL(`https://app.example.test/`), getBackendBase: () => API, PersistentStorage: { forEach() {} } });
        const plans = NamedPlans.browser(win);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const read = await plans.fetchPlan(planCid);
        info.mockRestore(); warn.mockRestore();
        expect(read).toMatchObject({ cid: planCid, content: plan, source: 'ipfs', gateway: GATEWAYS[1] });
        expect(asked[0]).toBe(`${API}/plans/${planCid}`);
    });

    function designWindow({ indexHas = [] } = {}) {
        const { win, asked } = readerWindow();
        // The index answers, holding only `indexHas`.
        const gatewayFetch = win.fetch;
        win.fetch = vi.fn(async (url, init) => {
            if (!String(url).startsWith(API)) return gatewayFetch(url, init);
            asked.push(String(url));
            const { cids } = JSON.parse(init.body);
            const items = cids.filter(cid => indexHas.includes(cid)).map(cid => ({ cid, design: { cid, content: objects.get(cid), binding: { parcels: [] } } }));
            return { ok: true, status: 200, json: async () => ({ items }) };
        });
        Object.assign(win, { resolveBackendBaseUrl: () => API, CityConfigManager: { getCityConfig: () => null, resolveCityId: city => city } });
        return { sync: DesignSync.browser(win).api, win, asked };
    }

    it('reads the designs the index does not hold from IPFS, and none when asked what the index holds', async () => {
        const { sync, asked } = designWindow();
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const read = await sync.fetchDesigns([designCid]);
        expect(read.missing).toEqual([]);
        expect(read.rows.get(designCid)).toMatchObject({ cid: designCid, content: design, source: 'ipfs', gateway: GATEWAYS[0] });
        expect(asked).toEqual([`${API}/designs/batch`, `${GATEWAYS[0]}${designCid}`]);
        asked.length = 0;
        expect((await sync.fetchDesigns([designCid], { indexOnly: true })).missing).toEqual([designCid]);
        expect(asked).toEqual([`${API}/designs/batch`]);
        // Imported, it is marked published at the gateway that served it, not at this index.
        const stored = await sync.importDesign(read.rows.get(designCid), { _parcelMutation: { proposals: {
            getAllProposals: () => [], getProposal: () => null, importProposal: record => record } } });
        expect(stored.published.apiBase).toBe(GATEWAYS[0].replace(/\/$/, ''));
        info.mockRestore(); log.mockRestore();
    });

    it('keeps the index answer for a design it holds', async () => {
        const { sync, asked } = designWindow({ indexHas: [designCid] });
        const read = await sync.fetchDesigns([designCid]);
        expect(read.rows.get(designCid).source).toBeUndefined();
        expect(asked).toEqual([`${API}/designs/batch`]);
    });
});
