// agents/publication-client.js over a fake fetch that answers as the index does: every CID is computed
// locally and an answer naming another is refused; indexing is repeatable (409 answers the row the index
// holds) and publication pins nothing (no POST /pins); the chain account is recorded once (201) and refreshed (200), and a mint the
// index cannot see yet is asked again after a pause; owner decisions are listed and relayed.
import { describe, expect, it } from 'vitest';
import { addressOf, cleanApiBase, createIndexClient, onchainNames } from '../agents/publication-client.js';
import { canonicalBytes, cidOf } from '../cid.js';

const API = 'https://index.test';
const ORIGIN = 'https://urbangametheory.xyz';
const design = { schema: 'design/v1', goal: 'park', title: 'Riverside park', site: null };
const layout = { schema: 'design/v1', goal: 'parcel-layout', title: 'Two plots', parcelLayout: { plots: [] } };
const agreement = { schema: 'agreement/v1', title: 'Riverside deal', designs: [{ cid: cidOf(canonicalBytes(design)) }] };
const planContent = { schema: 'plan/v1', title: 'Riverside plan', designCids: [cidOf(canonicalBytes(design))], view: { at: '45,15,17', mode: '2d' } };
const plan = { cid: cidOf(canonicalBytes(planContent)), content: planContent };
const ACCOUNT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

// The index as an in-memory emulator of the routes the client calls.
function fakeIndex({ onchainUnseen = 0, answerCid = null, refuseDesigns = null } = {}) {
    const designs = new Map();
    const agreements = new Map();
    const decisions = new Map();
    const calls = [];
    let unseen = onchainUnseen;
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const { pathname, searchParams } = new URL(url);
        const method = init.method || 'GET';
        const body = init.body === undefined ? undefined : JSON.parse(init.body);
        calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), headers: init.headers, body });
        let match;
        if (method === 'POST' && pathname === '/designs') {
            if (designs.has(body.cid)) return json(409, designs.get(body.cid));
            if (refuseDesigns) return json(refuseDesigns.status, refuseDesigns.body);
            if (answerCid) return json(201, { cid: answerCid });
            const row = { cid: body.cid, city: 'zagreb', binding: { parcels: [{ parcelId: 'HR-1' }], coverage: 'complete' }, content: body.content, parcelSourceId: body.parcelSourceId };
            designs.set(body.cid, row);
            return json(201, row);
        }
        if (method === 'POST' && pathname === '/designs/batch') {
            return json(200, { items: body.cids.map(cid => ({ cid, design: designs.get(cid) ?? null })) });
        }
        if (method === 'POST' && pathname === '/designs/binding') {
            return json(200, { city: body.city ?? 'zagreb', parcelSourceId: body.parcelSourceId ?? null, binding: { parcels: [{ parcelId: 'HR-1' }], toleranceM: body.toleranceM ?? 0 } });
        }
        if ((match = pathname.match(/^\/designs\/(\w+)$/)) && method === 'GET') {
            return designs.has(match[1]) ? json(200, designs.get(match[1])) : json(404, { code: 'design-not-found' });
        }
        if (method === 'POST' && pathname === '/agreements') {
            if (agreements.has(body.cid)) return json(409, agreements.get(body.cid));
            for (const linked of body.designs || []) designs.set(linked.cid, { cid: linked.cid, content: linked.content });
            const row = { cid: body.cid, content: body.content, status: 'active', onchain: null, linkedDesigns: (body.designs || []).length };
            agreements.set(body.cid, row);
            return json(201, row);
        }
        if ((match = pathname.match(/^\/agreements\/(\w+)\/onchain$/)) && method === 'POST') {
            const row = agreements.get(match[1]);
            if (!row) return json(404, { code: 'agreement-not-found' });
            if (unseen > 0) { unseen -= 1; return json(404, { code: 'onchain-account-missing', error: 'not seen yet' }); }
            if (row.onchain && row.onchain.account !== body.account) return json(409, { code: 'onchain-recorded-elsewhere', error: 'another account' });
            const first = !row.onchain;
            row.onchain = { chain: body.chain, cluster: body.cluster, account: body.account, signature: body.signature ?? row.onchain?.signature ?? null };
            return json(first ? 201 : 200, row);
        }
        if ((match = pathname.match(/^\/agreements\/(\w+)\/decisions$/))) {
            if (!agreements.has(match[1])) return json(404, { code: 'agreement_not_found' });
            const list = decisions.get(match[1]) ?? [];
            if (method === 'GET') return json(200, { agreementCid: match[1], decisions: list });
            if (body.receipt?.decision === 'bogus') return json(400, { code: 'invalid_receipt', error: 'not a receipt' });
            const duplicate = list.some(receipt => receipt.decisionProof.signature === body.receipt.decisionProof.signature);
            if (!duplicate) decisions.set(match[1], [...list, body.receipt]);
            return json(duplicate ? 200 : 201, { stored: true, duplicate });
        }
        if ((match = pathname.match(/^\/agreements\/(\w+)$/)) && method === 'GET') {
            return agreements.has(match[1]) ? json(200, agreements.get(match[1])) : json(404, { code: 'agreement-not-found' });
        }
        if (method === 'GET' && pathname === '/agreements') {
            return json(200, { agreements: [...agreements.values()], count: agreements.size });
        }
        return json(500, { error: `unexpected ${method} ${pathname}` });
    };
    return { fetchImpl, calls, designs, agreements, decisions };
}

const clientOver = (index, options = {}) => createIndexClient({ apiBase: `${API}/`, origin: ORIGIN, fetchImpl: index.fetchImpl, ...options });

describe('addresses', () => {
    it('computes the CID over the canonical bytes, keys sorted, as the courier does', () => {
        const { cid, bytes } = addressOf({ b: 1, a: { d: 2, c: 3 } });
        expect(bytes.toString('utf8')).toBe('{"a":{"c":3,"d":2},"b":1}');
        expect(cid).toBe(cidOf(bytes));
        expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    });

    it('takes only an http(s) API base, without its trailing slash', () => {
        expect(cleanApiBase('https://index.test///')).toBe('https://index.test');
        expect(() => cleanApiBase('index.test')).toThrow(/http\(s\) URL/);
    });
});

describe('publishing designs and agreements', () => {
    it('indexes the design under its canonical CID in one write, pinning nothing, sending the app origin on writes only', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        expect(client.apiBase).toBe(API);
        expect(client.pin).toBeUndefined();
        const published = await client.publishDesign(design, { parcelSourceId: 'hr-cadastre' });
        const { cid } = addressOf(design);
        expect(published).toMatchObject({ cid, created: true, row: { cid, city: 'zagreb' } });
        expect(index.calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /designs']);
        expect(index.calls[0].body).toEqual({ cid, content: design, parcelSourceId: 'hr-cadastre' });
        expect(index.calls.every(call => call.headers.origin === ORIGIN)).toBe(true);
        await client.getDesign(cid);
        expect(index.calls.at(-1).headers.origin).toBeUndefined();
    });

    it('is repeatable: a second publish answers the indexed row with created false', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        await client.publishDesign(design);
        const again = await client.publishDesign(design);
        expect(again).toMatchObject({ cid: addressOf(design).cid, created: false });
        expect(index.designs.size).toBe(1);
    });

    it('refuses an answer that names another CID, and passes the index\'s refusals on with their code', async () => {
        const otherCid = addressOf({ other: true }).cid;
        await expect(clientOver(fakeIndex({ answerCid: otherCid })).publishDesign(design))
            .rejects.toMatchObject({ code: 'cid-mismatch', expected: addressOf(design).cid, received: otherCid, stage: 'index-design', indexed: false });
        const index = fakeIndex({ refuseDesigns: { status: 422, body: { code: 'invalid-design', error: 'not a design' } } });
        await expect(clientOver(index).publishDesign(design))
            .rejects.toMatchObject({ status: 422, code: 'invalid-design', cid: addressOf(design).cid, stage: 'index-design', indexed: false });
        await expect(clientOver(index).indexDesign('not-a-cid', design)).rejects.toThrow(/must be a CIDv1/);
    });

    it('publishes an agreement with a linked design the index does not hold, indexed in the same request', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const layoutCid = addressOf(layout).cid;
        const published = await client.publishAgreement(agreement, { designs: [{ cid: layoutCid, content: layout }] });
        expect(published).toMatchObject({ cid: addressOf(agreement).cid, created: true, row: { linkedDesigns: 1 } });
        expect(index.calls.at(-1).body).toEqual({ cid: published.cid, content: agreement, designs: [{ cid: layoutCid, content: layout }] });
        expect(index.designs.has(layoutCid)).toBe(true);
        // Without linked designs the request carries none.
        const plain = { ...agreement, title: 'Plain' };
        await client.publishAgreement(plain);
        expect(index.calls.at(-1).body).toEqual({ cid: addressOf(plain).cid, content: plain });
    });

    it('sends the exact linked plan with its agreement in one POST /agreements, and refuses a plan that is not the agreement\'s', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const linkedAgreement = { ...agreement, planCid: plan.cid };
        const published = await client.publishAgreement(linkedAgreement, { plan });
        expect(published.cid).toBe(addressOf(linkedAgreement).cid);
        expect(index.calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /agreements']);
        expect(index.calls.at(-1).body.plan).toEqual(plan);

        const otherPlan = { ...linkedAgreement, title: 'Other plan', planCid: addressOf({ other: 'plan' }).cid };
        await expect(client.publishAgreement(otherPlan, { plan }))
            .rejects.toMatchObject({ code: 'cid-mismatch', cid: addressOf(otherPlan).cid, stage: 'index-agreement', indexed: false });
        expect(index.calls).toHaveLength(1);
    });

    it('asks what a site binds without storing anything, and reads designs back', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const site = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
        expect(await client.designBinding({ site, toleranceM: 0.2, city: 'zagreb' })).toMatchObject({ city: 'zagreb', binding: { toleranceM: 0.2 } });
        expect(index.calls[0].body).toEqual({ site, toleranceM: 0.2, city: 'zagreb' });
        await expect(client.designBinding({ site: { type: 'Point', coordinates: [0, 0] } })).rejects.toThrow(/Polygon or MultiPolygon/);

        const { cid } = await client.publishDesign(design);
        expect(await client.getDesign(cid)).toMatchObject({ cid });
        expect(await client.getDesign(addressOf({ missing: 1 }).cid)).toBeNull();
        const rows = await client.getDesigns([cid, cid, addressOf({ missing: 1 }).cid]);
        expect([...rows.keys()]).toEqual([cid]);
        expect(index.calls.at(-1).body.cids).toHaveLength(2);
    });
});

describe('the chain account', () => {
    it('is recorded once (201) and refreshed (200), each answer checked to name the account', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const { cid } = await client.publishAgreement(agreement);
        const recorded = await client.recordOnchain(cid, { cluster: 'devnet', account: ACCOUNT, signature: 'create-sig' });
        expect(recorded.onchain).toEqual({ chain: 'solana', cluster: 'devnet', account: ACCOUNT, signature: 'create-sig' });
        expect(index.calls.at(-1).body).toEqual({ chain: 'solana', cluster: 'devnet', account: ACCOUNT, signature: 'create-sig' });
        const refreshed = await client.recordOnchain(cid, { cluster: 'devnet', account: ACCOUNT });
        expect(onchainNames(refreshed, ACCOUNT)).toBe(true);
        expect(index.calls.filter(call => call.path.endsWith('/onchain')).length).toBe(2);
        await expect(client.recordOnchain(cid, { cluster: 'devnet', account: '11111111111111111111111111111111' }))
            .rejects.toMatchObject({ status: 409, code: 'onchain-recorded-elsewhere' });
        await expect(client.recordOnchain(cid, { account: ACCOUNT })).rejects.toThrow(/needs cluster and account/);
    });

    it('asks again after a pause while the index cannot see a fresh mint yet, and gives up after four tries', async () => {
        const pauses = [];
        const wait = async ms => { pauses.push(ms); };
        const index = fakeIndex({ onchainUnseen: 2 });
        const client = clientOver(index, { wait });
        const { cid } = await client.publishAgreement(agreement);
        expect((await client.recordOnchain(cid, { cluster: 'devnet', account: ACCOUNT })).onchain.account).toBe(ACCOUNT);
        expect(pauses).toEqual([5000, 10000]);

        const stuck = fakeIndex({ onchainUnseen: 10 });
        const stuckClient = clientOver(stuck, { wait });
        const { cid: stuckCid } = await stuckClient.publishAgreement(agreement);
        await expect(stuckClient.recordOnchain(stuckCid, { cluster: 'devnet', account: ACCOUNT })).rejects.toMatchObject({ code: 'onchain-account-missing' });
        expect(stuck.calls.filter(call => call.path.endsWith('/onchain'))).toHaveLength(4);
    });

    it('refuses an answer about another account', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const { cid } = await client.publishAgreement(agreement);
        // An index that answers its row with another account than the one recorded.
        const lying = createIndexClient({ apiBase: API, origin: ORIGIN, fetchImpl: async (url, init) => {
            const response = await index.fetchImpl(url, init);
            const body = await response.json();
            return new Response(JSON.stringify({ ...body, onchain: { account: '11111111111111111111111111111111' } }), { status: response.status });
        } });
        await expect(lying.recordOnchain(cid, { cluster: 'devnet', account: ACCOUNT })).rejects.toMatchObject({ code: 'cid-mismatch', expected: ACCOUNT });
    });
});

describe('owner decisions and reads', () => {
    it('relays a decision once (201) and reports the duplicate (200), listing them back in order', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const { cid } = await client.publishAgreement(agreement);
        const receipt = { ownerId: 'owner-a', decision: 'approve', decisionProof: { signature: 'sig-1' } };
        expect(await client.relayDecision(cid, receipt)).toEqual({ stored: true, duplicate: false });
        expect(await client.relayDecision(cid, receipt)).toEqual({ stored: true, duplicate: true });
        expect(await client.listDecisions(cid)).toEqual([receipt]);
        await expect(client.relayDecision(cid, { decision: 'bogus' })).rejects.toMatchObject({ status: 400, code: 'invalid_receipt' });
        await expect(client.listDecisions(addressOf({ missing: 1 }).cid)).rejects.toMatchObject({ status: 404 });
    });

    it('reads an agreement, null when the index does not hold it, and lists with the filters given', async () => {
        const index = fakeIndex();
        const client = clientOver(index);
        const { cid } = await client.publishAgreement(agreement);
        expect(await client.getAgreement(cid)).toMatchObject({ cid, status: 'active' });
        expect(await client.getAgreement(addressOf({ missing: 1 }).cid)).toBeNull();
        const designCid = addressOf(design).cid;
        const listed = await client.listAgreements({ city: 'zagreb', design: designCid, parcel: 'HR-1', limit: 5 });
        expect(listed.count).toBe(1);
        expect(index.calls.at(-1).query).toEqual({ city: 'zagreb', design: designCid, parcel: 'HR-1', limit: '5' });
        await expect(client.listAgreements({ design: 'agent-1' })).rejects.toThrow(/design must be a CIDv1/);
    });
});

describe('rate-limit recovery', () => {
    const answer = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    it('waits the full server cooldown once without short 429 retries', async () => {
        const calls = [], waits = [];
        let clock = 0;
        const client = createIndexClient({ apiBase: API, waitOnRateLimit: true, now: () => clock,
            wait: async ms => { waits.push(ms); clock += ms; },
            fetchImpl: async (url, init) => {
                calls.push(`${clock} ${new URL(url).pathname}`);
                if (calls.length === 1) return answer(429, { code: 'upload-rate-limited', retryAfterSeconds: 900 }, { 'retry-after': '30' });
                return answer(201, { cid: JSON.parse(init.body).cid });
            } });
        expect(await client.publishDesign(design)).toMatchObject({ cid: addressOf(design).cid, created: true });
        expect(waits).toEqual([900_000]); expect(calls).toEqual(['0 /designs', '900000 /designs']);
    });
    it('honors date headers, backs off missing cooldowns and stops after four refusals', async () => {
        let clock = Date.parse('2026-10-27T00:00:00Z');
        const waits = [], calls = [];
        const client = createIndexClient({ apiBase: API, waitOnRateLimit: true, now: () => clock,
            wait: async ms => { waits.push(ms); clock += ms; },
            fetchImpl: async () => { calls.push(clock); return answer(429, { code: 'upload-rate-limited' },
                calls.length === 1 ? { 'retry-after': 'Tue, 27 Oct 2026 00:02:00 GMT' } : {}); } });
        await expect(client.publishDesign(design)).rejects.toMatchObject({ status: 429, code: 'upload-rate-limited', stage: 'index-design' });
        expect(waits).toEqual([120_000, 120_000, 240_000]); expect(calls).toHaveLength(4);
    });
    it('does not retry before an excessive cooldown or retry a deterministic rejection', async () => {
        for (const status of [429, 400]) {
            let calls = 0;
            const client = createIndexClient({ apiBase: API, waitOnRateLimit: true,
                wait: async () => { throw new Error('must not wait or retry'); },
                fetchImpl: async () => { calls++; return answer(status, { retryAfterSeconds: 3600 }); } });
            await expect(client.publishAgreement(agreement)).rejects.toMatchObject({ status, stage: 'index-agreement' }); expect(calls).toBe(1);
        }
    });
});
