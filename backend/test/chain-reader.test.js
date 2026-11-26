// Unit tests for the chain and IPFS reader (frontend/js/chain/ipfs-read.js, chain-reader.js), the
// read-source choice (chain/read-source.js) and the loaders that follow it (named-plans.js,
// proposals/design-sync.js) on fake gateways, a fake index and a stub agreement client: only bytes
// that hash to the requested CID are accepted, a gateway that answers wrongly is passed over, a
// loader reads only from the chosen source (our server never touches a gateway, the chain never the
// index, both reads both and says which served), a design read from IPFS gets a binding derived
// in the browser, and the plans and designs behind minted agreements are found from the accounts
// alone (each agreement's plan checked against its account's plan hash, every object read once).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readSource } from './helpers/read-source.js';

const require = createRequire(import.meta.url);
const IpfsRead = require('../../frontend/js/chain/ipfs-read.js');
const ChainReader = require('../../frontend/js/chain/chain-reader.js');
const ReadSource = require('../../frontend/js/chain/read-source.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const AgreementRecord = require('../../frontend/js/agreement-record.js');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const { planCidHash } = require('../../frontend/js/solana/agreement-client.js');
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
// A second design, held by the index but by no gateway.
const indexedDesign = DesignRecord.published({ proposalId: 'park-1', goal: 'park', title: 'Pocket park', author: 'Ana', city: 'london',
    site: square(-0.11, 51.5), createdAt: '2026-10-22T10:00:00.000Z' });
const indexedDesignCid = Cid.cidOfObject(indexedDesign);
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

describe('the read-source choice', () => {
    it('starts at our server, takes a kept choice, and lets a link choose for its page without keeping it', () => {
        expect(ReadSource.initial()).toEqual({ source: 'server', fromLink: false });
        expect(ReadSource.initial({ stored: 'chain' })).toEqual({ source: 'chain', fromLink: false });
        expect(ReadSource.initial({ stored: 'chain', param: 'both' })).toEqual({ source: 'both', fromLink: true });
        expect(ReadSource.initial({ stored: 'nonsense', param: 'everywhere' })).toEqual({ source: 'server', fromLink: false });
        const stored = new Map([[ReadSource.STORAGE_KEY, 'server']]);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const linked = readSource('chain', { stored });
        expect(linked.get()).toBe('chain');
        expect(linked.fromLink()).toBe(true);
        expect(stored.get(ReadSource.STORAGE_KEY)).toBe('server');
        const heard = [];
        linked.subscribe(source => heard.push(source));
        expect(linked.set('both')).toBe('both');
        expect([linked.get(), linked.fromLink(), stored.get(ReadSource.STORAGE_KEY), heard]).toEqual(['both', false, 'both', ['both']]);
        expect(() => linked.set('index')).toThrow('Unknown read source: index');
        info.mockRestore();
    });

    it('reads one source alone, and under both prefers our server, keeps its failure, and names both when neither answers', async () => {
        const served = { server: vi.fn(async () => ({ cid: 'x', from: 'index' })), chain: vi.fn(async () => ({ cid: 'x', from: 'ipfs' })) };
        expect(await ReadSource.readOne('server', served)).toEqual({ cid: 'x', from: 'index', readFrom: 'server' });
        expect(served.chain).not.toHaveBeenCalled();
        expect(await ReadSource.readOne('chain', served)).toEqual({ cid: 'x', from: 'ipfs', readFrom: 'chain' });
        expect(served.server).toHaveBeenCalledTimes(1);
        expect(await ReadSource.readOne('both', served)).toEqual({ cid: 'x', from: 'index', readFrom: 'server' });
        const down = { server: async () => { throw new Error('HTTP 503'); }, chain: async () => { throw new Error('no gateway'); } };
        await expect(ReadSource.readOne('server', down)).rejects.toThrow('HTTP 503');
        expect(await ReadSource.readOne('both', { ...down, chain: served.chain }))
            .toEqual({ cid: 'x', from: 'ipfs', readFrom: 'chain', readErrors: { server: 'HTTP 503' } });
        await expect(ReadSource.readOne('both', down)).rejects.toMatchObject({ code: 'read-failed', message: 'Our server: HTTP 503 · Chain: no gateway' });
    });

    it('lists each record once with the sources that hold it, the chain\'s account state over the index\'s observation', () => {
        const indexed = { cid: 'a', title: 'Lane agreement', onchain: { account: 'Acc1', status: 'active', mintTx: 'sig' } };
        const listed = { cid: 'a', readFrom: 'chain', onchain: { account: 'Acc1', status: 'executed' } };
        const onlyIndexed = { cid: 'b', title: 'Not minted' };
        const memo = new Map();
        const union = ReadSource.unionRows([{ readFrom: 'server', rows: [indexed, onlyIndexed] }, { readFrom: 'chain', rows: [listed] }], memo);
        expect(union.map(entry => [entry.record.cid, entry.heldBy])).toEqual([['a', ['server', 'chain']], ['b', ['server']]]);
        expect(union[0].record).toMatchObject({ title: 'Lane agreement', onchain: { account: 'Acc1', status: 'executed', mintTx: 'sig' } });
        expect(union[1].record).toBe(onlyIndexed);
        // The same feeds give the same merged record, so its card is not redrawn.
        expect(ReadSource.unionRows([{ readFrom: 'server', rows: [indexed] }, { readFrom: 'chain', rows: [listed] }], memo)[0].record).toBe(union[0].record);
    });

    it('lists an agreement account with its chain creation time and status in the index spelling', () => {
        const row = ChainReader.chainRowOf({ address: 'Acc1', cid: agreementCid, authority: SPONSOR, status: 'Executed', decision: 'Satisfied', createdAt: 1_790_000_000 },
            { programId: 'Prog', observedAt: '2026-11-27T10:00:00.000Z' });
        expect(row).toEqual({ cid: agreementCid, createdAt: '2026-09-21T14:13:20.000Z', readFrom: 'chain', onchain: {
            chain: 'solana', cluster: 'devnet', programId: 'Prog', account: 'Acc1', sponsor: SPONSOR, status: 'executed', decision: 'satisfied', observedAt: '2026-11-27T10:00:00.000Z' } });
    });
});

// A browser window with the reader and its collaborators: the index unreachable, the gateways as
// `behaviour` says, and the agreement account read from a stub client.
function readerWindow(behaviour = {}, extra = {}) {
    const { fetch, asked } = network(behaviour);
    const account = { address: 'AgreementPda1', cid: agreementCid, authority: SPONSOR, status: 'Active', decision: 'Pending', createdAt: 1_790_000_000,
        planCidHash: planCidHash(planCid) };
    const accounts = extra.accounts || [account];
    const win = {
        fetch, IPFS_READ_GATEWAYS: GATEWAYS, IpfsRead, Cid, PlanRecord, DesignRecord, AgreementRecord,
        solanaWeb3: { Connection: class {} },
        SolanaChainDataLoader: { getVerifiedConnection: vi.fn(async cluster => ({ cluster })) },
        AgreementClient: {
            constants: { AGREEMENT_PROGRAM_ID: 'ProgramId1' },
            listAgreements: vi.fn(async () => accounts),
            fetchAgreement: vi.fn(async (_connection, { cid, authority }) => (cid === agreementCid && authority === SPONSOR ? account : null)),
            fetchAgreementsForPlan: vi.fn(async (_connection, cid) => accounts.filter(row => row.planCidHash === planCidHash(cid))),
            planCidHash
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
        expect(rows).toEqual([expect.objectContaining({ cid: agreementCid, readFrom: 'chain', onchain: expect.objectContaining({ account: 'AgreementPda1', status: 'active' }) })]);
    });

    it('reads an agreement and its plan from IPFS with the state of its account', async () => {
        const { win } = readerWindow({ [GATEWAYS[0]]: 'tampered' });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const read = await win.ChainReader.fetchAgreement(agreementCid);
        info.mockRestore(); warn.mockRestore();
        expect(read).toMatchObject({ cid: agreementCid, content: agreement, status: 'active', readFrom: 'chain', gateway: GATEWAYS[1],
            plan: { cid: planCid, content: plan, readFrom: 'chain' }, designCids: [designCid], onchain: { account: 'AgreementPda1', sponsor: SPONSOR, programId: 'ProgramId1' } });
    });

    it('derives a binding for a design read from IPFS: open ground without parcels, else by the private-plan binder', async () => {
        const binding = { parcels: [{ parcelId: 'p1' }], coverage: 'complete' };
        const bindPrivateRows = vi.fn(async members => new Map(members.map(member => [member.cid, { cid: member.cid, binding }])));
        let withoutParcels = true;
        const { win } = readerWindow({}, { turf, __siteBinding: siteBinding, PlanAnalysis: { bindPrivateRows },
            ParcelGroundFallback: { isWithoutParcels: () => withoutParcels }, DesignSync: { parcelSourceIdOf: () => 'hmlr' } });
        const row = { cid: designCid, content: design, readFrom: 'chain' };
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

// A second minted agreement on the same plan, and a third whose account claims that plan while its
// object names another: the chain's catalog must not trust the claim.
const secondAgreement = { ...agreement, title: 'Second agreement on the lane' };
const secondCid = Cid.cidOfObject(secondAgreement);
const otherPlan = PlanRecord.create('Other plan', [indexedDesignCid], { city: 'london', at: '51.5,-0.1,17', mode: '2d', language: 'en' });
const otherPlanCid = Cid.cidOfObject(otherPlan);
const lying = { ...agreement, title: 'Claims the lane plan', planCid: otherPlanCid };
const lyingCid = Cid.cidOfObject(lying);
const accountOf = (cid, plan, createdAt) => ({ address: `Pda-${cid.slice(-6)}`, cid, authority: SPONSOR, status: 'Active', decision: 'Pending', createdAt, planCidHash: planCidHash(plan) });

describe('the plans and designs behind minted agreements', () => {
    // read(kind, cid) over `objects`, recording each read; a CID it does not hold fails as IpfsRead's does.
    const reader = held => {
        const reads = [];
        const read = vi.fn(async (kind, cid) => {
            reads.push(`${kind}:${cid}`);
            if (!held.has(cid)) throw Object.assign(new Error(`${cid} could not be read from IPFS`), { code: 'ipfs-unavailable' });
            return { content: held.get(cid), gateway: GATEWAYS[0] };
        });
        return { read, reads };
    };

    it('reads each agreement and then its plan once, leaving out an account whose plan hash its object contradicts', async () => {
        const held = new Map([...objects, [secondCid, secondAgreement], [lyingCid, lying], [otherPlanCid, otherPlan]]);
        const { read, reads } = reader(held);
        const progress = [];
        const accounts = [accountOf(secondCid, planCid, 3), accountOf(lyingCid, planCid, 2), accountOf(agreementCid, planCid, 1)];
        const found = await ChainReader.plansBehind(accounts, { read, planCidHash, onProgress: step => progress.push(`${step.done}/${step.total}`) });
        expect(found.agreements).toBe(3);
        expect(found.plans).toEqual([{ cid: planCid, content: plan, gateway: GATEWAYS[0], agreementCids: [secondCid, agreementCid] }]);
        expect(found.skipped).toEqual([expect.objectContaining({ kind: 'agreement', cid: lyingCid, code: 'plan-hash-mismatch' })]);
        // The plan the lying agreement names is never read; the lane plan is read once.
        expect(reads).toEqual([`agreement:${secondCid}`, `plan:${planCid}`, `agreement:${lyingCid}`, `agreement:${agreementCid}`]);
        expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3']);
    });

    it('names an agreement or plan it cannot read and still lists the rest', async () => {
        const { read } = reader(new Map([[agreementCid, agreement], [secondCid, { ...secondAgreement, planCid: otherPlanCid }]]));
        const absent = Cid.cidOfObject({ absent: 'agreement' });
        const found = await ChainReader.plansBehind([accountOf(absent, planCid, 3), accountOf(secondCid, otherPlanCid, 2), accountOf(agreementCid, planCid, 1)],
            { read: async (kind, cid) => (kind === 'plan' && cid === planCid ? { content: plan, gateway: GATEWAYS[1] } : read(kind, cid)), planCidHash });
        expect(found.plans.map(row => row.cid)).toEqual([planCid]);
        expect(found.skipped.map(entry => [entry.kind, entry.cid, entry.code])).toEqual([['agreement', absent, 'ipfs-unavailable'], ['plan', otherPlanCid, 'ipfs-unavailable']]);
    });

    it('reads each design its plans name once, with the plans that name it, one unreadable design not failing the rest', async () => {
        const { read, reads } = reader(new Map([[designCid, design]]));
        const plans = [{ cid: planCid, content: plan }, { cid: otherPlanCid, content: { ...otherPlan, designCids: [indexedDesignCid, designCid] } }];
        const progress = [];
        const found = await ChainReader.designsOf(plans, { read, onProgress: step => progress.push(`${step.stage} ${step.done}/${step.total}`) });
        expect(found.designs).toEqual([{ cid: designCid, content: design, gateway: GATEWAYS[0], planCids: [planCid, otherPlanCid] }]);
        expect(found.skipped).toEqual([expect.objectContaining({ kind: 'design', cid: indexedDesignCid })]);
        expect(reads).toEqual([`design:${designCid}`, `design:${indexedDesignCid}`]);
        expect(progress).toEqual(['designs 0/2', 'designs 1/2', 'designs 2/2']);
    });

    it('in the browser: one catalog per page from the program accounts, every object read from IPFS once, Refresh listing the accounts again', async () => {
        const second = accountOf(secondCid, planCid, 1_790_000_100);
        const { win, asked } = readerWindow({ [GATEWAYS[0]]: 'tampered' }, { accounts: [second] });
        objects.set(secondCid, secondAgreement);
        const spies = ['info', 'warn'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
        try {
            const progress = [];
            const found = await win.ChainReader.catalog({ designs: true, onProgress: step => progress.push(step.stage) });
            expect(found.plans).toEqual([expect.objectContaining({ cid: planCid, content: plan, gateway: GATEWAYS[1], agreementCids: [secondCid] })]);
            expect(found.designs).toEqual([expect.objectContaining({ cid: designCid, content: design, planCids: [planCid] })]);
            expect(progress).toEqual(['accounts', 'plans', 'plans', 'designs', 'designs']);
            // A tampered gateway is passed over: each object took two requests, and none is asked again.
            const firstReads = asked.length;
            expect(firstReads).toBe(6);
            expect(await win.ChainReader.catalog()).toBe(await win.ChainReader.catalog());
            expect(win.AgreementClient.listAgreements).toHaveBeenCalledTimes(1);
            await win.ChainReader.catalog({ force: true, designs: true });
            expect(win.AgreementClient.listAgreements).toHaveBeenCalledTimes(2);
            expect(asked.length).toBe(firstReads);
            // Opening the plan reads the cached bytes, not the gateways.
            expect(await win.ChainReader.fetchPlan(planCid)).toMatchObject({ cid: planCid, readFrom: 'chain' });
            expect(asked.length).toBe(firstReads);
        } finally { objects.delete(secondCid); spies.forEach(spy => spy.mockRestore()); }
    });

    it('in the browser: a plan\'s agreements come from the chain filter, kept only when their objects name the plan', async () => {
        const accounts = [accountOf(agreementCid, planCid, 1), accountOf(lyingCid, planCid, 2)];
        const { win } = readerWindow({}, { accounts });
        objects.set(lyingCid, lying);
        const spies = ['info', 'warn'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
        try {
            const found = await win.ChainReader.agreementsOfPlan(planCid);
            expect(win.AgreementClient.fetchAgreementsForPlan).toHaveBeenCalledWith({ cluster: 'devnet' }, planCid, { programId: 'ProgramId1' });
            expect(found.rows).toEqual([expect.objectContaining({ cid: agreementCid, title: 'Lane agreement', planCid, readFrom: 'chain',
                onchain: expect.objectContaining({ account: accounts[0].address }) })]);
            expect(found.skipped).toEqual([expect.objectContaining({ cid: lyingCid, code: 'plan-hash-mismatch' })]);
        } finally { objects.delete(lyingCid); spies.forEach(spy => spy.mockRestore()); }
    });
});

describe('loaders read only from the chosen source', () => {
    const quiet = () => ['info', 'warn', 'log'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    const isIndex = url => url.startsWith(API);
    // The index is unreachable (readerWindow's network); the gateways answer as `behaviour` says.
    function planWindow(source, behaviour = {}) {
        const { win, asked } = readerWindow(behaviour, { ReadSource: readSource(source),
            location: new URL('https://app.example.test/'), getBackendBase: () => API, PersistentStorage: { forEach() {} } });
        return { plans: NamedPlans.browser(win), asked };
    }

    it('our server: a plan the index cannot serve fails with the index\'s error, and no gateway is asked', async () => {
        const spies = quiet();
        const { plans, asked } = planWindow('server');
        await expect(plans.fetchPlan(planCid)).rejects.toThrow('fetch failed');
        expect(asked).toEqual([`${API}/plans/${planCid}`]);
        spies.forEach(spy => spy.mockRestore());
    });

    it('chain: a plan is read from IPFS, checked against its CID, and the index is never asked', async () => {
        const spies = quiet();
        const { plans, asked } = planWindow('chain', { [GATEWAYS[0]]: 'tampered' });
        const read = await plans.fetchPlan(planCid);
        spies.forEach(spy => spy.mockRestore());
        expect(read).toMatchObject({ cid: planCid, content: plan, readFrom: 'chain', gateway: GATEWAYS[1] });
        expect(asked.filter(isIndex)).toEqual([]);
    });

    it('both: with the index unreachable the plan comes from IPFS, marked so, with the index\'s failure kept', async () => {
        const spies = quiet();
        const { plans, asked } = planWindow('both');
        const read = await plans.fetchPlan(planCid);
        spies.forEach(spy => spy.mockRestore());
        expect(read).toMatchObject({ cid: planCid, readFrom: 'chain', gateway: GATEWAYS[0], readErrors: { server: 'fetch failed' } });
        expect(asked).toContain(`${API}/plans/${planCid}`);
    });

    // The index answers /designs/batch holding only `indexHas`, or is unreachable when `indexDown`.
    function designWindow(source, { indexHas = [], indexDown = false, behaviour = {} } = {}) {
        const { win, asked } = readerWindow(behaviour, { ReadSource: readSource(source) });
        const held = new Map([[designCid, design], [indexedDesignCid, indexedDesign]]);
        const gatewayFetch = win.fetch;
        win.fetch = vi.fn(async (url, init) => {
            if (!isIndex(String(url))) return gatewayFetch(url, init);
            asked.push(String(url));
            if (indexDown) throw new TypeError('fetch failed');
            const one = /\/designs\/([^/]+)$/.exec(String(url));
            if (one && one[1] !== 'batch') {
                const cid = decodeURIComponent(one[1]);
                return indexHas.includes(cid) ? { ok: true, status: 200, json: async () => ({ cid, content: held.get(cid), binding: { parcels: [] } }) }
                    : { ok: false, status: 404, json: async () => ({ code: 'design_not_found' }) };
            }
            const { cids } = JSON.parse(init.body);
            const items = cids.filter(cid => indexHas.includes(cid)).map(cid => ({ cid, design: { cid, content: held.get(cid), binding: { parcels: [] } } }));
            return { ok: true, status: 200, json: async () => ({ items }) };
        });
        Object.assign(win, { resolveBackendBaseUrl: () => API, CityConfigManager: { getCityConfig: () => null, resolveCityId: city => city } });
        return { sync: DesignSync.browser(win).api, win, asked };
    }

    it('our server: designs the index lacks are missing, an unreachable index fails, and no gateway is asked', async () => {
        const spies = quiet();
        const { sync, asked } = designWindow('server');
        const read = await sync.fetchDesigns([designCid]);
        expect([read.rows.size, read.missing, read.readFrom]).toEqual([0, [designCid], 'server']);
        await expect(sync.fetchDesign(designCid)).rejects.toMatchObject({ code: 'design-not-found' });
        const down = designWindow('server', { indexDown: true });
        await expect(down.sync.fetchDesigns([designCid])).rejects.toMatchObject({ code: 'network-failed' });
        spies.forEach(spy => spy.mockRestore());
        expect([...asked, ...down.asked].filter(url => !isIndex(url))).toEqual([]);
    });

    it('chain: designs come from IPFS without asking the index; publishing still asks the index alone', async () => {
        const spies = quiet();
        const { sync, asked } = designWindow('chain', { indexHas: [designCid] });
        const read = await sync.fetchDesigns([designCid, indexedDesignCid]);
        expect(read.rows.get(designCid)).toMatchObject({ cid: designCid, content: design, readFrom: 'chain', gateway: GATEWAYS[0] });
        expect(read.missing).toEqual([indexedDesignCid]);
        expect(await sync.fetchDesign(designCid)).toMatchObject({ readFrom: 'chain', gateway: GATEWAYS[0] });
        expect(asked.filter(isIndex)).toEqual([]);
        expect((await sync.fetchDesigns([designCid], { indexOnly: true })).rows.get(designCid).readFrom).toBe('server');
        expect(asked.filter(isIndex)).toEqual([`${API}/designs/batch`]);
        // Imported, it is marked published at the gateway that served it, not at this index.
        const stored = await sync.importDesign(read.rows.get(designCid), { _parcelMutation: { proposals: {
            getAllProposals: () => [], getProposal: () => null, importProposal: record => record } } });
        expect(stored.published.apiBase).toBe(GATEWAYS[0].replace(/\/$/, ''));
        spies.forEach(spy => spy.mockRestore());
    });

    it('both: the index\'s designs from the index, the rest from IPFS, each marked; neither answering names both', async () => {
        const spies = quiet();
        const { sync, asked } = designWindow('both', { indexHas: [indexedDesignCid] });
        const read = await sync.fetchDesigns([designCid, indexedDesignCid]);
        expect(read.rows.get(indexedDesignCid)).toMatchObject({ readFrom: 'server', binding: { parcels: [] } });
        expect(read.rows.get(designCid)).toMatchObject({ readFrom: 'chain', gateway: GATEWAYS[0] });
        expect([read.missing, read.readErrors]).toEqual([[], null]);
        // The chain is asked only for what the index lacks.
        expect(asked.filter(url => !isIndex(url))).toEqual([`${GATEWAYS[0]}${designCid}`]);
        const down = designWindow('both', { indexDown: true });
        const fromChain = await down.sync.fetchDesigns([designCid]);
        expect(fromChain.rows.get(designCid).readFrom).toBe('chain');
        expect(fromChain.readErrors.server).toMatch(/could not be reached/);
        const nowhere = designWindow('both', { indexDown: true, behaviour: Object.fromEntries(GATEWAYS.map(base => [base, 'down'])) });
        await expect(nowhere.sync.fetchDesigns([designCid])).rejects.toMatchObject({ code: 'read-failed',
            message: expect.stringMatching(/^Our server: .*could not be reached.* · Chain: The designs could not be read from IPFS\.$/) });
        spies.forEach(spy => spy.mockRestore());
    });
});
