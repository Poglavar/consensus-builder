// Tests for backend/scripts/lib/restatement-publish.mjs, the publish path every restatement shares: the
// canonical design/v1 objects of a plan, its community-vote agreement over the captured ground, the page
// job --capture runs in the app, and the --dry-run, --designs, --capture and --agreement steps driven
// in-process against a fake index (fetch) and a fake agent-browser, with the per-design checkpoint kept
// in a temporary home directory.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { cidOf, canonicalBytes } from '../cid.js';
import { designObject, planForDesigns } from '../agents/agreement-objects.js';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';

// The checkpoint directory is derived from the home directory when the module loads: every run here
// writes under a temporary home, never under the real one.
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal();
    const homedir = () => globalThis.__restatementTestHome || actual.homedir();
    return { ...actual, homedir, default: { ...actual.default, homedir } };
});

const require = createRequire(import.meta.url);
const corridorOsmForm = require('../../frontend/js/corridor-osm-form.js');
const corridorProfile = require('../../frontend/js/corridor-profile.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'restatement-publish-'));
globalThis.__restatementTestHome = path.join(TMP, 'home');
let lib;

beforeAll(async () => {
    lib = await import('../scripts/lib/restatement-publish.mjs');
    // Fail before anything is written if the checkpoint root is not under the temporary home.
    if (!lib.STATE_ROOT.startsWith(globalThis.__restatementTestHome)) throw new Error(`checkpoints would go to ${lib.STATE_ROOT}`);
});

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete globalThis.__restatementTestHome;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
});

// ---- fixtures ------------------------------------------------------------------------------------------

const AT = '2026-06-23T00:00:00.000Z';
const API = 'http://localhost:4999';
const APP = 'http://localhost:4998';
const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const SITE = box(15.970, 45.800, 15.972, 45.802);
const piece = seed => `piece1-sha256:${seed.repeat(64).slice(0, 64)}`;
let planCounter = 0;

function parkRecord(overrides = {}) {
    return {
        goal: 'park', title: 'Park on the corner', description: 'A public park.', author: 'Plan author', city: 'zagreb',
        createdAt: AT, geometry: box(15.970, 45.800, 15.971, 45.801),
        structureProposal: { kind: 'park', geometry: box(15.970, 45.800, 15.971, 45.801) }, ...overrides
    };
}
function buildingRecord(overrides = {}) {
    return {
        goal: 'buildings', title: 'Block on plot 2', description: 'Five storeys.', author: 'Plan author', city: 'zagreb', createdAt: AT,
        geometry: { buildings: [{ type: 'Feature', properties: { type: 'proposedBuildingSingle', height: 17.5 }, geometry: box(15.9712, 45.8012, 15.9716, 45.8016) }] },
        buildingProposal: { typologyType: 'single', parameters: { height: 17.5, floors: 5, typology: 'single', rotation: 0 } }, ...overrides
    };
}
function layoutRecord(overrides = {}) {
    return {
        goal: 'parcel-layout', title: 'New plots', description: 'Two plots.', author: 'Plan author', city: 'zagreb', createdAt: AT,
        site: SITE,
        parcelLayout: {
            algorithm: 'manual', generatedAt: AT, pool: SITE, totalArea: 2.0,
            plots: [{ geometry: box(15.970, 45.800, 15.971, 45.802), area: 1, source: 'geojson' }, { geometry: box(15.971, 45.800, 15.972, 45.802), area: 1, source: 'geojson' }]
        },
        ...overrides
    };
}

/** A plan of a park, a building and a parcel layout, each plan with its own key and ground file. */
function makePlan(overrides = {}) {
    planCounter += 1;
    const key = overrides.key || `test-plan-${planCounter}`;
    return {
        key, title: 'Test plan', author: 'Plan author', city: 'zagreb', parcelSourceId: null,
        groundFile: path.join(TMP, 'ground', `${key}.json`),
        designs: [{ key: 'park', record: parkRecord() }, { key: 'building', record: buildingRecord() }, { key: 'layout', record: layoutRecord() }],
        ...overrides
    };
}

const bindingOf = (parcelIds, coverage = 'complete') => ({ parcels: parcelIds.map(parcelId => ({ parcelId, overlapM2: 10, intrusionM: 2 })), coverage, touched: [], toleranceM: 0 });
// What the fake cadastre binds, by design title: the park takes A, the building B, the layout B and C.
const BINDINGS = { 'Park on the corner': ['A'], 'Block on plot 2': ['B'], 'New plots': ['B', 'C'] };

/** The ground file --capture would write over `objects`, taking A, B and C. */
function groundOver(plan, objects, overrides = {}) {
    const layout = objects.find(object => object.layout);
    return {
        comment: 'test ground', plan: plan.key, designCids: objects.map(object => object.cid),
        inputs: [{ parcelId: 'A', areaM2: 100 }, { parcelId: 'B', areaM2: 50 }, { parcelId: 'C', areaM2: 25 }],
        openGroundM2: 0,
        outputs: [
            { hash: piece('a'), areaM2: 100, fromParcelIds: ['A'], role: 'parcel', producedBy: null },
            { hash: piece('b'), areaM2: 40, fromParcelIds: ['B', 'C'], role: 'plot', producedBy: layout.cid },
            { hash: piece('c'), areaM2: 35, fromParcelIds: ['B', 'C'], role: 'plot', producedBy: layout.cid }
        ],
        ...overrides
    };
}
const writeGround = (plan, ground) => {
    fs.mkdirSync(path.dirname(plan.groundFile), { recursive: true });
    fs.writeFileSync(plan.groundFile, JSON.stringify(ground));
};

/**
 * A fake index (courier and index routes) as a fetch: it checks every pinned CID against its bytes and
 * answers the reads the steps make. `failIndexOf` answers POST /designs of that title with 422.
 */
function fakeIndex({ held = [], failIndexOf = null, bindings = BINDINGS } = {}) {
    const calls = [];
    const designs = new Map(held.map(row => [row.cid, row]));
    const agreements = new Map();
    const pins = [];
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    async function fetchImpl(input, init = {}) {
        const url = new URL(String(input));
        const method = String(init.method || 'GET').toUpperCase();
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        calls.push({ method, path: url.pathname, body, origin: init.headers?.origin ?? null });
        if (method === 'POST' && url.pathname === '/pins') {
            const bytes = Buffer.from(body.bytes, 'base64');
            if (cidOf(bytes) !== body.cid) return json(409, { code: 'cid-mismatch', error: 'not these bytes' });
            pins.push({ kind: body.kind, cid: body.cid, content: JSON.parse(bytes.toString('utf8')) });
            return json(201, { cid: body.cid, pinnedAt: '2026-10-22T08:00:00.000Z' });
        }
        if (method === 'POST' && url.pathname === '/designs/batch') {
            const items = body.cids.map(cid => ({ cid, design: designs.get(cid) || null }));
            return json(200, { items, count: items.filter(item => item.design).length });
        }
        if (method === 'POST' && url.pathname === '/designs/binding') {
            const title = [...designsByTitle.keys()].find(name => designsByTitle.get(name) === JSON.stringify(body.site));
            return json(200, { city: body.city ?? null, parcelSourceId: body.parcelSourceId ?? null, binding: bindingOf(bindings[title] || []) });
        }
        if (method === 'POST' && url.pathname === '/designs') {
            if (failIndexOf && body.content.title === failIndexOf) return json(422, { code: 'invalid-design', error: 'refused for the test' });
            if (designs.has(body.cid)) return json(409, designs.get(body.cid));
            const row = { cid: body.cid, city: body.content.city, goal: body.content.goal, title: body.content.title, binding: bindingOf(bindings[body.content.title] || []), content: body.content, createdAt: '2026-10-22T08:01:00.000Z' };
            designs.set(body.cid, row);
            return json(201, row);
        }
        const agreementMatch = url.pathname.match(/^\/agreements\/([a-z2-7]+)$/);
        if (method === 'GET' && agreementMatch) {
            const row = agreements.get(agreementMatch[1]);
            return row ? json(200, row) : json(404, { code: 'not-found', error: 'no such agreement' });
        }
        if (method === 'POST' && url.pathname === '/agreements') {
            if (agreements.has(body.cid)) return json(409, agreements.get(body.cid));
            const row = { cid: body.cid, content: body.content, carried: (body.designs || []).map(design => design.cid), createdAt: '2026-10-22T08:02:00.000Z' };
            agreements.set(body.cid, row);
            (body.designs || []).forEach(design => designs.set(design.cid, { cid: design.cid, binding: bindingOf(bindings[design.content.title] || []), content: design.content }));
            return json(201, row);
        }
        return json(404, { code: 'unexpected', error: `${method} ${url.pathname}` });
    }
    // The layout's binding is asked by its site: remember which title each site belongs to.
    const designsByTitle = new Map([['New plots', JSON.stringify(SITE)]]);
    return { fetchImpl, calls, designs, agreements, pins, writes: () => calls.filter(call => call.method === 'POST' && call.path !== '/designs/batch' && call.path !== '/designs/binding') };
}

/** A design row as the index answers it, for a design object of the plan. */
const rowOf = object => ({ cid: object.cid, city: object.content.city, goal: object.content.goal, title: object.content.title, binding: bindingOf(BINDINGS[object.content.title] || []), content: object.content, createdAt: '2026-10-20T00:00:00.000Z' });

/** One command line of a restatement script, in-process: its output, error output and exit code. */
async function cli(argv, { plans, index = null, options } = {}) {
    const out = [];
    const err = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { err.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noNetwork = vi.fn(async () => { throw new Error('this step must not use the network'); });
    vi.stubGlobal('fetch', index ? index.fetchImpl : noNetwork);
    let planCalls = 0;
    process.exitCode = undefined;
    try {
        await lib.runRestatementCli({
            script: 'test/restatement-script.mjs', describe: 'a test plan', planKeys: plans.map(plan => plan.key),
            plans: async () => { planCalls += 1; return plans; }, options, argv
        });
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = undefined;
    return { out: out.join('\n'), err: err.join('\n'), exitCode, planCalls, networkCalls: noNetwork.mock.calls.length };
}

const statePathOf = (api, plan) => path.join(lib.STATE_ROOT, new URL(api).host.replace(/[^a-z0-9.]+/g, '-'), `${plan.key.replace(/[^a-z0-9.]+/g, '-')}.json`);
const readState = (api, plan) => JSON.parse(fs.readFileSync(statePathOf(api, plan), 'utf8'));

// ---- the objects ---------------------------------------------------------------------------------------

describe('planObjects', () => {
    it('builds the design/v1 object of every design in plan order, marking the parcel layout', () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        expect(objects.map(object => object.key)).toEqual(['park', 'building', 'layout']);
        expect(objects.map(object => object.layout)).toEqual([false, false, true]);
        objects.forEach((object, index) => {
            expect(object.content.schema).toBe('design/v1');
            expect(object.content.authoredAt).toBe(AT);
            expect(object.cid).toBe(cidOf(canonicalBytes(object.content)));
            expect(object.cid).toBe(designObject(lib.canonicalDesignRecord(plan.designs[index].record, 'x')).cid);
            expect(object.bytes).toBe(canonicalBytes(object.content).length);
        });
        // The same plan gives the same CIDs every time: a rerun publishes nothing new.
        expect(lib.planObjects(makePlan()).map(object => object.cid)).toEqual(objects.map(object => object.cid));
    });

    it('refuses what the courier or the index would refuse later, naming the design', () => {
        expect(() => lib.planObjects(makePlan({ designs: [] }))).toThrow(/the plan has no designs/);
        const many = Array.from({ length: lib.MAX_AGREEMENT_DESIGNS + 1 }, (_, index) => ({ key: `b${index}`, record: buildingRecord({ title: `Block ${index}` }) }));
        expect(() => lib.planObjects(makePlan({ designs: many }))).toThrow(`201 designs, but an agreement links at most ${lib.MAX_AGREEMENT_DESIGNS}`);
        expect(() => lib.planObjects(makePlan({ key: 'cities', designs: [{ key: 'park', record: parkRecord({ city: 'split' }) }] })))
            .toThrow('cities/park: the design names city split, the plan zagreb');
        expect(() => lib.planObjects(makePlan({ key: 'twice', designs: [{ key: 'one', record: parkRecord() }, { key: 'two', record: parkRecord() }] })))
            .toThrow(/twice: designs one and two are the same object \(bafkrei/);
        expect(() => lib.planObjects(makePlan({ key: 'pool', designs: [{ key: 'layout', record: layoutRecord({ site: null, geometry: SITE }) }] })))
            .toThrow('pool/layout: a parcel layout is published with its site');
        const huge = buildingRecord({ description: 'x'.repeat(MAX_PINNED_OBJECT_BYTES) });
        expect(() => lib.planObjects(makePlan({ key: 'huge', designs: [{ key: 'big', record: huge }] }))).toThrow(`huge/big: fileRoot accepts at most ${MAX_PINNED_OBJECT_BYTES} bytes`);
    });

    it('needs a fixed source date on every design, never the time of publishing', () => {
        for (const createdAt of [undefined, null, '2026-06-23', 'yesterday', '2026-06-23T00:00:00Z']) {
            expect(() => lib.planObjects(makePlan({ key: 'dates', designs: [{ key: 'park', record: parkRecord({ createdAt }) }] })))
                .toThrow(/dates\/park: a restatement design needs a fixed source date as its createdAt/);
        }
    });
});

describe('canonicalDesignRecord', () => {
    const A = { lat: 45.8, lng: 15.97 };
    const B = { lat: 45.8004, lng: 15.9712 };
    const C = { lat: 45.8011, lng: 15.9716 };
    const strips = key => ({ strips: corridorProfile.CORRIDOR_PROFILE_PRESETS[key].map(lane => ({ ...lane })) });
    const roadRecord = () => ({
        goal: 'road-track', title: 'Street', description: null, author: 'Plan author', city: 'zagreb', createdAt: AT,
        geometry: box(15.9699, 45.7999, 15.9717, 45.8012),
        roadProposal: {
            isCorridor: true,
            definition: { points: [[A, B], [B, C]], segments: [[A, B], [B, C]], segmentIds: ['s1', 's2'], profile: strips(10), segmentProfiles: { s2: strips(10) }, polygon: box(15.9699, 45.7999, 15.9717, 45.8012) }
        }
    });

    it('publishes a road in the view the app reads back from its OSM record, so the CID survives a reload', () => {
        const raw = roadRecord();
        const before = structuredClone(raw);
        const canonical = lib.canonicalDesignRecord(raw, 'plan/street');
        expect(raw).toEqual(before);
        const expected = corridorOsmForm.toView(corridorOsmForm.toRecord(structuredClone(raw.roadProposal.definition)));
        expect(canonical.roadProposal.definition).toEqual(expected);
        expect(canonical.roadProposal.definition.width).toBe(10);
        // The raw spelling would hash differently from what the app holds after storing it.
        // The shared publication contract also canonicalizes road profiles.
        expect(designObject(canonical).cid).toBe(designObject(raw).cid);
        expect(designObject(lib.canonicalDesignRecord(canonical, 'again')).cid).toBe(designObject(canonical).cid);
        expect(lib.canonicalRoadDefinition(canonical.roadProposal.definition)).toEqual(canonical.roadProposal.definition);
    });

    it('drops apply-time state and empty building parameters, which the app never keeps', () => {
        const clean = buildingRecord();
        const noisy = buildingRecord({ status: 'applied', localEditAt: '2026-10-01T00:00:00.000Z', editSeq: 4 });
        noisy.buildingProposal.parameters.mode = null;
        noisy.buildingProposal.parameters.setback = undefined;
        const canonical = lib.canonicalDesignRecord(noisy, 'plan/building');
        expect(canonical.buildingProposal.parameters).toEqual({ height: 17.5, floors: 5, typology: 'single', rotation: 0 });
        expect(canonical).not.toHaveProperty('status');
        expect(canonical).not.toHaveProperty('editSeq');
        expect(designObject(canonical).cid).toBe(designObject(lib.canonicalDesignRecord(clean, 'plan/clean')).cid);
    });

    it('refuses a record that is not an object', () => {
        expect(() => lib.canonicalDesignRecord(null, 'plan/none')).toThrow('plan/none: a design record is an object');
        expect(() => lib.canonicalDesignRecord([], 'plan/list')).toThrow('plan/list: a design record is an object');
    });
});

describe('planAgreement', () => {
    it('is a community vote over the designs in plan order: no lens, sponsor, money, allocations or deadline', () => {
        const plan = makePlan({ parcelSourceId: 'hr-cadastre' });
        const objects = lib.planObjects(plan);
        const ground = groundOver(plan, objects);
        const { content, cid, bytes } = lib.planAgreement(plan, objects, ground);
        expect(content).toMatchObject({
            schema: 'agreement/v1', title: 'Test plan', author: 'Plan author', sponsor: null, city: 'zagreb', createdAt: null,
            allocations: [], money: { currency: 'EUR', lines: [] }, deadline: null,
            rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }
        });
        const verifiedPlan = planForDesigns(plan.title, objects);
        expect(content.planCid).toBe(verifiedPlan.cid);
        expect(verifiedPlan.content.designCids).toEqual(objects.map(object => object.cid).sort());
        // Owners are unknown to a restatement, so each parcel stands for its abstract owner party.
        expect(content.inputs.parcels).toEqual(ground.inputs.map(parcel => ({ parcelId: parcel.parcelId, parcelSourceId: 'hr-cadastre', areaM2: parcel.areaM2,
            holders: [{ ownerKey: `parcel-owner:${parcel.parcelId}`, displayName: `Owner(s) of parcel ${parcel.parcelId}`, share: 1 }] })));
        expect(content.outputs.map(output => [output.hash, output.producedBy])).toEqual(ground.outputs.map(output => [output.hash, output.producedBy]));
        expect(cid).toBe(cidOf(canonicalBytes(content)));
        expect(bytes).toBe(canonicalBytes(content).length);
        // Without a parcel source the inputs name none; the agreement is another object.
        const plain = lib.planAgreement({ ...plan, parcelSourceId: null }, objects, ground);
        expect(plain.content.inputs.parcels[0]).not.toHaveProperty('parcelSourceId');
        expect(plain.cid).not.toBe(cid);
    });

    it('refuses an output produced by a design outside the plan', () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const stranger = designObject(lib.canonicalDesignRecord(parkRecord({ title: 'Elsewhere' }), 'x')).cid;
        const ground = groundOver(plan, objects);
        ground.outputs[1].producedBy = stranger;
        expect(() => lib.planAgreement(plan, objects, ground)).toThrow(/produced by .* a design the agreement does not link/);
    });
});

// ---- the page job of --capture ------------------------------------------------------------------------

describe('capturePageScript (the job --capture runs in the app)', () => {
    const P = 'bafkreiaaaa', L = 'bafkreillll';
    const layoutRow = { cid: L, city: 'zagreb', goal: 'parcel-layout', title: 'New plots', binding: bindingOf(['B', 'C']), content: { goal: 'parcel-layout' } };

    // The app as the page job sees it: everything it needs on window, the index behind window.fetch.
    function fakeApp({ applied = () => true, producedBy = 'local-layout', here = cid => cid } = {}) {
        const forwarded = [];
        const seenByApp = [];
        const records = new Map([['local-park', { id: 'local-park', cid: P }], ['local-layout', { id: 'local-layout', cid: L }]]);
        const window = {
            map: {}, DesignSync: {}, PersistentStorage: {}, agentStorage: {},
            fetch: async (input, init) => {
                forwarded.push({ url: String(input), init });
                const asked = init && typeof init.body === 'string' ? JSON.parse(init.body).cids : [];
                return new Response(JSON.stringify({ items: asked.map(cid => ({ cid, design: { cid, title: 'from the index' } })) }), { status: 200 });
            },
            handleSharedDesignRoute: async (cids, options) => {
                // The import reads the designs through the batch route, as design-sync.js does.
                const response = await window.fetch(`${API}/designs/batch`, { method: 'POST', body: JSON.stringify({ cids }) });
                seenByApp.push({ options, body: await response.json() });
                await window.fetch(`${API}/designs/batch`, { method: 'POST', body: JSON.stringify({ cids: [P] }) });
                await window.fetch(`${API}/designs/${P}`);
                return { blocked: false, failed: [], localIds: new Map([[P, 'local-park'], [L, 'local-layout']]) };
            },
            proposalStorage: { getProposal: id => records.get(id) || null },
            isApplied: record => applied(record),
            DesignRecord: { cidOf: record => here(record.cid) },
            LiveParcelFabric: { featureId: feature => feature.id },
            CadastralParcelRepository: { ensureIds: async ids => ({ features: ids.map(id => ({ id })) }) },
            AgreementDialog: { inputParcelIds: () => ['A', 'B', 'C'], originalsById: features => new Map(features.map(feature => [feature.id, feature])) },
            AgreementGround: {
                localHolders: () => () => [],
                derive: ({ designs, originals, area }) => ({
                    inputs: { parcels: [...originals.keys()].map(parcelId => ({ parcelId, areaM2: area({}), holders: [{ ownerKey: 'local-owner' }] })), openGroundM2: 0 },
                    outputs: [
                        { hash: piece('a'), areaM2: 100, fromParcelIds: ['A'], role: 'parcel', producedBy: null, geometry: {} },
                        { hash: piece('b'), areaM2: 75, fromParcelIds: ['B', 'C'], role: 'plot', producedBy, geometry: {} }
                    ],
                    designsSeen: designs.length
                })
            },
            turf: { area: () => 42 }
        };
        return { window, forwarded, seenByApp };
    }

    async function runJob(app, config) {
        const context = vm.createContext({ window: app.window, location: { href: `${APP}/` }, URL, Response, console: { log() {} }, setTimeout });
        expect(vm.runInContext(lib.capturePageScript(config), context)).toBe('started');
        await vi.waitFor(() => expect(app.window.__restatementCapture.state).not.toBe('running'), { timeout: 5000 });
        return app.window.__restatementCapture;
    }

    it('applies the designs as a link does, serves the layouts the index lacks, and maps producers to CIDs', async () => {
        const app = fakeApp();
        const job = await runJob(app, { cids: [P, L], layoutRows: [layoutRow], readyMs: 1000 });
        expect(job.state).toBe('done');
        expect(job.error).toBeNull();
        expect(job.result).toEqual({
            designs: [{ cid: P, here: P }, { cid: L, here: L }],
            inputs: [{ parcelId: 'A', areaM2: 42 }, { parcelId: 'B', areaM2: 42 }, { parcelId: 'C', areaM2: 42 }],
            openGroundM2: 0,
            outputs: [
                { hash: piece('a'), areaM2: 100, fromParcelIds: ['A'], role: 'parcel', producedBy: null },
                { hash: piece('b'), areaM2: 75, fromParcelIds: ['B', 'C'], role: 'plot', producedBy: L }
            ]
        });
        // The batch read asked the index only for what it holds and got the layout from the page job.
        const [first] = app.seenByApp;
        expect(first.options).toEqual({ openDetails: false, enter3D: false, summary: false, frame: false });
        expect(first.body).toEqual({ items: [{ cid: P, design: { cid: P, title: 'from the index' } }, { cid: L, design: layoutRow }], count: 2 });
        expect(JSON.parse(app.forwarded[0].init.body)).toEqual({ cids: [P] });
        // A read without a layout, and any other request, reach the index untouched.
        expect(JSON.parse(app.forwarded[1].init.body)).toEqual({ cids: [P] });
        expect(app.forwarded[2].url).toBe(`${API}/designs/${P}`);
        expect(app.window.shouldSkipWelcomeForProposalLink()).toBe(true);
        expect(job.log.at(-1)).toMatch(/derived 3 input parcels and 2 outputs/);
    });

    it('reports the CID each design has in the app, so a changed import is caught', async () => {
        const job = await runJob(fakeApp({ here: cid => (cid === L ? 'bafkreichanged' : cid) }), { cids: [P, L], layoutRows: [layoutRow], readyMs: 1000 });
        expect(job.result.designs).toEqual([{ cid: P, here: P }, { cid: L, here: 'bafkreichanged' }]);
    });

    it('fails on a design that is not applied, or a piece produced outside the plan', async () => {
        const unapplied = await runJob(fakeApp({ applied: record => record.id !== 'local-layout' }), { cids: [P, L], layoutRows: [layoutRow], readyMs: 1000 });
        expect(unapplied.state).toBe('failed');
        expect(unapplied.error).toContain(`design ${L} is not applied`);
        expect(unapplied.result).toBeNull();
        const stray = await runJob(fakeApp({ producedBy: 'local-elsewhere' }), { cids: [P, L], layoutRows: [layoutRow], readyMs: 1000 });
        expect(stray.state).toBe('failed');
        expect(stray.error).toContain('is produced by local-elsewhere, which is not a design of this plan');
    });
});

// ---- the command line -----------------------------------------------------------------------------------

describe('runRestatementCli: options', () => {
    it('prints usage without a step, and never builds the plans', async () => {
        const plan = makePlan();
        for (const argv of [[], ['--help'], ['--apply', '--api', API]]) {
            const run = await cli(argv, { plans: [plan] });
            expect(run.exitCode).toBe(0);
            expect(run.planCalls).toBe(0);
            expect(run.out).toContain('Usage: node test/restatement-script.mjs <step…> [options]');
            expect(run.out).toContain(`Plans: ${plan.key}`);
            expect(run.out).toContain('Checkpoints: ~/.config/ugt/restatements/<api host>/<plan key>.json');
        }
    });

    it('lists the script\'s own options and refuses unknown ones', async () => {
        const plan = makePlan();
        const options = { source: { type: 'string', description: 'The source model.' } };
        expect((await cli(['--help'], { plans: [plan], options })).out).toMatch(/Options of this script:\n {2}--source <value> +The source model\./);
        const run = await cli(['--dry-run', '--bogus'], { plans: [plan] });
        expect(run.exitCode).toBe(1);
        expect(run.err).toContain("Unknown option '--bogus'");
        expect(run.planCalls).toBe(0);
    });

    it('refuses an incomplete command before any network call', async () => {
        const plan = makePlan();
        const cases = [
            [['--designs', '--apply'], '--api <url> is required for --designs --apply, --capture and --agreement --apply'],
            [['--agreement', '--apply'], '--api <url> is required'],
            [['--capture', '--api', API], '--capture needs --app <app url>'],
            [['--designs', '--apply', '--api', 'https://api.example.test'], '--apply to an API that is not on localhost needs --origin <app origin>'],
            [['--dry-run', '--only', `${plan.key},nope`], `unknown plan key(s): nope (plans: ${plan.key})`],
            [['--designs', '--api', 'not a url'], 'the API base must be an http(s) URL']
        ];
        for (const [argv, message] of cases) {
            const run = await cli(argv, { plans: [plan] });
            expect(run.exitCode, argv.join(' ')).toBe(1);
            expect(run.err, argv.join(' ')).toContain(message);
            expect(run.networkCalls).toBe(0);
        }
    });

    it('runs only the plans --only names', async () => {
        const first = makePlan();
        const second = makePlan();
        const run = await cli(['--dry-run', '--only', second.key], { plans: [first, second] });
        expect(run.exitCode).toBe(0);
        expect(run.out).toContain(`plan 1/1 ${second.key} "Test plan": 3 designs (1 parcel layout(s))`);
        expect(run.out).not.toContain(`${first.key} 1/3`);
        expect(run.out).toContain('done: dry-run for 1 plan(s)');
    });
});

describe('--dry-run', () => {
    it('prints every design object and says the ground file is missing, without the network', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const run = await cli(['--dry-run'], { plans: [plan] });
        expect(run.exitCode).toBe(0);
        expect(run.networkCalls).toBe(0);
        objects.forEach((object, index) => {
            expect(run.out).toContain(`${plan.key} ${index + 1}/3 ${object.content.goal} ${object.cid} "${object.content.title}" (${object.bytes} bytes)`);
        });
        expect(run.out).toContain('[parcel layout: published with the agreement]');
        expect(run.out).toContain(`${plan.key}: no ground file yet`);
        expect(run.out).toContain('run --capture for its agreement');
    });

    it('prints the agreement and its link once the ground file is current, and says when it is stale', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const ground = groundOver(plan, objects);
        writeGround(plan, ground);
        const agreement = lib.planAgreement(plan, objects, ground);
        const run = await cli(['--dry-run', '--app', APP], { plans: [plan] });
        expect(run.out).toContain(`${plan.key}: agreement ${agreement.cid} "Test plan" over 3 designs, 3 input parcels, 3 outputs (${agreement.bytes} bytes)`);
        expect(run.out).toContain(`${plan.key}: link ${APP}/agreements/${agreement.cid}?city=zagreb`);
        writeGround(plan, { ...ground, designCids: [...ground.designCids].reverse() });
        const stale = await cli(['--dry-run'], { plans: [plan] });
        expect(stale.out).toContain(`${plan.key}: the ground file was captured over other designs`);
        expect(stale.out).not.toContain(agreement.cid);
    });
});

describe('--designs', () => {
    it('without --apply says what it would publish and touches nothing', async () => {
        const plan = makePlan();
        const run = await cli(['--designs'], { plans: [plan] });
        expect(run.exitCode).toBe(0);
        expect(run.networkCalls).toBe(0);
        expect(run.out).toMatch(/1\/3 park bafkrei\S+ "Park on the corner": would pin and index/);
        expect(run.out).toMatch(/3\/3 parcel-layout bafkrei\S+ "New plots": would pin and ask its binding/);
        expect(run.out).toContain(`${plan.key}: DRY RUN: nothing pinned or indexed (add --apply)`);
        expect(fs.existsSync(statePathOf(API, plan))).toBe(false);
    });

    it('pins and indexes each design, pins the layout and asks its binding, and checkpoints every step', async () => {
        const plan = makePlan({ parcelSourceId: 'hr-cadastre' });
        const objects = lib.planObjects(plan);
        const index = fakeIndex();
        const run = await cli(['--designs', '--apply', '--api', API, '--origin', 'http://localhost:4998'], { plans: [plan], index });
        expect(run.err).toBe('');
        expect(run.exitCode).toBe(0);
        // Exactly the canonical bytes of each design were pinned, the layout included.
        expect(index.pins.map(pin => pin.cid)).toEqual(objects.map(object => object.cid));
        index.pins.forEach((pin, i) => expect(pin.content).toEqual(objects[i].content));
        const indexed = index.calls.filter(call => call.method === 'POST' && call.path === '/designs');
        expect(indexed.map(call => call.body.cid)).toEqual([objects[0].cid, objects[1].cid]);
        expect(indexed.every(call => call.body.parcelSourceId === 'hr-cadastre')).toBe(true);
        const asked = index.calls.find(call => call.path === '/designs/binding');
        expect(asked.body).toEqual({ site: objects[2].content.site, city: 'zagreb', parcelSourceId: 'hr-cadastre' });
        expect(index.writes().every(call => call.origin === 'http://localhost:4998')).toBe(true);
        expect(run.out).toMatch(/3\/3 parcel-layout \S+ "New plots": pinned; binds 2 parcels \(coverage complete\); indexed with the agreement/);

        const state = readState(API, plan);
        expect(state).toMatchObject({ api: API, plan: plan.key });
        expect(state.designs[objects[0].cid]).toMatchObject({ pinned: true, indexed: true, binding: bindingOf(['A']) });
        expect(state.designs[objects[1].cid]).toMatchObject({ pinned: true, indexed: true, binding: bindingOf(['B']) });
        expect(state.designs[objects[2].cid]).toMatchObject({ layout: true, pinned: true, binding: bindingOf(['B', 'C']) });
        expect(state.designs[objects[2].cid]).not.toHaveProperty('indexed');

        // A rerun publishes nothing new: the index holds the designs and the checkpoint the layout.
        const again = await cli(['--designs', '--apply', '--api', API], { plans: [plan], index });
        expect(again.exitCode).toBe(0);
        expect(index.pins).toHaveLength(3);
        expect(index.calls.filter(call => call.path === '/designs/binding')).toHaveLength(1);
        expect(again.out).toMatch(/1\/3 park \S+ "Park on the corner": already indexed \(1 parcels\)/);
        // And the dry run now reads the checkpoint.
        const dry = await cli(['--designs', '--api', API], { plans: [plan] });
        expect(dry.out.match(/done \(checkpoint\)/g)).toHaveLength(3);
    });

    it('resumes after a refused write without pinning anything twice', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const refusing = fakeIndex({ failIndexOf: 'Block on plot 2' });
        const failed = await cli(['--designs', '--apply', '--api', API], { plans: [plan], index: refusing });
        expect(failed.exitCode).toBe(1);
        expect(failed.err).toMatch(/index design bafkrei\S+ refused \(422 invalid-design\): refused for the test/);
        expect(refusing.pins.map(pin => pin.cid)).toEqual([objects[0].cid, objects[1].cid]);
        const state = readState(API, plan);
        expect(state.designs[objects[0].cid]).toMatchObject({ pinned: true, indexed: true });
        expect(state.designs[objects[1].cid]).toMatchObject({ pinned: true });
        expect(state.designs[objects[1].cid]).not.toHaveProperty('indexed');
        expect(state.designs[objects[2].cid]).toBeUndefined();

        // The same index, healthy now: the park is held, the building is pinned already.
        const healthy = fakeIndex({ held: [...refusing.designs.values()] });
        const resumed = await cli(['--designs', '--apply', '--api', API], { plans: [plan], index: healthy });
        expect(resumed.exitCode).toBe(0);
        expect(healthy.pins.map(pin => pin.cid)).toEqual([objects[2].cid]);
        expect(healthy.calls.filter(call => call.method === 'POST' && call.path === '/designs').map(call => call.body.cid)).toEqual([objects[1].cid]);
        expect(readState(API, plan).designs[objects[1].cid]).toMatchObject({ pinned: true, indexed: true });
    });

    it('takes what another run already indexed from the index, pinning nothing', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const index = fakeIndex({ held: objects.map(rowOf) });
        const run = await cli(['--designs', '--apply', '--api', API], { plans: [plan], index });
        expect(run.exitCode).toBe(0);
        expect(index.writes()).toEqual([]);
        const state = readState(API, plan);
        objects.forEach(object => expect(state.designs[object.cid]).toMatchObject({ indexed: true, binding: bindingOf(BINDINGS[object.content.title]) }));
    });
});

describe('--capture', () => {
    // agent-browser, as far as --capture uses it: every call is logged, eval --stdin keeps the page
    // job, and the job's state and result are read from a JSON file the test writes.
    const bin = path.join(TMP, 'bin');
    const files = { log: path.join(TMP, 'agent-browser.log'), script: path.join(TMP, 'page-job.js'), state: path.join(TMP, 'page-state.json') };
    beforeAll(() => {
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'fake-agent-browser.mjs'), `// Test double of agent-browser for restatement-publish.test.js.
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AB_LOG, JSON.stringify(args) + '\\n');
const [, , command, ...rest] = args;
if (['open', 'wait', 'close'].includes(command)) process.exit(0);
if (command === 'eval' && rest[0] === '--stdin') {
    fs.writeFileSync(process.env.FAKE_AB_SCRIPT, fs.readFileSync(0, 'utf8'));
    console.log(JSON.stringify('started'));
    process.exit(0);
}
const job = JSON.parse(fs.readFileSync(process.env.FAKE_AB_STATE, 'utf8'));
if (command === 'eval' && rest[0].startsWith('window.__restatementCapture ?')) console.log(JSON.stringify({ state: job.state, log: job.log }));
else if (command === 'eval' && rest[0] === 'window.__restatementCapture.error') console.log(JSON.stringify(job.error));
else if (command === 'eval' && rest[0] === 'window.__restatementCapture.result') console.log(JSON.stringify(job.result));
else { console.error('unexpected ' + JSON.stringify(args)); process.exit(2); }
`);
        fs.writeFileSync(path.join(bin, 'agent-browser'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-agent-browser.mjs')}" "$@"\n`, { mode: 0o755 });
    });

    function withBrowser(job) {
        fs.writeFileSync(files.state, JSON.stringify(job));
        fs.rmSync(files.log, { force: true });
        fs.rmSync(files.script, { force: true });
        vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
        vi.stubEnv('FAKE_AB_LOG', files.log);
        vi.stubEnv('FAKE_AB_SCRIPT', files.script);
        vi.stubEnv('FAKE_AB_STATE', files.state);
    }
    const browserCalls = () => fs.readFileSync(files.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    afterEach(() => vi.unstubAllEnvs());

    // What the app answers for the plan: its designs unchanged, A, B and C taken.
    const resultFor = (objects, overrides = {}) => {
        const layout = objects.find(object => object.layout);
        return {
            designs: objects.map(object => ({ cid: object.cid, here: object.cid })),
            inputs: [{ parcelId: 'A', areaM2: 100 }, { parcelId: 'B', areaM2: 50 }, { parcelId: 'C', areaM2: 25 }],
            openGroundM2: 0,
            outputs: [
                { hash: piece('a'), areaM2: 100, fromParcelIds: ['A'], role: 'parcel', producedBy: null },
                { hash: piece('b'), areaM2: 75, fromParcelIds: ['B', 'C'], role: 'plot', producedBy: layout.cid }
            ],
            ...overrides
        };
    };

    it('refuses before opening the app while the index lacks a design', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        withBrowser({ state: 'done', log: [], result: resultFor(objects) });
        const run = await cli(['--capture', '--app', APP, '--api', API], { plans: [plan], index: fakeIndex({ held: [rowOf(objects[0])] }) });
        expect(run.exitCode).toBe(1);
        expect(run.err).toContain(`${plan.key}: the index at ${API} does not hold 1 design(s) (building): run --designs --apply first`);
        expect(fs.existsSync(files.log)).toBe(false);
        expect(fs.existsSync(plan.groundFile)).toBe(false);
    }, 60_000);

    it('writes the land the app derives to the ground file, over exactly these designs, and closes its session', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const result = resultFor(objects);
        withBrowser({ state: 'done', log: ['[t] applying 3 design(s)'], result });
        const index = fakeIndex({ held: [rowOf(objects[0]), rowOf(objects[1])] });
        const run = await cli(['--capture', '--app', APP, '--api', API], { plans: [plan], index });
        expect(run.err).toBe('');
        expect(run.exitCode).toBe(0);
        const ground = JSON.parse(fs.readFileSync(plan.groundFile, 'utf8'));
        expect(ground).toMatchObject({ plan: plan.key, designCids: objects.map(object => object.cid), inputs: result.inputs, openGroundM2: 0, outputs: result.outputs });
        expect(ground.comment).toContain('Generated by test/restatement-script.mjs --capture');
        expect(run.out).toContain(`agreement ${lib.planAgreement(plan, objects, ground).cid}`);
        expect(run.out).toContain(`${plan.key}: app [t] applying 3 design(s)`);

        const calls = browserCalls();
        const session = calls[0][1];
        expect(calls.every(call => call[0] === '--session' && call[1] === session)).toBe(true);
        expect(calls[0].slice(2)).toEqual(['open', `${APP}/?city=zagreb&reduceMotion=1&backend=${encodeURIComponent(API)}`]);
        expect(calls.at(-1).slice(2)).toEqual(['close']);
        // The page job got the CIDs in plan order and the row the index will hold for the layout.
        const page = fs.readFileSync(files.script, 'utf8');
        const config = JSON.parse(page.match(/const config = (.*);\n/)[1]);
        expect(config.cids).toEqual(objects.map(object => object.cid));
        expect(config.layoutRows).toEqual([expect.objectContaining({ cid: objects[2].cid, binding: bindingOf(['B', 'C']), content: objects[2].content })]);
        expect(readState(API, plan).designs[objects[2].cid].binding).toEqual(bindingOf(['B', 'C']));
    }, 60_000);

    it('refuses land the app holds differently or the index would refuse, writing no ground file', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const index = fakeIndex({ held: [rowOf(objects[0]), rowOf(objects[1])] });
        const cases = [
            [resultFor(objects, { designs: objects.map((object, i) => ({ cid: object.cid, here: i === 1 ? 'bafkreichanged' : object.cid })) }),
                `holds 1 design(s) differently from their published object, so an agreement over them would read as changed: ${objects[1].cid} → bafkreichanged`],
            [resultFor(objects, { inputs: [{ parcelId: 'A', areaM2: 100 }, { parcelId: 'B', areaM2: 50 }] }), 'bound on the server but not derived: C'],
            [resultFor(objects, { inputs: [...resultFor(objects).inputs, { parcelId: 'D', areaM2: 1 }] }), 'derived but bound by no design: D'],
            [resultFor(objects, { inputs: [], openGroundM2: 0 }), 'the designs take no land in the app'],
            [resultFor(objects, { outputs: [{ hash: piece('d'), areaM2: 1, fromParcelIds: ['A'], role: 'plot', producedBy: 'bafkreistranger' }] }), '1 output(s) name a producer outside the plan']
        ];
        for (const [result, message] of cases) {
            withBrowser({ state: 'done', log: [], result });
            const run = await cli(['--capture', '--app', APP, '--api', API], { plans: [plan], index });
            expect(run.exitCode, message).toBe(1);
            expect(run.err, message).toContain(message);
            expect(fs.existsSync(plan.groundFile), message).toBe(false);
            expect(browserCalls().at(-1).slice(2)).toEqual(['close']);
        }
        withBrowser({ state: 'failed', log: ['[t] failed: no parcels'], error: 'Error: the app did not load map', result: null });
        const failed = await cli(['--capture', '--app', APP, '--api', API], { plans: [plan], index });
        expect(failed.exitCode).toBe(1);
        expect(failed.err).toContain('the app could not derive the land: Error: the app did not load map');
        expect(browserCalls().at(-1).slice(2)).toEqual(['close']);
    }, 120_000);
});

describe('--agreement', () => {
    it('refuses without a current ground file', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const missing = await cli(['--agreement'], { plans: [plan] });
        expect(missing.exitCode).toBe(1);
        expect(missing.err).toContain(`${plan.key}: no ground file`);
        expect(missing.err).toContain('run --capture first');
        writeGround(plan, groundOver(plan, objects, { designCids: objects.map(object => object.cid).slice(0, 2) }));
        const stale = await cli(['--agreement'], { plans: [plan] });
        expect(stale.exitCode).toBe(1);
        expect(stale.err).toContain('the ground file was captured over other designs than the plan\'s current ones: recapture (--capture)');
    });

    it('without --apply prints the agreement and publishes nothing', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const ground = groundOver(plan, objects);
        writeGround(plan, ground);
        const run = await cli(['--agreement', '--app', APP], { plans: [plan] });
        expect(run.exitCode).toBe(0);
        expect(run.networkCalls).toBe(0);
        expect(run.out).toContain(`agreement ${lib.planAgreement(plan, objects, ground).cid} "Test plan": 3 designs (1 parcel layout(s)), 3 input parcels, 3 outputs`);
        expect(run.out).toContain('DRY RUN: the agreement is not pinned or indexed');
    });

    it('pins the agreement and indexes it with the layout it carries, once', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        const ground = groundOver(plan, objects);
        writeGround(plan, ground);
        const agreement = lib.planAgreement(plan, objects, ground);
        const index = fakeIndex({ held: [rowOf(objects[0]), rowOf(objects[1])] });
        const run = await cli(['--agreement', '--api', API, '--app', APP, '--apply'], { plans: [plan], index });
        expect(run.err).toBe('');
        expect(run.exitCode).toBe(0);
        // The layout and named plan are pinned before the agreement that carries them.
        expect(index.pins.map(pin => [pin.kind, pin.cid])).toEqual([['design', objects[2].cid], ['plan', agreement.plan.cid], ['agreement', agreement.cid]]);
        expect(index.pins[1].content).toEqual(agreement.plan.content);
        expect(index.pins[2].content).toEqual(agreement.content);
        const posted = index.calls.find(call => call.method === 'POST' && call.path === '/agreements');
        expect(posted.body).toEqual({ cid: agreement.cid, content: agreement.content, plan: agreement.plan, designs: [{ cid: objects[2].cid, content: objects[2].content }] });
        expect(run.out).toContain(`${plan.key}: agreement ${agreement.cid} indexed with 1 parcel layout(s) carried · ${APP}/agreements/${agreement.cid}?city=zagreb`);
        const state = readState(API, plan);
        expect(state.agreements[agreement.cid]).toEqual({ indexedAt: '2026-10-22T08:02:00.000Z' });
        expect(state.designs[objects[2].cid]).toMatchObject({ pinned: true, indexed: true });

        // Asked again, the index answers the agreement it holds: nothing is written.
        const writes = index.writes().length;
        const again = await cli(['--agreement', '--api', API, '--apply'], { plans: [plan], index });
        expect(again.exitCode).toBe(0);
        expect(again.out).toContain(`agreement ${agreement.cid} is already indexed`);
        expect(index.writes()).toHaveLength(writes);
    });

    it('refuses inputs that are not exactly what the designs bind, before writing anything', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        // The land still balances (151 m² in and out), so only the binding check can refuse it.
        const ground = groundOver(plan, objects, { inputs: [{ parcelId: 'A', areaM2: 100 }, { parcelId: 'B', areaM2: 50 }, { parcelId: 'Z', areaM2: 1 }] });
        ground.outputs[2].areaM2 = 11;
        writeGround(plan, ground);
        const index = fakeIndex({ held: [rowOf(objects[0]), rowOf(objects[1])] });
        const run = await cli(['--agreement', '--api', API, '--apply'], { plans: [plan], index });
        expect(run.exitCode).toBe(1);
        expect(run.err).toContain('the index would refuse the agreement\'s inputs: they must be exactly the parcels its designs bind on the server; bound but not inputs: C; inputs no design binds: Z');
        expect(index.writes()).toEqual([]);
    });

    it('does not judge extra inputs where a design\'s coverage is unknown', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        // The land still balances (176 m² in and out).
        const ground = groundOver(plan, objects, { inputs: [{ parcelId: 'A', areaM2: 100 }, { parcelId: 'B', areaM2: 50 }, { parcelId: 'C', areaM2: 25 }, { parcelId: 'Z', areaM2: 1 }] });
        ground.outputs[2].areaM2 = 36;
        writeGround(plan, ground);
        const unknown = { ...rowOf(objects[0]), binding: bindingOf(['A'], 'unknown') };
        const index = fakeIndex({ held: [unknown, rowOf(objects[1])] });
        const run = await cli(['--agreement', '--api', API, '--apply'], { plans: [plan], index });
        expect(run.err).toBe('');
        expect(run.exitCode).toBe(0);
        expect(index.calls.filter(call => call.method === 'POST' && call.path === '/agreements')).toHaveLength(1);
    });

    it('refuses while a linked design is not indexed', async () => {
        const plan = makePlan();
        const objects = lib.planObjects(plan);
        writeGround(plan, groundOver(plan, objects));
        const index = fakeIndex({ held: [rowOf(objects[0])] });
        const run = await cli(['--agreement', '--api', API, '--apply'], { plans: [plan], index });
        expect(run.exitCode).toBe(1);
        expect(run.err).toContain('the index does not hold 1 design(s) (building): run --designs --apply first');
        expect(index.writes()).toEqual([]);
    });
});
