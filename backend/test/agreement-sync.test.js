// Unit tests for frontend/js/agreement-sync.js: /agreements/<cid> paths and links, the local record
// rebuilt from a published agreement/v1 object, and Propose on a fake window with the real
// DesignSync and AgreementRecord over a fake courier and index: what is pinned and indexed, the
// record marked published with its sponsor, and the refusals that stop it before anything leaves the
// device. On chain (M3): the mint mirrored into the index and kept on the record even when the index
// refuses it, the index's minted list, an agreement proposed again with a sponsor, and an opened
// link that keeps this device's mint.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgreementSync = require('../../frontend/js/agreement-sync.js');
const AgreementRecord = require('../../frontend/js/agreement-record.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');
const PublishTerms = require('../../frontend/js/proposals/publish-terms.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
let NodeCid;
beforeAll(async () => { NodeCid = await import('../cid.js'); });

const API = 'https://api.example.test';
const SPONSOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
// The agreement account a mint creates (any base58 key: the index, not this module, derives it).
const ACCOUNT = 'HrcX5vC2ws2sKiLwpTyYG6Dnc3dmHT6zvuUp2xDs2pEx';
const clone = value => JSON.parse(JSON.stringify(value));
const thrown = async fn => { try { await fn(); } catch (error) { return error; } return null; };
function rect(x0, y0, x1, y1) {
    const at = (x, y) => [15.96 + x * 1e-3, 45.8 + y * 1e-3];
    return { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}

// The two applied designs an agreement bundles: a layout of k9 and a road across k9 and k10.
const layout = () => ({
    proposalId: 'layout-1', goal: 'parcel-layout', title: 'Lay out k9', city: 'zagreb', site: rect(0, 0, 3, 2),
    createdAt: '2026-10-21T09:00:00.000Z', applied: true,
    parcelLayout: { algorithm: 'equal', pool: rect(0, 0, 3, 2), plots: [{ geometry: rect(0, 0, 1, 2), source: 'equal' }, { geometry: rect(1, 0, 3, 2), source: 'equal' }] }
});
const road = () => ({
    proposalId: 'road-1', goal: 'road', title: 'New lane', city: 'zagreb', site: rect(0, 2, 5, 2.2),
    createdAt: '2026-10-21T09:30:00.000Z', applied: true, roadProposal: { definition: { widthM: 9 } }
});
const holder = (ownerKey, share = 1) => ({ ownerKey, displayName: ownerKey, share });
function output(pieceId, geometry, areaM2, fromParcelIds, producedBy, role, holders) {
    return { hash: AgreementRecord.outputHash(geometry), pieceId, areaM2, fromParcelIds, producedBy, role, holders, geometry };
}
// The local agreement the dialog saved over those designs.
function agreement(extra = {}) {
    const inputs = { parcels: [{ parcelId: 'k9', areaM2: 500, holders: [holder('agent-ana')] }, { parcelId: 'k10', areaM2: 500, holders: [holder('agent-ben')] }], openGroundM2: 0 };
    const outputs = [
        output('k9-p1', rect(0, 0, 1, 2), 300, ['k9'], 'layout-1', 'plot', [holder('agent-ana')]),
        output('k9-p2', rect(1, 0, 3, 2), 600, ['k9'], 'layout-1', 'plot', [holder('agent-ana')]),
        output('road-1#1', rect(0, 2, 5, 2.2), 100, ['k9', 'k10'], 'road-1', 'corridor', [])
    ];
    const designs = [
        { proposalId: 'layout-1', title: 'Lay out k9', goal: 'parcel-layout', cid: DesignRecord.cidOf(layout()) },
        { proposalId: 'road-1', title: 'New lane', goal: 'road', cid: DesignRecord.cidOf(road()) }
    ];
    const planContent = PlanRecord.create('Block seven', designs.map(design => design.cid), { at: '45.8,15.96,16', mode: '2d' });
    const raw = {
        schema: 'agreement/v1', id: 'ag-1', title: 'Block seven', city: 'zagreb',
        createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z',
        plan: { cid: Cid.cidOfObject(planContent), content: planContent }, designs,
        inputs, outputs,
        allocations: [
            { output: outputs[0].hash, to: { kind: 'party', ownerKey: 'agent-ana' } },
            { output: outputs[1].hash, to: { kind: 'party', ownerKey: 'agent-ben' } },
            { output: outputs[2].hash, to: { kind: 'public' } }
        ],
        money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: true, lens: ['lens-member-1'],
            approvalConfig: { schema: 'proposal-approval/v1', rights: AgreementRecord.rightsFromInputs(inputs), policy: { type: 'unanimous' } } },
        deadline: null, published: null, ...extra
    };
    return AgreementRecord.settle(raw);
}

describe('paths', () => {
    const cid = Cid.cidOfObject({ schema: 'agreement/v1' });
    it('reads the CID an /agreements path names, and nothing else', () => {
        expect(AgreementSync.parseAgreementPath(`/agreements/${cid}`)).toBe(cid);
        expect(AgreementSync.parseAgreementPath(`/agreements/${cid}/`)).toBe(cid);
        for (const path of ['/agreements/', '/agreements/ag-1', `/agreements/${cid},${cid}`, `/designs/${cid}`, `/agreements/${cid}/decisions`, undefined]) {
            expect(AgreementSync.parseAgreementPath(path), String(path)).toBeNull();
        }
        expect(AgreementSync.agreementPath(cid)).toBe(`/agreements/${cid}`);
    });

    it('shortens a CID to something recognisable', () => {
        expect(AgreementSync.shortCid(cid)).toBe(`${cid.slice(0, 12)}…${cid.slice(-6)}`);
        expect(AgreementSync.shortCid('short-id')).toBe('short-id');
        expect(AgreementSync.shortCid(null)).toBe('');
    });
});

describe('recordFromPublished', () => {
    const layoutCid = DesignRecord.cidOf(layout());
    const roadCid = DesignRecord.cidOf(road());
    const content = AgreementRecord.published({
        ...agreement({ author: 'Ana', sponsor: SPONSOR }),
        inputs: { ...agreement().inputs, parcels: agreement().inputs.parcels.map(parcel => ({ ...parcel, parcelSourceId: 'zagreb-dgu' })) }
    });
    const row = { cid: Cid.cidOfObject(content), content, plan: agreement().plan, createdAt: '2026-10-21T12:00:00.000Z' };
    const localIds = new Map([[layoutCid, 'design-layout'], [roadCid, 'design-road']]);
    const localIdOf = cid => localIds.get(cid) || null;

    it('roundtrips consultation metadata through publication and import', () => {
        const original = agreement({ allocations: [], money: { currency: 'EUR', lines: [] },
            rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
            consultation: { organiser: 'https://ngo.example', participationUrl: 'https://ngo.example/join' } });
        const content = AgreementRecord.published(original);
        const cid = AgreementRecord.publishedCid(original);
        const imported = AgreementSync.recordFromPublished({ cid, content, plan: original.plan }, { id: 'ag-imported', apiBase: API, localIdOf });
        expect(imported.consultation).toEqual({ organiser: 'did:web:ngo.example', participationUrl: 'https://ngo.example/join' });
        expect(AgreementRecord.publishedCid(imported)).toBe(cid);
    });

    it('names the designs by their local copies and keeps the pieces derived here when they are the published ones', () => {
        const derived = { outputs: clone(agreement().outputs) };
        const record = AgreementSync.recordFromPublished(row, { id: 'ag-imported', apiBase: API, localIdOf, designOf: id => ({ title: id === 'design-layout' ? 'Lay out k9' : 'New lane', goal: id === 'design-layout' ? 'parcel-layout' : 'road' }), derived });
        expect(record).toMatchObject({ schema: 'agreement/v1', id: 'ag-imported', title: 'Block seven', city: 'zagreb', createdAt: content.createdAt,
            allocations: content.allocations, money: content.money, rule: content.rule, deadline: null,
            published: { cid: row.cid, publishedAt: row.createdAt, apiBase: API } });
        expect(record.designs).toEqual([
            { proposalId: 'design-layout', title: 'Lay out k9', goal: 'parcel-layout', cid: layoutCid },
            { proposalId: 'design-road', title: 'New lane', goal: 'road', cid: roadCid }
        ]);
        expect(record.inputs).toEqual(row.content.inputs);
        expect(record.outputs).toEqual(derived.outputs.map(output => ({
            ...output, producedBy: output.producedBy === 'road-1' ? 'design-road' : 'design-layout'
        })));
        expect(AgreementRecord.normalize(record).outputs.every(piece => piece.geometry)).toBe(true);
        expect(AgreementRecord.publishedCid(record)).toBe(row.cid);
    });

    it('keeps published output terms and the CID when local measurements have different precision', () => {
        const published = clone(content);
        published.outputs[0].areaM2 = 300.849715663882;
        const cid = Cid.cidOfObject(published);
        const derived = { outputs: clone(agreement().outputs) };
        derived.outputs.find(output => output.hash === published.outputs[0].hash).areaM2 = 300.849716;
        const imported = AgreementSync.recordFromPublished({ ...row, cid, content: published }, { id: 'ag-imported', apiBase: API, localIdOf, derived });
        expect(imported.outputs[0].areaM2).toBe(300.849715663882);
        expect(imported.outputs.every(output => output.geometry)).toBe(true);
        expect(AgreementRecord.publishedCid(imported)).toBe(cid);
    });

    it('carries unchanged land holdings from the published inputs regardless of this browser’s owner cache', () => {
        const raw = agreement();
        raw.outputs = raw.inputs.parcels.map((parcel, index) => output(parcel.parcelId, rect(index * 3, 0, index * 3 + 3, 2),
            parcel.areaM2, [parcel.parcelId], null, 'parcel', parcel.holders));
        raw.allocations = raw.outputs.map((piece, index) => ({ output: piece.hash, to: { kind: 'party', ownerKey: index === 0 ? 'agent-ana' : 'agent-ben' } }));
        raw.money = AgreementRecord.settle(raw).money;
        const content = AgreementRecord.published(raw);
        const cid = Cid.cidOfObject(content);
        const foreign = raw.outputs.map(piece => ({ ...piece, holders: [holder('unrelated-local-owner')] }));
        for (const derived of [null, { outputs: raw.outputs.map(piece => ({ ...piece, holders: [] })) }, { outputs: foreign }]) {
            const imported = AgreementSync.recordFromPublished({ cid, content, plan: raw.plan }, { id: 'ag-imported', apiBase: API, localIdOf, derived });
            const parties = AgreementRecord.ledger(imported).parties;
            expect(parties.map(party => [party.ownerKey, party.contributedM2, party.assignedM2, party.changeM2]))
                .toEqual([['agent-ana', 500, 500, 0], ['agent-ben', 500, 500, 0]]);
            expect(AgreementRecord.publishedCid(imported)).toBe(cid);
        }
    });

    it('keeps the published pieces by hash alone when the ground here makes other pieces', () => {
        const moved = clone(agreement().outputs).slice(0, 2);
        for (const derived of [null, { outputs: moved }]) {
            const record = AgreementSync.recordFromPublished(row, { id: 'ag-imported', apiBase: API, localIdOf, derived });
            expect(record.outputs).toEqual(content.outputs.map(piece => ({
                hash: piece.hash, pieceId: piece.hash, areaM2: piece.areaM2, fromParcelIds: piece.fromParcelIds,
                producedBy: piece.producedBy === roadCid ? 'design-road' : 'design-layout', role: piece.role, holders: [], geometry: null
            })));
            expect(() => AgreementRecord.normalize(record)).not.toThrow();
        }
    });

    it('keeps the sponsor it was proposed with, and the index\'s chain account once minted', () => {
        const onchain = { chain: 'solana', cluster: 'devnet', programId: 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ', account: ACCOUNT,
            sponsor: SPONSOR, status: 'active', decision: 'pending', observedAt: '2026-10-22T08:00:00.000Z' };
        const minted = AgreementSync.recordFromPublished({ ...row, onchain }, { id: 'ag-imported', apiBase: API, localIdOf });
        expect(minted.published).toEqual({ cid: row.cid, publishedAt: row.createdAt, apiBase: API, sponsor: SPONSOR });
        expect(minted.onchain).toEqual(onchain);
        expect(AgreementRecord.normalize(minted).onchain).toEqual(onchain);
        // Not minted: no chain account, whatever else the row carries there.
        for (const value of [undefined, null, 'HrcX5vC2', [onchain]]) {
            expect(AgreementSync.recordFromPublished({ ...row, onchain: value }, { id: 'ag-imported', apiBase: API, localIdOf }).onchain, String(value)).toBeNull();
        }
        // Proposed without a wallet: no sponsor, so it can only be proposed again before a mint.
        const unsponsored = AgreementRecord.published(agreement());
        const bare = { cid: Cid.cidOfObject(unsponsored), content: unsponsored, plan: agreement().plan, createdAt: row.createdAt };
        expect(AgreementSync.recordFromPublished(bare, { id: 'ag-bare', apiBase: API, localIdOf }).published.sponsor).toBeNull();
    });

    it('refuses an agreement whose designs are not held here, and anything that is not a row', () => {
        const error = (() => { try { AgreementSync.recordFromPublished(row, { id: 'x', apiBase: API, localIdOf: () => null }); } catch (e) { return e; } return null; })();
        expect(error).toMatchObject({ code: 'design-missing' });
        expect(() => AgreementSync.recordFromPublished({ cid: 'nope', content }, { id: 'x', apiBase: API, localIdOf })).toThrow(TypeError);
        expect(() => AgreementSync.recordFromPublished(row, { id: 'x', apiBase: API })).toThrow(/localIdOf/);
    });

    it('requires the fetched plan snapshot CID to match the agreement content', () => {
        const otherContent = PlanRecord.create('Other plan', row.plan.content.designCids, row.plan.content.view);
        const mismatched = { ...row, plan: { cid: Cid.cidOfObject(otherContent), content: otherContent } };
        expect(() => AgreementSync.recordFromPublished(mismatched, { id: 'x', apiBase: API, localIdOf })).toThrow(/exact plan/);
    });
});

// ---- the browser half ----------------------------------------------------------------------------

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The courier and the index: /pins recomputes the CID of the bytes it receives (node twin),
// /designs and /agreements file content under its CID, GET /agreements/:cid serves a row.
// POST /agreements/:cid/onchain answers onchain(body, cid) ({ status, body }); GET /agreements (the
// minted listing) answers minted(searchParams).
function fakeServer({ rows = new Map(), designs = new Map(), onchain = null, minted = null } = {}) {
    const calls = [];
    async function fetch(url, init = {}) {
        const { pathname, searchParams } = new URL(url);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, pathname, body, search: Object.fromEntries(searchParams) });
        const onchainPath = /^\/agreements\/([^/]+)\/onchain$/.exec(pathname);
        if (method === 'POST' && onchainPath && onchain) {
            const answer = await onchain(body, decodeURIComponent(onchainPath[1]));
            return json(answer.status, answer.body);
        }
        if (method === 'GET' && pathname === '/agreements' && minted) {
            const answer = minted(searchParams);
            return json(answer.status, answer.body);
        }
        if (method === 'POST' && pathname === '/designs/batch') {
            return json(200, { items: body.cids.flatMap(cid => designs.has(cid) ? [{ cid, design: designs.get(cid) }] : []) });
        }
        if (method === 'POST' && pathname === '/pins') {
            const cid = NodeCid.cidOf(Buffer.from(body.bytes, 'base64'));
            return cid === body.cid ? json(200, { cid, pinnedAt: '2026-10-21T12:00:00.000Z' }) : json(409, { code: 'cid-mismatch' });
        }
        if (method === 'POST' && (pathname === '/designs' || pathname === '/agreements')) {
            return json(201, { cid: body.cid, content: body.content, createdAt: '2026-10-21T12:00:05.000Z' });
        }
        if (method === 'GET' && pathname.startsWith('/agreements/')) {
            const row = rows.get(decodeURIComponent(pathname.slice('/agreements/'.length)));
            return row ? json(200, row) : json(404, { code: 'agreement_not_found' });
        }
        return json(404, {});
    }
    return { fetch, calls };
}

function fakeWindow({ blocked = null, applied = true, records = [layout(), road()], saved = [agreement()], server = fakeServer(), wallet = SPONSOR, plans = null } = {}) {
    const proposals = new Map(records.map(record => [record.proposalId, record]));
    const agreements = new Map(saved.map(row => [row.id, clone(row)]));
    const win = {
        fetch: server.fetch,
        btoa: text => Buffer.from(text, 'binary').toString('base64'),
        resolveBackendBaseUrl: () => API,
        resolveFrontendBaseUrl: () => 'https://app.example.test',
        CityConfigManager: {
            getCityConfig: city => (city === 'zagreb' ? { parcels: { sourceId: 'zagreb-dgu' } } : null),
            resolveCityId: city => city, getCurrentCityId: () => 'zagreb', getCityCodeForCityId: id => (id === 'zagreb' ? 'zg' : null)
        },
        i18n: { getLanguage: () => 'hr' },
        ProposalPublishTerms: PublishTerms,
        AgreementRecord,
        guestPolicyBlocks: action => (action === 'publish' ? blocked : null),
        stampCurrentAuthor: record => { record.author = record.author || 'Ana'; return record; },
        getCurrentUserAgent: () => ({ id: 'agent-ana', name: ' Ana ' }),
        solanaWalletManager: { getState: () => (wallet ? { status: 'connected', accounts: [wallet] } : { status: 'disconnected', accounts: [] }) },
        isApplied: record => applied && record.applied === true,
        isProposalCurrentlyApplied: record => record.applied === true,
        PlanRecord,
        MapShare: { capture: () => agreement().plan.content.view },
        NamedPlans: { fetchPlan: async cid => {
            const available = plans || new Map(saved.map(row => [row.plan?.cid, row.plan]).filter(([key]) => key));
            const plan = available.get(cid);
            if (!plan) throw Object.assign(new Error('plan-not-found'), { code: 'plan-not-found' });
            return clone(plan);
        } },
        proposalStorage: {
            getProposal: id => proposals.get(id) || null,
            getAllProposals: () => [...proposals.values()],
            _indexProposal: () => {},
            save: () => {}
        },
        AgreementStore: {
            get: id => (agreements.has(id) ? clone(agreements.get(id)) : null),
            list: () => [...agreements.values()].map(clone),
            save: record => { agreements.set(record.id, clone(record)); return clone(record); }
        }
    };
    // DesignSync's browser half also installs the link helpers (buildCityQueryParam, shareLangParam).
    win.DesignSync = Object.freeze({ ...DesignSync, ...DesignSync.browser(win).api });
    const sync = AgreementSync.browser(win);
    return { win, sync, server, proposals, agreements };
}

describe('agreementLink', () => {
    const cid = Cid.cidOfObject({ schema: 'agreement/v1' });
    it('opens the agreement in its city and the current language', () => {
        const { sync, win } = fakeWindow();
        expect(sync.agreementLink(cid, { city: 'zagreb' })).toBe(`https://app.example.test/agreements/${cid}?city=zg&lang=hr`);
        win.buildCityQueryParam = () => '';
        expect(sync.agreementLink(cid)).toBe(`https://app.example.test/agreements/${cid}?lang=hr`);
        win.shareLangParam = () => '';
        expect(sync.agreementLink(cid)).toBe(`https://app.example.test/agreements/${cid}`);
    });
});

describe('publishAgreement', () => {
    it('publishes the designs, sends a layout with the agreement, pins and indexes it and marks it proposed', async () => {
        const { sync, server, proposals, agreements } = fakeWindow();
        const result = await sync.publishAgreement('ag-1');
        expect(server.calls.map(call => `${call.method} ${call.pathname}`)).toEqual([
            'POST /pins', // the layout, pinned only
            'POST /pins', 'POST /designs', // the road, published on its own
            'POST /pins', // the plan snapshot
            'POST /pins', 'POST /agreements'
        ]);
        // Authors are stamped before the CIDs are taken, so the agreement links the stamped designs.
        const layoutCid = DesignRecord.cidOf(proposals.get('layout-1'));
        const roadCid = DesignRecord.cidOf(proposals.get('road-1'));
        expect(proposals.get('layout-1').author).toBe('Ana');
        const body = server.calls[5].body;
        expect(body.designs).toEqual([{ cid: layoutCid, content: DesignRecord.published(proposals.get('layout-1')) }]);
        expect(body.cid).toBe(NodeCid.cidOfObject(body.content));
        expect(result.cid).toBe(body.cid);
        expect(body.content).toMatchObject({ schema: 'agreement/v1', author: 'Ana', sponsor: SPONSOR, city: 'zagreb', planCid: body.plan.cid });
        expect(body.content).not.toHaveProperty('designs');
        expect(body.plan.content.designCids).toEqual([layoutCid, roadCid].sort());
        expect(body.plan).toEqual(agreements.get('ag-1').plan);
        expect(body.content.inputs.parcels.map(parcel => parcel.parcelSourceId)).toEqual(['zagreb-dgu', 'zagreb-dgu']);
        expect(body.content.outputs.map(piece => piece.producedBy)).toEqual([layoutCid, layoutCid, roadCid]);

        const stored = agreements.get('ag-1');
        expect(stored.published).toEqual({ cid: result.cid, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API, sponsor: SPONSOR });
        expect(stored.designs.map(design => design.cid)).toEqual([layoutCid, roadCid]);
        expect(stored.plan.cid).toBe(body.content.planCid);
        expect(proposals.get('layout-1').published).toEqual({ cid: layoutCid, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API });
        expect(proposals.get('road-1').published.cid).toBe(roadCid);
        expect(result.link).toBe(`https://app.example.test/agreements/${result.cid}?city=zg&lang=hr`);

        // Proposed once: proposing again sends nothing and answers the same CID.
        expect(await sync.publishAgreement('ag-1')).toEqual({ cid: result.cid, row: null, link: result.link });
        expect(server.calls).toHaveLength(6);
    });

    it('proposes without a sponsor when no wallet is connected', async () => {
        const { sync, server, agreements } = fakeWindow({ wallet: null });
        await sync.publishAgreement('ag-1');
        expect(server.calls.at(-1).body.content.sponsor).toBeNull();
        expect(agreements.get('ag-1').published.sponsor).toBeNull();
    });

    it('refuses an invalid agreement and a guest without a name before anything leaves the device', async () => {
        const unapplied = fakeWindow({ applied: false });
        expect(await thrown(() => unapplied.sync.publishAgreement('ag-1')))
            .toMatchObject({ code: 'invalid-agreement', message: 'Design Lay out k9 is not applied on the map.' });
        const empty = fakeWindow({ saved: [agreement({ designs: [] })] });
        expect(await thrown(() => empty.sync.publishAgreement('ag-1'))).toMatchObject({ code: 'invalid-agreement', message: 'Choose at least one design.' });
        const guest = fakeWindow({ blocked: 'Choose a name before proposing.' });
        expect(await thrown(() => guest.sync.publishAgreement('ag-1')))
            .toMatchObject({ code: 'name-needed', cancelled: true, message: 'Choose a name before proposing.' });
        expect(await thrown(() => guest.sync.publishAgreement('ag-gone'))).toMatchObject({ code: 'agreement-missing' });
        [unapplied, empty, guest].forEach(({ server, agreements }) => {
            expect(server.calls).toEqual([]);
            expect(agreements.get('ag-1').published).toBeNull();
        });
    });
});

describe('fetchAgreement and refusals', () => {
    it('reads an agreement only when its content is the CID it is filed under', async () => {
        const content = AgreementRecord.published(agreement());
        const cid = Cid.cidOfObject(content);
        const tamperedCid = Cid.cidOfObject({ another: 'agreement' });
        const plan = agreement().plan;
        const rows = new Map([[cid, { cid, content, plan, createdAt: '2026-10-21T12:00:00.000Z' }], [tamperedCid, { cid: tamperedCid, content, plan }]]);
        const { sync } = fakeWindow({ server: fakeServer({ rows }), plans: new Map([[plan.cid, plan]]) });
        expect((await sync.fetchAgreement(cid)).content).toEqual(content);
        expect((await sync.fetchAgreement(cid)).plan).toEqual(plan);
        expect(await thrown(() => sync.fetchAgreement(tamperedCid))).toMatchObject({ code: 'cid-mismatch' });
        expect(await thrown(() => sync.fetchAgreement(Cid.cidOfObject({ missing: true })))).toMatchObject({ code: 'agreement-not-found' });
        expect(await thrown(() => sync.fetchAgreement('ag-1'))).toMatchObject({ code: 'invalid-cid' });
    });

    it('refuses a row without the exact plan snapshot', async () => {
        const plan = PlanRecord.create('Unavailable plan', agreement().plan.content.designCids, agreement().plan.content.view);
        const content = { ...AgreementRecord.published(agreement()), planCid: Cid.cidOfObject(plan) };
        const cid = Cid.cidOfObject(content);
        const rows = new Map([[cid, { cid, content }]]);
        const { sync } = fakeWindow({ server: fakeServer({ rows }), plans: new Map() });
        expect(await thrown(() => sync.fetchAgreement(cid))).toMatchObject({ code: 'plan-not-found' });
    });

    it('words the index\'s refusals of an agreement', () => {
        const { sync } = fakeWindow();
        expect(sync.refusalMessage(409, { code: 'design-not-indexed', missing: ['a', 'b'] })).toBe('The server does not hold 2 of the agreement’s designs, so it was not proposed.');
        expect(sync.refusalMessage(409, { code: 'inputs-differ-from-binding', missing: ['k9'], extra: ['k11'] })).toMatch(/\(k9, k11\)/);
        expect(sync.refusalMessage(422, { code: 'deadline-past' })).toMatch(/deadline has passed/);
        expect(sync.refusalMessage(409, { code: 'cid-mismatch' })).toMatch(/different identity for this agreement/);
        expect(sync.refusalMessage(503, { code: 'pinning-unconfigured' })).toMatch(/cannot pin published agreements/);
        expect(sync.refusalMessage(500, null)).toBe('The server refused this agreement: HTTP 500');
    });
});

// ---- on chain (M3) -------------------------------------------------------------------------------

// The agreement as proposed with a sponsor, and the pointer the index answers for its account.
const PROPOSED_CID = AgreementRecord.publishedCid({ ...agreement(), sponsor: SPONSOR });
const proposed = (extra = {}) => agreement({ published: { cid: PROPOSED_CID, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API, sponsor: SPONSOR }, ...extra });
const indexed = ({ cluster, account }) => ({
    chain: 'solana', cluster, programId: 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ', account, sponsor: SPONSOR, lens: SPONSOR,
    status: 'active', decision: 'pending', deadline: null, requiredLamports: '0', escrowLamports: '0',
    executedAt: null, observedAt: '2026-10-22T08:00:00.000Z', observedSlot: 4321
});
const MINT = { chain: 'solana', cluster: 'devnet', account: ACCOUNT, signature: 'sig-1' };

describe('recordOnchain', () => {
    it('mirrors the mint into the index and keeps the index\'s record of the account', async () => {
        const server = fakeServer({ onchain: (body, cid) => ({ status: 200, body: { cid, onchain: indexed(body) } }) });
        const { sync, agreements } = fakeWindow({ saved: [proposed()], server });
        const result = await sync.recordOnchain('ag-1', MINT);
        expect(server.calls).toEqual([{ method: 'POST', pathname: `/agreements/${PROPOSED_CID}/onchain`, body: MINT, search: {} }]);
        expect(result.onchain).toEqual(indexed(MINT));
        expect(result.row.cid).toBe(PROPOSED_CID);
        const stored = agreements.get('ag-1');
        expect(stored.onchain).toEqual(indexed(MINT));
        // Nothing else of the record moves.
        expect({ ...stored, onchain: null }).toEqual(proposed({ onchain: null }));
    });

    it('sends no signature when there is none, and records the account alone when the index does not see the signature yet', async () => {
        const bodies = [];
        const server = fakeServer({
            onchain: body => {
                bodies.push(body);
                return body.signature ? { status: 409, body: { code: 'onchain-signature-not-found' } } : { status: 200, body: { cid: PROPOSED_CID, onchain: indexed(body) } };
            }
        });
        const { sync, agreements } = fakeWindow({ saved: [proposed()], server });
        await sync.recordOnchain('ag-1', MINT);
        const { signature, ...accountOnly } = MINT;
        expect(signature).toBe('sig-1');
        expect(bodies).toEqual([MINT, accountOnly]);
        expect(agreements.get('ag-1').onchain).toEqual(indexed(MINT));
        bodies.length = 0;
        await sync.recordOnchain('ag-1', accountOnly);
        expect(bodies).toEqual([accountOnly]);
    });

    it('keeps the mint on this device when the index refuses it or cannot be reached, and says why', async () => {
        const refusals = [
            [409, { code: 'onchain-account-mismatch' }, 'onchain-account-mismatch', /derives a different chain account/],
            [409, { code: 'onchain-cid-mismatch' }, 'onchain-cid-mismatch', /holds a different agreement/],
            [404, { code: 'onchain-account-missing' }, 'onchain-account-missing', /does not see the agreement’s account/],
            [400, { code: 'unsupported-cluster' }, 'unsupported-cluster', /Solana devnet only/],
            [422, { code: 'not-binding', error: 'only a binding agreement is minted' }, 'not-binding', /did not record the mint: only a binding agreement is minted/],
            [500, null, 'http-500', /did not record the mint: HTTP 500/]
        ];
        for (const [status, body, code, words] of refusals) {
            const { sync, agreements } = fakeWindow({ saved: [proposed()], server: fakeServer({ onchain: () => ({ status, body }) }) });
            const error = await thrown(() => sync.recordOnchain('ag-1', MINT));
            expect(error, code).toMatchObject({ code, kept: true, status });
            expect(error.message, code).toMatch(words);
            expect(agreements.get('ag-1').onchain, code).toEqual(MINT);
        }
        const offline = { calls: [], fetch: async () => { throw new TypeError('Failed to fetch'); } };
        const { sync, agreements } = fakeWindow({ saved: [proposed()], server: offline });
        expect(await thrown(() => sync.recordOnchain('ag-1', MINT))).toMatchObject({ code: 'network-failed', kept: true });
        expect(agreements.get('ag-1').onchain).toEqual(MINT);
    });

    it('refuses an agreement not proposed or not here, and a pointer that names no Solana account, sending nothing', async () => {
        const draft = fakeWindow({ server: fakeServer({ onchain: () => ({ status: 200, body: {} }) }) });
        expect(await thrown(() => draft.sync.recordOnchain('ag-1', MINT))).toMatchObject({ code: 'not-proposed' });
        expect(await thrown(() => draft.sync.recordOnchain('ag-gone', MINT))).toMatchObject({ code: 'agreement-missing' });
        const minted = fakeWindow({ saved: [proposed()], server: fakeServer({ onchain: () => ({ status: 200, body: {} }) }) });
        for (const bad of [{ ...MINT, chain: 'evm' }, { ...MINT, cluster: ' ' }, { chain: 'solana', cluster: 'devnet' }, undefined]) {
            expect(await thrown(() => minted.sync.recordOnchain('ag-1', bad)), JSON.stringify(bad)).toBeInstanceOf(TypeError);
        }
        expect(draft.server.calls).toEqual([]);
        expect(minted.server.calls).toEqual([]);
        expect(draft.agreements.get('ag-1').onchain).toBeNull();
        expect(minted.agreements.get('ag-1').onchain).toBeNull();
    });
});

describe('adoptOnchain', () => {
    it('keeps a chain account on the record as given, and refuses anything else', async () => {
        const { sync, agreements } = fakeWindow({ saved: [proposed()] });
        const pointer = { chain: 'solana', cluster: 'devnet', account: ACCOUNT };
        expect(sync.adoptOnchain('ag-1', pointer).onchain).toEqual(pointer);
        expect(agreements.get('ag-1').onchain).toEqual(pointer);
        expect(() => sync.adoptOnchain('ag-1', ACCOUNT)).toThrow(TypeError);
        expect(() => sync.adoptOnchain('ag-1', null)).toThrow(TypeError);
        expect(await thrown(() => sync.adoptOnchain('ag-gone', pointer))).toMatchObject({ code: 'agreement-missing' });
        expect(agreements.get('ag-1').onchain).toEqual(pointer);
    });
});

describe('fetchMinted', () => {
    it('lists the city\'s minted agreements from the index, only rows with a CID and a chain account', async () => {
        const minted = { cid: PROPOSED_CID, title: 'Block seven', onchain: indexed(MINT) };
        const other = Cid.cidOfObject({ schema: 'agreement/v1', title: 'other' });
        const listing = [minted, { cid: other, onchain: null }, { cid: other }, { cid: 'ag-1', onchain: indexed(MINT) }, null];
        const server = fakeServer({ minted: () => ({ status: 200, body: { agreements: listing } }) });
        const { sync } = fakeWindow({ server });
        expect(await sync.fetchMinted({ city: 'zagreb' })).toEqual([minted]);
        expect(server.calls[0]).toMatchObject({ method: 'GET', pathname: '/agreements', search: { minted: '1', limit: '100', city: 'zagreb' } });
        await sync.fetchMinted({ limit: 5 });
        expect(server.calls[1].search).toEqual({ minted: '1', limit: '5' });
    });

    it('fails with the index\'s code when the listing is refused or not a listing', async () => {
        const refused = fakeWindow({ server: fakeServer({ minted: () => ({ status: 503, body: { code: 'index-unavailable', error: 'The index is down.' } }) }) });
        expect(await thrown(() => refused.sync.fetchMinted({ city: 'zagreb' }))).toMatchObject({ code: 'index-unavailable', message: 'The index is down.' });
        const malformed = fakeWindow({ server: fakeServer({ minted: () => ({ status: 200, body: { rows: [] } }) }) });
        expect(await thrown(() => malformed.sync.fetchMinted({ city: 'zagreb' }))).toMatchObject({ code: 'http-200' });
    });
});

describe('proposeAgain', () => {
    it('proposes a copy sponsored by the connected wallet as a new agreement, leaving the old one as it was', async () => {
        const { sync, win, server, agreements } = fakeWindow({ wallet: null });
        const first = await sync.publishAgreement('ag-1');
        expect(agreements.get('ag-1').published.sponsor).toBeNull();
        win.solanaWalletManager.getState = () => ({ status: 'connected', accounts: [SPONSOR] });
        const before = agreements.get('ag-1');
        const again = await sync.proposeAgain('ag-1');
        expect(again.id).not.toBe('ag-1');
        expect(again.id).toMatch(/^ag-/);
        expect(again.cid).not.toBe(first.cid);
        expect(agreements.get('ag-1')).toEqual(before);
        const copy = agreements.get(again.id);
        expect(copy.published).toEqual({ cid: again.cid, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API, sponsor: SPONSOR });
        expect(copy.onchain).toBeNull();
        expect(copy.designs).toEqual(before.designs);
        expect(copy.plan).toEqual(before.plan);
        expect(Date.parse(copy.createdAt)).toBeGreaterThan(Date.parse(before.createdAt));
        const indexedBody = server.calls.at(-1);
        expect(indexedBody).toMatchObject({ method: 'POST', pathname: '/agreements' });
        expect(indexedBody.body.cid).toBe(again.cid);
        expect(indexedBody.body.content.sponsor).toBe(SPONSOR);
        expect(again.link).toBe(`https://app.example.test/agreements/${again.cid}?city=zg&lang=hr`);
    });

    it('needs a connected wallet and the agreement on this device', async () => {
        const { sync, server, agreements } = fakeWindow({ wallet: null });
        expect(await thrown(() => sync.proposeAgain('ag-1'))).toMatchObject({ code: 'wallet-required' });
        const connected = fakeWindow();
        expect(await thrown(() => connected.sync.proposeAgain('ag-gone'))).toMatchObject({ code: 'agreement-missing' });
        expect(server.calls).toEqual([]);
        expect(connected.server.calls).toEqual([]);
        expect([...agreements.keys()]).toEqual(['ag-1']);
    });
});

describe('opening an /agreements link', () => {
    it('opens an agreement normally when a secondary-tab marker is present', async () => {
        const content = AgreementRecord.published(agreement());
        const cid = Cid.cidOfObject(content);
        const row = { cid, content, createdAt: '2026-10-21T12:00:05.000Z', city: content.city, status: 'active', onchain: null };
        const layoutContent = DesignRecord.published(layout());
        const roadContent = DesignRecord.published(road());
        const layoutCid = Cid.cidOfObject(layoutContent);
        const roadCid = Cid.cidOfObject(roadContent);
        const designRows = new Map([
            [layoutCid, { cid: layoutCid, content: layoutContent, createdAt: row.createdAt, city: layoutContent.city }],
            [roadCid, { cid: roadCid, content: roadContent, createdAt: row.createdAt, city: roadContent.city }]
        ]);
        const server = fakeServer({ rows: new Map([[cid, row]]), designs: designRows });
        const { win, sync, agreements } = fakeWindow({ server });
        win.__cbSecondaryTab = true;
        win.CityConfigManager.foreignGroundContextFor = () => null;
        const handleSharedDesignRoute = vi.fn(async cids => ({ blocked: false, failed: [],
            localIds: new Map(cids.map((designCid, index) => [designCid, ['layout-1', 'road-1'][index]])) }));
        const opened = vi.fn(async () => {});
        win.AgreementPanel = { open: opened };
        win.handleSharedDesignRoute = handleSharedDesignRoute;
        const save = vi.spyOn(win.AgreementStore, 'save');

        await sync.handleAgreementRoute(cid);

        expect(server.calls.map(call => `${call.method} ${call.pathname}`)).toEqual([`GET /agreements/${cid}`]);
        expect(handleSharedDesignRoute).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
        expect(agreements.size).toBe(2);
        expect(opened).toHaveBeenCalledOnce();
        expect(agreements.get(save.mock.results[0].value.id)).toMatchObject({ published: { cid }, title: content.title });
        expect(agreements.get(save.mock.results[0].value.id).plan).toEqual(agreement().plan);
        expect(agreements.get(save.mock.results[0].value.id).designs.map(design => design.cid).sort()).toEqual(agreement().plan.content.designCids);
    });

    it('keeps a mint this device made that the index has not recorded, and takes the index\'s once it has', async () => {
        const content = AgreementRecord.published({ ...agreement(), sponsor: SPONSOR });
        const cid = Cid.cidOfObject(content);
        const row = { cid, content, createdAt: '2026-10-21T12:00:05.000Z', city: 'zagreb', status: 'active', onchain: null };
        const rows = new Map([[cid, row]]);
        const local = { chain: 'solana', cluster: 'devnet', account: ACCOUNT, signature: 'sig-1' };
        const saved = [agreement({ published: { cid, publishedAt: row.createdAt, apiBase: API, sponsor: SPONSOR }, onchain: local })];
        // Designs held but not applied here, so the pieces are kept by hash (no land is derived).
        const { win, sync, agreements } = fakeWindow({ applied: false, saved, server: fakeServer({ rows }) });
        const opened = [];
        const messages = [];
        Object.assign(win, {
            CityConfigManager: { ...win.CityConfigManager, foreignGroundContextFor: () => null },
            handleSharedDesignRoute: async cids => ({ blocked: false, failed: [], localIds: new Map(cids.map((designCid, index) => [designCid, ['layout-1', 'road-1'][index]])) }),
            AgreementPanel: { open: async id => { opened.push(id); } },
            showEphemeralMessage: message => { messages.push(message); }
        });
        await sync.handleAgreementRoute(cid);
        expect(messages).toEqual([]);
        expect(opened).toEqual(['ag-1']);
        expect(agreements.get('ag-1').onchain).toEqual(local);
        expect(agreements.get('ag-1').published).toEqual({ cid, publishedAt: row.createdAt, apiBase: API, sponsor: SPONSOR });

        row.onchain = indexed(local);
        await sync.handleAgreementRoute(cid);
        expect(opened).toEqual(['ag-1', 'ag-1']);
        expect(agreements.get('ag-1').onchain).toEqual(indexed(local));
    });
});

describe('reads with a deadline', () => {
    it('gives up a read of the index at the parcel-load deadline, never a write, and reads a late answer as unreachable', async () => {
        const content = AgreementRecord.published(agreement());
        const cid = Cid.cidOfObject(content);
        const server = fakeServer({
            rows: new Map([[cid, { cid, content, createdAt: '2026-10-21T12:00:00.000Z' }]]),
            minted: () => ({ status: 200, body: { agreements: [] } }),
            onchain: (body, at) => ({ status: 200, body: { cid: at, onchain: indexed(body) } })
        });
        const { win, sync } = fakeWindow({ saved: [proposed()], server });
        const deadlines = [];
        const signals = [];
        const fetch = win.fetch;
        win.fetch = (url, init = {}) => { signals.push(init.signal || null); return fetch(url, init); };
        win.ParcelSourceHealth = { withDeadline: async (load, options) => { deadlines.push(options); return load('deadline-signal'); } };
        win.PARCEL_LOAD_TIMEOUT_MS = 1234;
        await sync.fetchAgreement(cid);
        await sync.fetchMinted({ city: 'zagreb' });
        await sync.recordOnchain('ag-1', MINT);
        expect(deadlines).toEqual([{ timeoutMs: 1234, code: 'agreement-load-timeout' }, { timeoutMs: 1234, code: 'agreement-load-timeout' }]);
        expect(signals).toEqual(['deadline-signal', 'deadline-signal', null]);
        // Without a configured deadline, 30 s.
        delete win.PARCEL_LOAD_TIMEOUT_MS;
        await sync.fetchMinted({ city: 'zagreb' });
        expect(deadlines.at(-1)).toEqual({ timeoutMs: 30000, code: 'agreement-load-timeout' });
        win.ParcelSourceHealth = { withDeadline: async () => { throw Object.assign(new Error('timed out'), { code: 'agreement-load-timeout' }); } };
        expect(await thrown(() => sync.fetchMinted({ city: 'zagreb' }))).toMatchObject({ code: 'network-failed' });
        expect(await thrown(() => sync.fetchAgreement(cid))).toMatchObject({ code: 'network-failed' });
    });
});
