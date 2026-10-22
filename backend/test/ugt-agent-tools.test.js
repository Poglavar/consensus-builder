// The shared tool surface for external agents (agents/ugt-agent-tools.js) on designs and agreements:
// free reads through the index and the public API, the live gate (UGT_MCP_LIVE + confirm) on every
// write, paid or signed tool, publishing only objects exactly in their published form, minting only a
// binding owners' agreement as its own sponsor with one foreign lens key, and every market, pledge and
// donation keyed by the agreement's chain account. The index is driven over a fake fetch, chain steps
// through injected adapters; the agent key is a throwaway generated per test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import {
    agreementObject, communityRule, designObject, holdersFromRights, ownersRule, parcelOutputs, registryRights
} from '../agents/agreement-objects.js';
import { agreementAccountOf, AGREEMENT_PROGRAM_ID } from '../agents/agreement-minter.js';
import { canonicalBytes, cidOfObject } from '../cid.js';
import { layoutContent } from './helpers/content-fixtures.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ugt-tools-test-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const agentKey = Keypair.generate();
const KEYPAIR_FILE = path.join(directory, 'agent.json');
fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(Array.from(agentKey.secretKey)), { mode: 0o600 });
const AGENT = agentKey.publicKey.toBase58();
const LENS = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const API = 'https://api.example.test';
const PARCEL = 'HR-335550-1/1';
const LIVE = { UGT_API_BASE: `${API}/`, UGT_MCP_LIVE: '1', UGT_AGENT_KEYPAIR: KEYPAIR_FILE, UGT_MCP_MAX_USDC_PER_ACTION: '0.10' };

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// A six-storey building on its parcel, as the proposer publishes it.
const design = designObject({
    goal: 'buildings', title: 'Six storeys', description: 'Infill matching the eaves.', author: 'agent-01', city: 'zagreb',
    site: null, toleranceM: null, origin: null, createdAt: '2026-10-22T09:00:00.000Z',
    geometry: { buildings: [{ type: 'Feature', geometry: box(15.9771, 45.8131, 15.9774, 45.8132), properties: { type: 'proposedBuildingSingle', height: 19.5, floors: 6, rotation: 0 } }] },
    buildingProposal: { blockName: `Parcel ${PARCEL}`, typologyType: 'single', parameters: { height: 19.5, floors: 6, rotation: 0, typology: 'single' } }
});

function agreementOf({ sponsor = AGENT, rule = null, title = 'Six storeys on the corner lot', deadline = '2099-01-01T00:00:00.000Z' } = {}) {
    const rights = registryRights([{ parcelId: PARCEL, owners: [{ owner: AGENT, ownerCount: 1 }] }]);
    return agreementObject({
        title, author: 'agent-01', sponsor, city: 'zagreb', createdAt: '2026-10-22T09:05:00.000Z',
        designs: [{ cid: design.cid, goal: design.content.goal, title: design.content.title }],
        parcels: [{ parcelId: PARCEL, areaM2: 612.4, holders: holdersFromRights(rights, PARCEL) }],
        outputs: parcelOutputs([{ parcelId: PARCEL, geometry: box(15.977, 45.813, 15.9775, 45.8133), areaM2: 612.4 }]),
        rule: rule || ownersRule({ lens: LENS, rights }), deadline
    });
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const rowOf = ({ cid, content }) => ({ cid, city: 'zagreb', title: content.title, author: content.author, content, onchain: null, status: 'active' });

// The public API over a fake fetch: the index's pins, designs and agreements, and plain JSON reads.
function fakeApi({ agreements = [] } = {}) {
    const rows = new Map(agreements.map(item => [item.cid, rowOf(item)]));
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
        const target = new URL(String(url));
        const method = String(init.method || 'GET').toUpperCase();
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: `${target.pathname}${target.search}`, body, origin: init.headers?.origin ?? null });
        const onchain = target.pathname.match(/^\/agreements\/([^/]+)\/onchain$/);
        if (method === 'POST' && target.pathname === '/pins') return json({ cid: body.cid, pinnedAt: '2026-10-22T09:06:00.000Z' }, 201);
        if (method === 'POST' && target.pathname === '/designs') return json({ cid: body.cid, content: body.content, binding: { parcels: [{ parcelId: PARCEL }] } }, 201);
        if (method === 'POST' && target.pathname === '/agreements') {
            rows.set(body.cid, rowOf(body));
            return json(rows.get(body.cid), 201);
        }
        if (method === 'POST' && onchain) {
            const row = { ...rows.get(decodeURIComponent(onchain[1])), onchain: { chain: 'solana', cluster: body.cluster, account: body.account, status: 'active' } };
            return json(row, 201);
        }
        if (method === 'GET' && target.pathname === '/agreements') return json({ agreements: [...rows.values()], count: rows.size });
        if (method === 'GET' && target.pathname.startsWith('/agreements/')) {
            const row = rows.get(decodeURIComponent(target.pathname.slice('/agreements/'.length)));
            return row ? json(row) : json({ error: 'not found', code: 'agreement-not-found' }, 404);
        }
        return json({ ok: true, url: String(url) });
    });
    return { fetchImpl, calls, posts: () => calls.filter(call => call.method === 'POST') };
}

describe('reads', () => {
    it('reads the index, activity, support and oracle events the UI reads, with nothing enabled', async () => {
        const agreement = agreementOf();
        const api = fakeApi({ agreements: [agreement] });
        const tools = createUrbanGameTheoryTools({ env: { UGT_API_BASE: `${API}/` }, fetchImpl: api.fetchImpl });

        const listed = await tools.listAgreements({ city: 'zagreb', design: design.cid, parcel: PARCEL, limit: 7 });
        await tools.getActivity({ limit: 12, source: 'live' });
        await tools.getSupport({ agreementAccount: 'agreement-account' });
        await tools.getOracleEvents({ agreementAccount: 'agreement-account', limit: 3 });
        await tools.capabilities();

        expect(listed.agreements.map(row => row.cid)).toEqual([agreement.cid]);
        expect(api.calls.map(call => call.path)).toEqual([
            `/agreements?city=zagreb&design=${design.cid}&parcel=HR-335550-1%2F1&limit=7`,
            '/agent/activity?limit=12&source=live',
            '/agent/pledges/agreement-account',
            '/oracle/events?subject=agreement-account&limit=3',
            '/docs/agents.json'
        ]);
        expect(tools.config).toMatchObject({
            apiBase: API, appOrigin: 'https://urbangametheory.xyz', cluster: 'solana-devnet', agreementProgram: AGREEMENT_PROGRAM_ID,
            liveActionsEnabled: false, keypairConfigured: false, maxUsdcPerAction: '0.25'
        });
    });

    it('answers an agreement with the account its sponsor and CID derive, and that account as the chain holds it', async () => {
        const minted = agreementOf();
        const unsponsored = agreementOf({ sponsor: null, title: 'Nobody mints this' });
        const api = fakeApi({ agreements: [minted, unsponsored] });
        const readAgreementAccount = vi.fn(async () => ({ address: agreementAccountOf(minted.cid, AGENT), status: 'Active' }));
        const tools = createUrbanGameTheoryTools({ env: { UGT_API_BASE: API }, fetchImpl: api.fetchImpl, createConnection: () => ({ name: 'rpc' }), dependencies: { readAgreementAccount } });

        expect(await tools.getAgreement({ agreementCid: minted.cid })).toMatchObject({
            sponsor: AGENT, account: agreementAccountOf(minted.cid, AGENT), minted: true, accountState: { status: 'Active' }, agreement: { cid: minted.cid }
        });
        expect(readAgreementAccount).toHaveBeenCalledWith({ name: 'rpc' }, { cid: minted.cid, sponsor: AGENT });
        readAgreementAccount.mockResolvedValueOnce(null);
        expect(await tools.getAgreement({ agreementCid: minted.cid })).toMatchObject({ minted: false, accountState: null });
        expect(await tools.getAgreement({ agreementCid: unsponsored.cid })).toMatchObject({ sponsor: null, account: null, minted: false });
        expect(readAgreementAccount).toHaveBeenCalledTimes(2);
        await expect(tools.getAgreement({ agreementCid: cidOfObject({ unknown: true }) })).rejects.toThrow(/is not in the index; propose it first/);
    });
});

describe('the live gate', () => {
    const calls = tools => [
        () => tools.publishDesign({ design: design.content, confirm: true }),
        () => tools.proposeAgreement({ agreement: agreementOf().content, confirm: true }),
        () => tools.mintAgreement({ agreementCid: agreementOf().cid, lamports: '0', confirm: true }),
        () => tools.fundAgreement({ agreementCid: agreementOf().cid, targetLamports: '1', confirm: true }),
        () => tools.betOnAgreement({ agreementCid: agreementOf().cid, side: 'yes', amountUsdc: '0.01', confirm: true }),
        () => tools.buyVerifiedFact({ agreementAccount: 'abc', confirm: true }),
        () => tools.pledge({ agreementAccount: 'abc', amountUsdc: '0.01', confirm: true }),
        () => tools.donate({ agreementAccount: 'abc', amountUsdc: '0.01', operationId: 'once', confirm: true }),
        () => tools.refundDonation({ agreementAccount: 'abc', operationId: 'once', confirm: true }),
        () => tools.voidPledge({ agreementAccount: 'abc', confirm: true }),
        () => tools.revokePledge({ agreementAccount: 'abc', confirm: true }),
        () => tools.releaseDonations({ agreementAccount: 'abc', confirm: true }),
        () => tools.fulfillPledge({ agreementAccount: 'abc', confirm: true }),
        () => tools.resolve({ agreementAccount: 'abc', confirm: true }),
        () => tools.claim({ agreementAccount: 'abc', side: 'no', confirm: true }),
        () => tools.resolveExternal({ recipeHash: 'a'.repeat(64), attestation: 'abc', confirm: true }),
        () => tools.claimExternal({ recipeHash: 'a'.repeat(64), side: 'yes', confirm: true })
    ];

    it('keeps every write, paid and signed tool disabled by default', async () => {
        const fetchImpl = vi.fn();
        const tools = createUrbanGameTheoryTools({ env: {}, fetchImpl });
        for (const call of calls(tools)) await expect(call()).rejects.toThrow('live actions are disabled');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a live call that is not confirmed with confirm: true', async () => {
        const fetchImpl = vi.fn();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl });
        await expect(tools.publishDesign({ design: design.content })).rejects.toThrow('confirm must be true');
        await expect(tools.pledge({ agreementAccount: 'abc', amountUsdc: '0.01', confirm: 'yes' })).rejects.toThrow('confirm must be true');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('publishing designs and agreements', () => {
    it('pins and indexes a design exactly in its published form, sending the app origin', async () => {
        const api = fakeApi();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl });
        const result = await tools.publishDesign({ design: design.content, parcelSourceId: 'hr-cadastre', confirm: true });
        expect(result).toMatchObject({ cid: design.cid, created: true, row: { cid: design.cid } });
        expect(api.posts()).toEqual([
            { method: 'POST', path: '/pins', origin: 'https://urbangametheory.xyz',
                body: { kind: 'design', cid: design.cid, bytes: canonicalBytes(design.content).toString('base64') } },
            { method: 'POST', path: '/designs', origin: 'https://urbangametheory.xyz',
                body: { cid: design.cid, content: design.content, parcelSourceId: 'hr-cadastre' } }
        ]);
    });

    it('refuses a design that is not its published form, naming where, and a parcel layout on its own', async () => {
        const api = fakeApi();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl });
        await expect(tools.publishDesign({ design: { ...design.content, note: 'extra' }, confirm: true }))
            .rejects.toThrow(/not in its published design\/v1 form; it differs at note \(published: absent\)/);
        await expect(tools.publishDesign({ design: { ...design.content, schema: 'design/v0' }, confirm: true })).rejects.toThrow(/must be a design\/v1 object/);
        await expect(tools.publishDesign({ design: layoutContent(), confirm: true })).rejects.toThrow(/is a parcel layout: a layout is published only with the agreement/);
        expect(api.calls).toEqual([]);
    });

    it('proposes an agreement with the designs it carries and answers the account its sponsor will mint', async () => {
        const agreement = agreementOf();
        const api = fakeApi();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl });
        const result = await tools.proposeAgreement({ agreement: agreement.content, designs: [{ content: design.content }], confirm: true });
        expect(result).toMatchObject({
            cid: agreement.cid, created: true, carried: [design.cid], sponsor: AGENT, account: agreementAccountOf(agreement.cid, AGENT)
        });
        expect(api.posts().map(call => [call.path, call.body.kind ?? null, call.body.cid])).toEqual([
            ['/pins', 'design', design.cid], ['/pins', 'agreement', agreement.cid], ['/agreements', null, agreement.cid]
        ]);
        expect(api.posts()[2].body).toEqual({ cid: agreement.cid, content: agreement.content, designs: [{ cid: design.cid, content: design.content }] });
        // A poll without a sponsor has no account.
        const poll = agreementOf({ sponsor: null, rule: communityRule([LENS]) });
        expect(await tools.proposeAgreement({ agreement: poll.content, confirm: true })).toMatchObject({ cid: poll.cid, sponsor: null, account: null, carried: [] });
    });

    it('refuses a stray or doubled carried design, an agreement not in its published form and a sponsor that is no wallet', async () => {
        const agreement = agreementOf();
        const api = fakeApi();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl });
        const stray = designObject({ ...design.content, title: 'Another design', createdAt: design.content.authoredAt });
        await expect(tools.proposeAgreement({ agreement: agreement.content, designs: [{ content: stray.content }], confirm: true }))
            .rejects.toThrow(`design ${stray.cid} is carried, but the agreement does not link it`);
        await expect(tools.proposeAgreement({ agreement: agreement.content, designs: [{ content: design.content }, { content: design.content }], confirm: true }))
            .rejects.toThrow('a design is carried twice');
        await expect(tools.proposeAgreement({ agreement: { ...agreement.content, extra: 1 }, confirm: true }))
            .rejects.toThrow(/not in its published agreement\/v1 form; it differs at extra \(published: absent\)/);
        await expect(tools.proposeAgreement({ agreement: { ...agreement.content, sponsor: 'not-a-wallet' }, confirm: true }))
            .rejects.toThrow(/agreement.sponsor must be the base58 wallet/);
        expect(api.posts()).toEqual([]);
    });
});

describe('minting and funding', () => {
    const mintResult = cid => ({ account: agreementAccountOf(cid, AGENT), signature: 'mint-tx', createSignature: 'create-tx', created: true, escrowLamports: '5000', status: 'Active' });

    it('mints a binding owners\' agreement as its sponsor and records the account in the index', async () => {
        const agreement = agreementOf();
        const api = fakeApi({ agreements: [agreement] });
        const mintAgreement = vi.fn(async ({ cid }) => mintResult(cid));
        const sendAndConfirmPolling = vi.fn();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl, createConnection: () => ({ name: 'rpc' }), dependencies: { mintAgreement, sendAndConfirmPolling } });

        const result = await tools.mintAgreement({ agreementCid: agreement.cid, lamports: '5000', confirm: true });

        const [options] = mintAgreement.mock.calls[0];
        expect(options).toMatchObject({
            connection: { name: 'rpc' }, cid: agreement.cid, lens: LENS, deadline: '2099-01-01T00:00:00.000Z', lamports: '5000',
            openGround: false, sendAndConfirm: sendAndConfirmPolling
        });
        expect(options.sponsorKeypair.publicKey.toBase58()).toBe(AGENT);
        expect(api.posts()).toEqual([{
            method: 'POST', path: `/agreements/${agreement.cid}/onchain`, origin: 'https://urbangametheory.xyz',
            body: { chain: 'solana', cluster: 'devnet', account: agreementAccountOf(agreement.cid, AGENT), signature: 'create-tx' }
        }]);
        expect(result).toMatchObject({ account: agreementAccountOf(agreement.cid, AGENT), created: true, onchain: { account: agreementAccountOf(agreement.cid, AGENT) } });
    });

    it('refuses to mint a poll, another sponsor\'s agreement, an own or plural lens, and a fractional amount', async () => {
        const rights = registryRights([{ parcelId: PARCEL, owners: [{ owner: AGENT, ownerCount: 1 }] }]);
        const cases = [
            [agreementOf({ rule: communityRule([LENS]) }), /is a non-binding community vote: it is a poll in the index and is never minted/],
            [agreementOf({ sponsor: OTHER }), new RegExp(`names sponsor ${OTHER}, not this agent's wallet ${AGENT}`)],
            [agreementOf({ rule: { ...ownersRule({ lens: LENS, rights }), lens: [LENS, OTHER] } }), /takes one lens key, but rule.lens holds 2/],
            [agreementOf({ rule: ownersRule({ lens: AGENT, rights }) }), /rule.lens names only this agent's own key/]
        ];
        const api = fakeApi({ agreements: cases.map(([agreement]) => agreement) });
        const mintAgreement = vi.fn();
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl, createConnection: () => ({}), dependencies: { mintAgreement } });
        for (const [agreement, message] of cases) {
            await expect(tools.mintAgreement({ agreementCid: agreement.cid, lamports: '0', confirm: true })).rejects.toThrow(message);
        }
        await expect(tools.mintAgreement({ agreementCid: cases[1][0].cid, lamports: '1.5', confirm: true })).rejects.toThrow(/whole number of lamports/);
        expect(mintAgreement).not.toHaveBeenCalled();
        expect(api.posts()).toEqual([]);
    });

    it('funds the escrow to a target as the sponsor', async () => {
        const fundAgreement = vi.fn(async () => ({ replayed: false, signature: 'fund-tx' }));
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: vi.fn(), createConnection: () => ({}), dependencies: { fundAgreement } });
        await expect(tools.fundAgreement({ agreementCid: agreementOf().cid, targetLamports: 9000, confirm: true })).rejects.toThrow(/decimal string/);
        expect(await tools.fundAgreement({ agreementCid: agreementOf().cid, targetLamports: '9000', confirm: true })).toMatchObject({ signature: 'fund-tx' });
        expect(fundAgreement).toHaveBeenCalledWith(expect.objectContaining({ cid: agreementOf().cid, targetLamports: '9000' }));
        expect(fundAgreement.mock.calls[0][0].sponsorKeypair.publicKey.toBase58()).toBe(AGENT);
    });
});

describe('betting on an agreement', () => {
    const future = Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000);
    function setup(state) {
        const agreement = agreementOf();
        const unsponsored = agreementOf({ sponsor: null, title: 'Unsponsored' });
        const api = fakeApi({ agreements: [agreement, unsponsored] });
        const readAgreementAccount = vi.fn(async () => state);
        const ensureMarketAndStake = vi.fn(async () => ({ marketPda: 'market', created: false, stakeSignature: 'stake-tx' }));
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: api.fetchImpl, createConnection: () => ({}), dependencies: { readAgreementAccount, ensureMarketAndStake, sendAndConfirmPolling: vi.fn() } });
        return { agreement, unsponsored, tools, readAgreementAccount, ensureMarketAndStake };
    }

    it('stakes on the agreement account once it is minted, Active and before its deadline', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const { agreement, tools, readAgreementAccount, ensureMarketAndStake } = setup({ address: account, status: 'Active', deadline: future });
        const result = await tools.betOnAgreement({ agreementCid: agreement.cid, side: 'NO', amountUsdc: '0.07', confirm: true });
        expect(readAgreementAccount).toHaveBeenCalledWith(expect.anything(), { cid: agreement.cid, sponsor: AGENT });
        expect(ensureMarketAndStake).toHaveBeenCalledWith(expect.objectContaining({ subject: account, side: 0, amountAtomic: 70000n, stakeMint: USDC_DEVNET }));
        expect(result).toMatchObject({ agreementCid: agreement.cid, agreementAccount: account, side: 'no', stakeSignature: 'stake-tx' });
    });

    it('refuses a bet it cannot place before signing anything', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const open = setup({ address: account, status: 'Active', deadline: future });
        await expect(open.tools.betOnAgreement({ agreementCid: open.agreement.cid, side: 'maybe', amountUsdc: '0.01', confirm: true })).rejects.toThrow(/side must be yes or no/);
        await expect(open.tools.betOnAgreement({ agreementCid: open.agreement.cid, side: 'yes', amountUsdc: '0.11', confirm: true })).rejects.toThrow(/exceeds UGT_MCP_MAX_USDC_PER_ACTION/);
        await expect(open.tools.betOnAgreement({ agreementCid: open.unsponsored.cid, side: 'yes', amountUsdc: '0.01', confirm: true })).rejects.toThrow(/names no sponsor wallet/);
        const unminted = setup(null);
        await expect(unminted.tools.betOnAgreement({ agreementCid: unminted.agreement.cid, side: 'yes', amountUsdc: '0.01', confirm: true })).rejects.toThrow(/is not minted yet/);
        const executed = setup({ address: account, status: 'Executed', deadline: future });
        await expect(executed.tools.betOnAgreement({ agreementCid: executed.agreement.cid, side: 'yes', amountUsdc: '0.01', confirm: true })).rejects.toThrow(/is Executed; its market takes no more stakes/);
        const lapsed = setup({ address: account, status: 'Active', deadline: 1_700_000_000 });
        await expect(lapsed.tools.betOnAgreement({ agreementCid: lapsed.agreement.cid, side: 'yes', amountUsdc: '0.01', confirm: true })).rejects.toThrow(/past its deadline/);
        for (const run of [open, unminted, executed, lapsed]) expect(run.ensureMarketAndStake).not.toHaveBeenCalled();
    });
});

describe('support and settlement on the agreement account', () => {
    it('routes pledges, donations and settlement through the shared adapters, the account as subject, under the cap', async () => {
        const names = ['ensurePledgeBookAndSet', 'ensureDonationEscrowAndDonate', 'refundDonation', 'voidPledge', 'revokePledge',
            'releaseDonations', 'fulfillPledge', 'resolveAgreementMarket', 'claimAgreementMarket', 'resolveExternalMarket', 'claimExternalMarket'];
        const dependencies = Object.fromEntries(names.map(name => [name, vi.fn(async () => ({ signature: `${name}-tx` }))]));
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: vi.fn(), createConnection: () => ({}), dependencies: { ...dependencies, sendAndConfirmPolling: vi.fn() } });
        const subject = 'agreement-account';

        await expect(tools.pledge({ agreementAccount: subject, amountUsdc: '0.11', confirm: true })).rejects.toThrow('exceeds UGT_MCP_MAX_USDC_PER_ACTION');
        await expect(tools.donate({ agreementAccount: subject, amountUsdc: '0', operationId: 'once', confirm: true })).rejects.toThrow('amountUsdc must be positive');
        await tools.pledge({ agreementAccount: subject, amountUsdc: '0.05', confirm: true });
        await tools.donate({ agreementAccount: subject, amountUsdc: '0.06', operationId: 'agent:donate:1', confirm: true });
        await tools.refundDonation({ agreementAccount: subject, operationId: 'agent:donate:1', confirm: true });
        await tools.voidPledge({ agreementAccount: subject, pledger: OTHER, confirm: true });
        await tools.revokePledge({ agreementAccount: subject, confirm: true });
        await tools.releaseDonations({ agreementAccount: subject, confirm: true });
        await tools.fulfillPledge({ agreementAccount: subject, confirm: true });
        await tools.resolve({ agreementAccount: subject, confirm: true });
        await tools.claim({ agreementAccount: subject, side: 'yes', confirm: true });
        await tools.resolveExternal({ recipeHash: 'a'.repeat(64), attestation: 'attestation', confirm: true });
        await tools.claimExternal({ recipeHash: 'a'.repeat(64), side: 'no', confirm: true });

        expect(dependencies.ensurePledgeBookAndSet).toHaveBeenCalledTimes(1);
        expect(dependencies.ensurePledgeBookAndSet.mock.calls[0][0]).toMatchObject({ subject, amountAtomic: 50000n });
        expect(dependencies.ensureDonationEscrowAndDonate.mock.calls[0][0]).toMatchObject({ subject, amountAtomic: 60000n, operationId: 'agent:donate:1' });
        expect(dependencies.refundDonation.mock.calls[0][0]).toMatchObject({ subject, operationId: 'agent:donate:1' });
        expect(dependencies.voidPledge.mock.calls[0][0]).toMatchObject({ subject, pledger: OTHER });
        for (const name of ['revokePledge', 'releaseDonations', 'fulfillPledge', 'resolveAgreementMarket']) {
            expect(dependencies[name].mock.calls[0][0]).toMatchObject({ subject });
        }
        expect(dependencies.claimAgreementMarket.mock.calls[0][0]).toMatchObject({ subject, side: 'yes' });
        expect(dependencies.resolveExternalMarket.mock.calls[0][0]).toMatchObject({ recipeHash: 'a'.repeat(64), attestation: 'attestation' });
        expect(dependencies.claimExternalMarket.mock.calls[0][0]).toMatchObject({ recipeHash: 'a'.repeat(64), side: 'no' });
        for (const name of names) expect(dependencies[name].mock.calls[0][0].sendAndConfirm).toBeDefined();
    });
});

describe('paid reads', () => {
    it('refuses a verified fact priced above the cap before loading a signer, and buys one under it for the agreement account', async () => {
        const fetchOracleFactChallenge = vi.fn(async () => ({ accepts: [{ amount: '100001' }] }));
        const createOracleFactClient = vi.fn(async () => ({ payerAddress: AGENT, paidFetch: vi.fn() }));
        const buyOracleFact = vi.fn(async () => ({ status: 200, body: { verification: { status: 'verified' } } }));
        const tools = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: vi.fn(), dependencies: { fetchOracleFactChallenge, createOracleFactClient, buyOracleFact } });

        await expect(tools.buyVerifiedFact({ agreementAccount: 'agreement-account', marketAccount: 'market', confirm: true })).rejects.toThrow('verified fact x402 price exceeds');
        expect(createOracleFactClient).not.toHaveBeenCalled();
        fetchOracleFactChallenge.mockResolvedValueOnce({ accepts: [{ amount: '10000' }] });
        expect(await tools.buyVerifiedFact({ agreementAccount: 'agreement-account', marketAccount: 'market', confirm: true }))
            .toMatchObject({ payerAddress: AGENT, status: 200 });
        expect(fetchOracleFactChallenge).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: API, subject: 'agreement-account', marketAccount: 'market' }));
        expect(buyOracleFact).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: API, subject: 'agreement-account', marketAccount: 'market' }));
        // Inspecting the challenge is a free read.
        await createUrbanGameTheoryTools({ env: {}, fetchImpl: vi.fn(), dependencies: { fetchOracleFactChallenge } }).inspectVerifiedFact({ agreementAccount: 'agreement-account' });
        expect(fetchOracleFactChallenge).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'agreement-account' }));
    });

    it('signs an ownership challenge with the agent key and pays a priced member only when live, confirmed and under the cap', async () => {
        const createPaidClient = vi.fn(async () => ({ payerAddress: AGENT, paidFetch: vi.fn(async () => new Response('{}', { status: 201 })) }));
        const challenge = amount => ({ accepts: [{ amount }] });
        const requestOwnershipAttestation = vi.fn(async ({ secretKey, pay }) => {
            expect(Keypair.fromSecretKey(secretKey).publicKey.toBase58()).toBe(AGENT);
            return pay({ challenge: challenge(requestOwnershipAttestation.amount), paymentId: 'ownership_0123456789abcdef', url: 'http://lens.test/lens/ownership', init: {} });
        });
        const dependencies = { createPaidClient, requestOwnershipAttestation };
        const dry = createUrbanGameTheoryTools({ env: { UGT_AGENT_KEYPAIR: KEYPAIR_FILE }, fetchImpl: vi.fn(), dependencies });
        requestOwnershipAttestation.amount = '10000';
        await expect(dry.requestOwnership({ serviceUrl: 'http://lens.test', parcelUid: PARCEL, confirm: true })).rejects.toThrow('live actions are disabled');
        const live = createUrbanGameTheoryTools({ env: LIVE, fetchImpl: vi.fn(), dependencies });
        requestOwnershipAttestation.amount = '100001';
        await expect(live.requestOwnership({ serviceUrl: 'http://lens.test', parcelUid: PARCEL, confirm: true })).rejects.toThrow('ownership attestation x402 price exceeds');
        expect(createPaidClient).not.toHaveBeenCalled();
        requestOwnershipAttestation.amount = '10000';
        await live.requestOwnership({ serviceUrl: 'http://lens.test', parcelUid: PARCEL, confirm: true });
        expect(createPaidClient).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'ownership_0123456789abcdef' }));
    });
});
