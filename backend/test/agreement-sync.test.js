// Unit tests for frontend/js/agreement-sync.js: /agreements/<cid> paths and links, the local record
// rebuilt from a published agreement/v1 object, and Propose on a fake window with the real
// DesignSync and AgreementRecord over a fake courier and index: what is pinned and indexed, the
// record marked published, and the refusals that stop it before anything leaves the device.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgreementSync = require('../../frontend/js/agreement-sync.js');
const AgreementRecord = require('../../frontend/js/agreement-record.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');
const PublishTerms = require('../../frontend/js/proposals/publish-terms.js');
let NodeCid;
beforeAll(async () => { NodeCid = await import('../cid.js'); });

const API = 'https://api.example.test';
const SPONSOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
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
    const inputs = { parcels: [{ parcelId: 'k9', areaM2: 1000, holders: [holder('agent-ana')] }, { parcelId: 'k10', areaM2: 800, holders: [holder('agent-ben')] }], openGroundM2: 0 };
    const outputs = [
        output('k9-p1', rect(0, 0, 1, 2), 300, ['k9'], 'layout-1', 'plot', [holder('agent-ana')]),
        output('k9-p2', rect(1, 0, 3, 2), 600, ['k9'], 'layout-1', 'plot', [holder('agent-ana')]),
        output('road-1#1', rect(0, 2, 5, 2.2), 100, ['k9', 'k10'], 'road-1', 'corridor', [])
    ];
    return {
        schema: 'agreement/v1', id: 'ag-1', title: 'Block seven', city: 'zagreb',
        createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z',
        designs: [
            { proposalId: 'layout-1', title: 'Lay out k9', goal: 'parcel-layout', cid: DesignRecord.cidOf(layout()) },
            { proposalId: 'road-1', title: 'New lane', goal: 'road', cid: DesignRecord.cidOf(road()) }
        ],
        inputs, outputs,
        allocations: [{ output: outputs[2].hash, to: { kind: 'public' } }],
        money: { currency: 'EUR', lines: [{ ownerKey: 'agent-ana', amountCents: 5000 }] },
        rule: { electorate: 'owners', binding: true, lens: ['lens-member-1'],
            approvalConfig: { schema: 'proposal-approval/v1', rights: AgreementRecord.rightsFromInputs(inputs), policy: { type: 'unanimous' } } },
        deadline: null, published: null, ...extra
    };
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
    const row = { cid: Cid.cidOfObject(content), content, createdAt: '2026-10-21T12:00:00.000Z' };
    const localIds = new Map([[layoutCid, 'design-layout'], [roadCid, 'design-road']]);
    const localIdOf = cid => localIds.get(cid) || null;

    it('names the designs by their local copies and keeps the pieces derived here when they are the published ones', () => {
        const derived = { outputs: clone(agreement().outputs) };
        const record = AgreementSync.recordFromPublished(row, { id: 'ag-imported', apiBase: API, localIdOf, derived });
        expect(record).toMatchObject({ schema: 'agreement/v1', id: 'ag-imported', title: 'Block seven', city: 'zagreb', createdAt: content.createdAt,
            allocations: content.allocations, money: content.money, rule: content.rule, deadline: null,
            published: { cid: row.cid, publishedAt: row.createdAt, apiBase: API } });
        expect(record.designs).toEqual([
            { proposalId: 'design-layout', title: 'Lay out k9', goal: 'parcel-layout', cid: layoutCid },
            { proposalId: 'design-road', title: 'New lane', goal: 'road', cid: roadCid }
        ]);
        expect(record.inputs).toEqual(agreement().inputs);
        expect(record.outputs).toBe(derived.outputs);
        expect(AgreementRecord.normalize(record).outputs.every(piece => piece.geometry)).toBe(true);
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

    it('refuses an agreement whose designs are not held here, and anything that is not a row', () => {
        const error = (() => { try { AgreementSync.recordFromPublished(row, { id: 'x', apiBase: API, localIdOf: () => null }); } catch (e) { return e; } return null; })();
        expect(error).toMatchObject({ code: 'design-missing' });
        expect(() => AgreementSync.recordFromPublished({ cid: 'nope', content }, { id: 'x', apiBase: API, localIdOf })).toThrow(TypeError);
        expect(() => AgreementSync.recordFromPublished(row, { id: 'x', apiBase: API })).toThrow(/localIdOf/);
    });
});

// ---- the browser half ----------------------------------------------------------------------------

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The courier and the index: /pins recomputes the CID of the bytes it receives (node twin),
// /designs and /agreements file content under its CID, GET /agreements/:cid serves a row.
function fakeServer({ rows = new Map() } = {}) {
    const calls = [];
    async function fetch(url, init = {}) {
        const { pathname } = new URL(url);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, pathname, body });
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

function fakeWindow({ blocked = null, applied = true, records = [layout(), road()], saved = [agreement()], server = fakeServer(), wallet = SPONSOR } = {}) {
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
            'POST /pins', 'POST /agreements'
        ]);
        // Authors are stamped before the CIDs are taken, so the agreement links the stamped designs.
        const layoutCid = DesignRecord.cidOf(proposals.get('layout-1'));
        const roadCid = DesignRecord.cidOf(proposals.get('road-1'));
        expect(proposals.get('layout-1').author).toBe('Ana');
        const body = server.calls[4].body;
        expect(body.designs).toEqual([{ cid: layoutCid, content: DesignRecord.published(proposals.get('layout-1')) }]);
        expect(body.cid).toBe(NodeCid.cidOfObject(body.content));
        expect(result.cid).toBe(body.cid);
        expect(body.content).toMatchObject({ schema: 'agreement/v1', author: 'Ana', sponsor: SPONSOR, city: 'zagreb',
            designs: [{ cid: layoutCid, goal: 'parcel-layout', title: 'Lay out k9' }, { cid: roadCid, goal: 'road', title: 'New lane' }] });
        expect(body.content.inputs.parcels.map(parcel => parcel.parcelSourceId)).toEqual(['zagreb-dgu', 'zagreb-dgu']);
        expect(body.content.outputs.map(piece => piece.producedBy)).toEqual([layoutCid, layoutCid, roadCid]);

        const stored = agreements.get('ag-1');
        expect(stored.published).toEqual({ cid: result.cid, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API });
        expect(stored.designs.map(design => design.cid)).toEqual([layoutCid, roadCid]);
        expect(proposals.get('layout-1').published).toEqual({ cid: layoutCid, publishedAt: '2026-10-21T12:00:05.000Z', apiBase: API });
        expect(proposals.get('road-1').published.cid).toBe(roadCid);
        expect(result.link).toBe(`https://app.example.test/agreements/${result.cid}?city=zg&lang=hr`);

        // Proposed once: proposing again sends nothing and answers the same CID.
        expect(await sync.publishAgreement('ag-1')).toEqual({ cid: result.cid, row: null, link: result.link });
        expect(server.calls).toHaveLength(5);
    });

    it('proposes without a sponsor when no wallet is connected', async () => {
        const { sync, server } = fakeWindow({ wallet: null });
        await sync.publishAgreement('ag-1');
        expect(server.calls.at(-1).body.content.sponsor).toBeNull();
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
        const rows = new Map([[cid, { cid, content, createdAt: '2026-10-21T12:00:00.000Z' }], [tamperedCid, { cid: tamperedCid, content }]]);
        const { sync } = fakeWindow({ server: fakeServer({ rows }) });
        expect((await sync.fetchAgreement(cid)).content).toEqual(content);
        expect(await thrown(() => sync.fetchAgreement(tamperedCid))).toMatchObject({ code: 'cid-mismatch' });
        expect(await thrown(() => sync.fetchAgreement(Cid.cidOfObject({ missing: true })))).toMatchObject({ code: 'agreement-not-found' });
        expect(await thrown(() => sync.fetchAgreement('ag-1'))).toMatchObject({ code: 'invalid-cid' });
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
