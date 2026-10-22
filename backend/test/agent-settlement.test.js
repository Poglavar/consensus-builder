// The proposer's settlement of its own agreements (agents/README.md, "Settlement phase"): inspectSettlement
// reads the agreement, market and YES position and names the steps still needed; executeSettlement takes
// them in order through the action engine with a checkpoint after each; run.mjs settleStage selects the
// persona's agreements of earlier runs within the caps and settles them end to end against the agreement
// program emulator, a real lens member and the index's own decision relay.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { executeSettlement, inspectSettlement } from '../agents/lifecycle-actions.js';
import { agreementAccountOf, mintAgreement } from '../agents/agreement-minter.js';
import { agreementObject, deadlineAfterDays, designObject, holdersFromRights, ownersRule, parcelOutputs, registryRights } from '../agents/agreement-objects.js';
import { createIndexClient } from '../agents/publication-client.js';
import { settleStage } from '../agents/run.mjs';
import { createAgreementDecisionHandlers, createMemoryAgreementDecisionStore } from '../agreements/decisions.js';
import { createLensMember } from '../lens/member.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';
import { createApprovalAttester, devnetOwnerRegistry } from '../lens/approval.js';
import { createAgreementChain, createLedgerPool, decisionAttestation, fetchVia } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const marketClient = require('../../frontend/js/solana/market-client.js');
const Cid = require('../../frontend/js/cid.js');

const NOW = Math.floor(Date.now() / 1000);
const YES = marketClient.constants.SIDE_YES;
const NO = marketClient.constants.SIDE_NO;
const STATUS = { Active: 0, Executed: 1, Cancelled: 2, Expired: 3 };

let chain;
let owner;
let lens;
let OWNER;
let LENS;

beforeEach(() => {
    chain = createAgreementChain();
    owner = Keypair.generate();
    lens = Keypair.generate();
    OWNER = owner.publicKey.toBase58();
    LENS = lens.publicKey.toBase58();
});

// An agreement account of the owner placed on the emulated chain with the state a test needs.
function placeAgreement(seed, { status = 'Active', decision = 0, deadline = NOW + 7 * 86400, required = 1000n, escrow = 1000n, authority, lensKey } = {}) {
    const cid = Cid.cidOfObject({ schema: 'agreement/v1', title: seed });
    const sponsor = authority ?? OWNER;
    const account = agreementAccountOf(cid, sponsor);
    chain.putAgreement(account, {
        cid, authority: sponsor, lens: lensKey ?? LENS, payout: sponsor, deadline, requiredLamports: required, escrowLamports: escrow,
        status: STATUS[status], decision, decisionAttestation: decision ? Keypair.generate().publicKey.toBase58() : undefined
    });
    return { cid, account, pickId: `pick-${seed}`, sourceRunId: 'run-earlier', sourceDay: '2026-10-20' };
}

// Markets the injected readers serve, keyed by agreement account.
function marketBook() {
    const markets = new Map();
    const positions = new Map();
    return {
        markets, positions,
        readers: {
            readMarket: async (_connection, account) => markets.get(account) ?? null,
            readPosition: async (_connection, account) => positions.get(account) ?? null
        }
    };
}

describe('inspecting an agreement', () => {
    const inspect = (agreement, overrides = {}) => inspectSettlement({ connection: chain.connection, owner: OWNER, agreement, lensKey: LENS, nowSeconds: NOW, ...overrides });

    it('decides a funded agreement on the persona\'s own land: approve, lens decision, attest, execute, then resolve YES and claim', async () => {
        const book = marketBook();
        const item = { ...placeAgreement('decidable'), soleOwner: true };
        book.markets.set(item.account, { resolved: false, yesPool: 250000n, noPool: 0n, outcome: 0 });
        book.positions.set(item.account, { amount: 250000n, claimed: false });
        const inspected = await inspect(item, { readers: book.readers });
        expect(inspected).toMatchObject({ state: 'decidable', outcome: 'YES', steps: ['decide', 'lens', 'attest', 'execute', 'resolve', 'claim'],
            escrowLamports: '1000', requiredLamports: '1000', decision: 'Pending', expectedPayout: '250000', market: { resolved: false } });
    });

    it('waits for the owners, for a lens it does not operate, and for funds', async () => {
        expect(await inspect({ ...placeAgreement('rival'), soleOwner: false })).toMatchObject({ state: 'awaiting-owners', steps: [] });
        const foreignLens = Keypair.generate().publicKey.toBase58();
        expect(await inspect({ ...placeAgreement('other lens', { lensKey: foreignLens }), soleOwner: true }))
            .toMatchObject({ state: 'lens-not-operated', steps: [], lens: foreignLens });
        expect(await inspect({ ...placeAgreement('no lens'), soleOwner: true }, { lensKey: null })).toMatchObject({ state: 'lens-not-operated' });
        // Pending and short of escrow: it can still be decided now, executed later.
        expect(await inspect({ ...placeAgreement('short', { escrow: 10n }), soleOwner: true }))
            .toMatchObject({ state: 'decidable', outcome: null, steps: ['decide', 'lens', 'attest'], note: expect.stringMatching(/escrow lacks/) });
        expect(await inspect({ ...placeAgreement('decided short', { escrow: 10n, decision: 1 }), soleOwner: true }))
            .toMatchObject({ state: 'awaiting-funds', steps: [] });
    });

    it('expires one past its deadline and resolves NO, claiming the YES refund only when nobody staked NO', async () => {
        const book = marketBook();
        const item = { ...placeAgreement('late', { deadline: NOW - 60 }), soleOwner: true };
        book.markets.set(item.account, { resolved: false, yesPool: 100000n, noPool: 0n });
        book.positions.set(item.account, { amount: 100000n, claimed: false });
        expect(await inspect(item, { readers: book.readers })).toMatchObject({ state: 'due', outcome: 'NO', steps: ['expire', 'resolve', 'claim'], expectedPayout: '100000' });
        book.markets.set(item.account, { resolved: false, yesPool: 100000n, noPool: 50000n });
        expect(await inspect(item, { readers: book.readers }))
            .toMatchObject({ state: 'due', steps: ['expire', 'resolve'], expectedPayout: '0', note: 'YES stake lost: the NO pool is not empty' });
    });

    it('finishes terminal agreements and closes those with nothing left', async () => {
        const book = marketBook();
        const executed = { ...placeAgreement('done', { status: 'Executed', decision: 1 }), soleOwner: true };
        book.markets.set(executed.account, { resolved: true, outcome: YES, yesPool: 1n, noPool: 0n });
        book.positions.set(executed.account, { amount: 1n, claimed: false });
        expect(await inspect(executed, { readers: book.readers })).toMatchObject({ state: 'executed', outcome: 'YES', steps: ['claim'] });
        book.positions.set(executed.account, { amount: 1n, claimed: true });
        expect(await inspect(executed, { readers: book.readers })).toMatchObject({ state: 'closed', steps: [] });
        const cancelled = { ...placeAgreement('cancelled', { status: 'Cancelled' }), soleOwner: true };
        expect(await inspect(cancelled)).toMatchObject({ state: 'closed', outcome: 'NO', steps: [] });
        expect(await inspect({ ...placeAgreement('strangers', { authority: Keypair.generate().publicKey.toBase58() }), soleOwner: true })).toMatchObject({ state: 'foreign', steps: [] });
        expect(await inspect({ cid: 'x', account: Keypair.generate().publicKey.toBase58() })).toMatchObject({ state: 'missing', steps: [] });
    });
});

describe('executing the steps', () => {
    function performer() {
        const actions = [];
        return { actions, perform: async (action, execute) => { actions.push(action.type); return execute(); } };
    }

    it('takes decide → lens → attest → execute → resolve → claim in order, checkpointing after each', async () => {
        const item = { ...placeAgreement('happy'), soleOwner: true, outcome: 'YES', steps: ['decide', 'lens', 'attest', 'execute', 'resolve', 'claim'] };
        const fact = decisionAttestation({ lensKey: LENS, agreementCid: item.cid, sponsor: OWNER, sourceObservedAt: NOW - 30 });
        chain.putAttestation(fact.address, fact.bytes);
        const book = marketBook();
        book.markets.set(item.account, { resolved: false, yesPool: 10n, noPool: 0n, outcome: 0 });
        book.positions.set(item.account, { amount: 10n, claimed: false });
        const adapters = {
            resolveAgreementMarket: vi.fn(async () => {
                book.markets.set(item.account, { resolved: true, yesPool: 10n, noPool: 0n, outcome: YES });
                return { replayed: false, signature: 'resolve-sig', outcome: 'YES' };
            }),
            claimAgreementMarket: vi.fn(async ({ side }) => ({ replayed: false, signature: `claim-${side}`, claimed: true }))
        };
        const { actions, perform } = performer();
        const checkpoints = [];
        const result = await executeSettlement({
            connection: chain.connection, ownerKeypair: owner, item, perform, checkpoint: async record => { checkpoints.push(record); },
            decide: async () => ({ replayed: false, decidedAt: '2026-10-22T09:00:00.000Z', ownerId: OWNER }),
            askLens: async () => ({ address: fact.address, credential: fact.credential, reused: false, issuedAt: NOW, transactionSignature: 'lens-tx' }),
            readers: book.readers, adapters, sendAndConfirm: chain.sendAndConfirm, record: { earlier: true }
        });
        expect(actions).toEqual(['decide', 'lens-decision', 'attest', 'execute', 'resolve', 'claim']);
        expect(checkpoints).toHaveLength(6);
        expect(checkpoints[1]).toMatchObject({ earlier: true, cid: item.cid, account: item.account, approval: { ownerId: OWNER },
            lensDecision: { address: fact.address, credential: fact.credential, reused: false, transactionSignature: 'lens-tx' } });
        expect(checkpoints[1].attest).toBeUndefined();
        expect(result).toMatchObject({ attest: { replayed: false, decision: 'Satisfied' }, execution: { status: 'Executed', paidLamports: '1000' },
            resolution: { outcome: 'YES' }, claim: { signature: 'claim-yes' }, pickId: item.pickId, sourceRunId: 'run-earlier', sourceDay: '2026-10-20' });
        expect(chain.agreement(item.account)).toMatchObject({ status: 'Executed', decision: 'Satisfied', decisionAttestation: fact.address });
        expect(adapters.claimAgreementMarket).toHaveBeenCalledWith(expect.objectContaining({ subject: item.account, side: 'yes' }));
    });

    it('expires a due agreement, resolves NO and takes the YES refund', async () => {
        const item = { ...placeAgreement('late', { deadline: NOW - 60 }), outcome: 'NO', steps: ['expire', 'resolve', 'claim'] };
        const book = marketBook();
        book.markets.set(item.account, { resolved: false, yesPool: 10n, noPool: 0n });
        book.positions.set(item.account, { amount: 10n, claimed: false });
        const adapters = {
            resolveAgreementMarket: async () => {
                book.markets.set(item.account, { resolved: true, yesPool: 10n, noPool: 0n, outcome: NO });
                return { replayed: false, signature: 'resolve-sig', outcome: 'NO' };
            },
            claimAgreementMarket: vi.fn(async () => ({ replayed: false, signature: 'refund-sig', claimed: true }))
        };
        const { actions, perform } = performer();
        const result = await executeSettlement({ connection: chain.connection, ownerKeypair: owner, item, perform, checkpoint: async () => {}, readers: book.readers, adapters, sendAndConfirm: chain.sendAndConfirm });
        expect(actions).toEqual(['expire', 'resolve', 'claim']);
        expect(result).toMatchObject({ expiry: { status: 'Expired', refundedLamports: '1000' }, resolution: { outcome: 'NO' }, claim: { signature: 'refund-sig' } });
        expect(chain.agreement(item.account).status).toBe('Expired');
    });

    it('skips a claim with nothing to take, and stops on a market that resolved the other way', async () => {
        const item = { ...placeAgreement('lost', { deadline: NOW - 60 }), outcome: 'NO', steps: ['expire', 'resolve', 'claim'] };
        const book = marketBook();
        book.positions.set(item.account, { amount: 10n, claimed: false });
        const claim = vi.fn();
        const resolveTo = outcome => async () => {
            book.markets.set(item.account, { resolved: true, yesPool: 10n, noPool: 40n, outcome: outcome === 'YES' ? YES : NO });
            return { signature: 'r', outcome };
        };
        const { perform } = performer();
        const lost = await executeSettlement({ connection: chain.connection, ownerKeypair: owner, item, perform, checkpoint: async () => {}, readers: book.readers,
            adapters: { resolveAgreementMarket: resolveTo('NO'), claimAgreementMarket: claim }, sendAndConfirm: chain.sendAndConfirm });
        expect(lost.claim).toEqual({ skipped: true, reason: 'nothing-to-claim', signature: null });
        expect(claim).not.toHaveBeenCalled();

        const other = { ...placeAgreement('mismatch', { deadline: NOW - 60 }), outcome: 'NO', steps: ['resolve'] };
        await expect(executeSettlement({ connection: chain.connection, ownerKeypair: owner, item: other, perform, checkpoint: async () => {}, readers: book.readers,
            adapters: { resolveAgreementMarket: resolveTo('YES') }, sendAndConfirm: chain.sendAndConfirm })).rejects.toThrow('market resolved YES; expected NO');
    });

    it('needs its off-chain steps and a lens decision to attest', async () => {
        const item = { ...placeAgreement('incomplete'), steps: ['decide'] };
        const { perform } = performer();
        const base = { connection: chain.connection, ownerKeypair: owner, perform, checkpoint: async () => {}, sendAndConfirm: chain.sendAndConfirm };
        await expect(executeSettlement({ ...base, item })).rejects.toThrow('a decide step needs decide()');
        await expect(executeSettlement({ ...base, item: { ...item, steps: ['lens'] } })).rejects.toThrow('a lens step needs askLens()');
        await expect(executeSettlement({ ...base, item: { ...item, steps: ['attest'] } })).rejects.toThrow(`no lens decision to record on ${item.account}`);
        await expect(executeSettlement({ ...base, item, perform: undefined })).rejects.toThrow('perform and checkpoint are required');
    });
});

describe('the settlement phase of a run (run.mjs settleStage)', () => {
    const PARCEL_ID = 'HR-335550-1234/1';
    const PARCEL = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9704, 45.8], [15.9704, 45.8003], [15.97, 45.8003], [15.97, 45.8]]] };
    const persona = { name: 'densifier-01', wallet: null, keypairPath: '~/.config/solana/not-read-in-tests.json' };
    const ENV = { AGENT_DAILY_ACTION_CAP: '15', AGENT_SETTLE_MAX_PER_RUN: '3' };
    let world;

    // The persona's agreement over its own parcel, as an earlier run built, indexed and minted it.
    async function earlierAgreement(seed, { deadlineDays = 7 } = {}) {
        const design = designObject({
            goal: 'buildings', title: seed, author: persona.name, city: 'zagreb', site: null, toleranceM: null, origin: null, createdAt: new Date().toISOString(),
            buildingProposal: { blockName: `Parcel ${PARCEL_ID}`, typologyType: 'single', parameters: { floors: 4, height: 13, rotation: 0, typology: 'single', rule: null } },
            geometry: { buildings: [{ type: 'Feature', geometry: PARCEL, properties: { type: 'proposedBuildingSingle', floors: 4, height: 13 } }] }
        });
        const rights = registryRights([{ parcelId: PARCEL_ID, owners: [{ owner: OWNER, ownerCount: 1 }] }]);
        const { cid, content } = agreementObject({
            title: seed, author: persona.name, sponsor: OWNER, city: 'zagreb', createdAt: new Date().toISOString(),
            designs: [{ cid: design.cid, goal: design.content.goal, title: design.content.title }],
            parcels: [{ parcelId: PARCEL_ID, areaM2: 612.4, holders: holdersFromRights(rights, PARCEL_ID) }],
            outputs: parcelOutputs([{ parcelId: PARCEL_ID, geometry: PARCEL, areaM2: 612.4 }]),
            rule: ownersRule({ lens: LENS, rights }), deadline: deadlineAfterDays(Date.now(), deadlineDays)
        });
        const minted = await mintAgreement({ connection: chain.connection, sponsorKeypair: owner, cid, lens: LENS, deadline: content.deadline, lamports: '1000', sendAndConfirm: chain.sendAndConfirm });
        world.rows.set(cid, { cid, content, status: 'active', deadline: content.deadline, onchain: null });
        return { cid, content, account: minted.account };
    }

    function runRow(runId, day, agreements) {
        const summary = { picks: [], agreements: {}, mints: {} };
        agreements.forEach((agreement, index) => {
            const key = `densifier-01:${index}`;
            summary.picks.push({ pickId: `agent-densifier-01-${day}-${index + 1}`, candidateId: key });
            summary.agreements[key] = { cid: agreement.cid, content: agreement.content, deadline: agreement.content.deadline };
            summary.mints[key] = { account: agreement.account };
        });
        return { run_id: runId, persona: persona.name, day, summary };
    }

    beforeEach(() => {
        persona.wallet = OWNER;
        const rows = new Map();
        const decisionStore = createMemoryAgreementDecisionStore();
        const onchainCalls = [];
        const handlers = createAgreementDecisionHandlers({ loadAgreement: async cid => rows.get(cid) ?? null, store: decisionStore });
        const indexApp = express();
        indexApp.use(express.json({ limit: '2mb' }));
        indexApp.get('/agreements/:cid/decisions', handlers.get);
        indexApp.post('/agreements/:cid/decisions', handlers.post);
        indexApp.post('/agreements/:cid/onchain', (req, res) => {
            onchainCalls.push({ cid: req.params.cid, ...req.body });
            res.status(200).json({ cid: req.params.cid, onchain: { account: req.body.account } });
        });
        const clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };
        const identity = createDevnetRegistryIdentity({ rows: [{ parcelUid: PARCEL_ID, owner: OWNER, ownerCount: 1, establishedAt: '2026-10-01T00:00:00Z' }], clock, authority: LENS });
        // The member's attestations land on the emulated chain, as its own transaction would put them there.
        const fake = createFakeIssuer({ authority: LENS, clock });
        const issuer = { ...fake, async createAttestation(args) {
            const issued = await fake.createAttestation(args);
            chain.putAttestation(issued.address, issued.accountBytes);
            return issued;
        } };
        const member = createLensMember({ authority: LENS, issuer, store: createMemoryStore(), identity, clock, kind: 'lifecycle', dryRun: true });
        const lensApp = createLensMemberApp({
            member, pricing: createLensPricing({ dryRun: true }), operatorToken: 'operator-token', clock,
            approvalAttester: createApprovalAttester({ keypair: lens, registry: devnetOwnerRegistry(identity), clock }),
            agreements: { load: async cid => rows.get(cid) ?? null, decisions: cid => decisionStore.list(cid) }
        });
        world = {
            rows, decisionStore, onchainCalls,
            index: createIndexClient({ apiBase: 'https://index.test', origin: 'https://urbangametheory.xyz', fetchImpl: fetchVia(indexApp) }),
            lensFetch: fetchVia(lensApp),
            lens: { name: 'lifecycle-01', key: LENS, serviceUrl: 'https://lens.test', operatorToken: 'operator-token' }
        };
    });

    function settle(pool, entries, overrides = {}) {
        const failures = [];
        const report = [];
        const loadSigner = vi.fn(() => owner);
        const done = settleStage({
            pool, connection: chain.connection, index: world.index, lens: world.lens, entries, dryRun: false, controller: 'algorithm',
            plannedActions: 3, failures, report, env: ENV, loadSigner, sendAndConfirm: chain.sendAndConfirm, fetchImpl: world.lensFetch, ...overrides
        });
        return done.then(() => ({ failures, report, loadSigner }));
    }

    it('settles an earlier agreement end to end and marks it settled, so the next run does not read it again', async () => {
        const agreement = await earlierAgreement('Four storeys');
        const pool = createLedgerPool({ runs: [
            runRow('2026-10-20-densifier-01', '2026-10-20', [agreement]),
            { run_id: '2026-10-22-densifier-01', persona: persona.name, day: '2026-10-22', summary: {} }
        ] });
        const entry = { persona, runId: '2026-10-22-densifier-01', day: '2026-10-22', run: pool.run('2026-10-22-densifier-01') };
        const { failures, report } = await settle(pool, [entry]);
        expect(failures).toEqual([]);
        expect(report).toEqual(['densifier-01: settled 1/1']);
        expect(chain.agreement(agreement.account)).toMatchObject({ status: 'Executed', decision: 'Satisfied', lens: LENS });
        expect(await world.decisionStore.list(agreement.cid)).toHaveLength(1);
        const record = pool.run('2026-10-22-densifier-01').summary.settlements[agreement.account];
        expect(record).toMatchObject({ cid: agreement.cid, settled: true, approval: { ownerId: OWNER, replayed: false },
            lensDecision: { reused: false }, attest: { decision: 'Satisfied' }, execution: { status: 'Executed' } });
        expect(record.completedAt).toEqual(expect.any(String));
        const activities = pool.run('2026-10-22-densifier-01').summary.activities;
        expect(activities.map(activity => activity.action.type)).toEqual(['decide', 'lens-decision', 'attest', 'execute']);
        expect(activities.every(activity => activity.entity?.type === 'agreement' && activity.entity.id === agreement.cid)).toBe(true);
        expect(world.onchainCalls).toEqual([{ cid: agreement.cid, chain: 'solana', cluster: 'devnet', account: agreement.account, signature: null }]);

        // The next run reads the settled record and inspects nothing.
        const signed = chain.signed().length;
        const next = { persona, runId: '2026-10-23-densifier-01', day: '2026-10-23', run: null };
        const nextPool = createLedgerPool({ runs: [
            runRow('2026-10-20-densifier-01', '2026-10-20', [agreement]),
            pool.run('2026-10-22-densifier-01'),
            { run_id: '2026-10-23-densifier-01', persona: persona.name, day: '2026-10-23', summary: {} }
        ] });
        next.run = nextPool.run('2026-10-23-densifier-01');
        const second = await settle(nextPool, [next]);
        expect(second.report).toEqual([]);
        expect(chain.signed()).toHaveLength(signed);
    });

    it('lists what it would settle in a dry run without loading a key or writing a checkpoint', async () => {
        const agreement = await earlierAgreement('Dry');
        const pool = createLedgerPool({ runs: [runRow('2026-10-20-densifier-01', '2026-10-20', [agreement])] });
        const { report, loadSigner, failures } = await settle(pool, [{ persona, runId: '2026-10-22-densifier-01', day: '2026-10-22', run: null }], { dryRun: true });
        expect(failures).toEqual([]);
        expect(report).toEqual(['densifier-01: would settle 1']);
        expect(loadSigner).not.toHaveBeenCalled();
        expect(pool.getCalls().some(call => /UPDATE consensus\.agent_run/.test(call.sql))).toBe(false);
        expect(chain.agreement(agreement.account).status).toBe('Active');
    });

    it('defers agreements when the picks leave no signed actions, and reports a failed step without stopping the run', async () => {
        const agreement = await earlierAgreement('Starved');
        const pool = createLedgerPool({ runs: [
            runRow('2026-10-20-densifier-01', '2026-10-20', [agreement]),
            { run_id: '2026-10-22-densifier-01', persona: persona.name, day: '2026-10-22', summary: {} }
        ] });
        const entry = () => ({ persona, runId: '2026-10-22-densifier-01', day: '2026-10-22', run: pool.run('2026-10-22-densifier-01') });
        const starved = await settle(pool, [entry()], { plannedActions: 14 });
        expect(starved.report).toEqual(['densifier-01: settled 0 (1 deferred)']);
        expect(chain.agreement(agreement.account).status).toBe('Active');

        // The lens member is unreachable: the step fails, the failure is reported, nothing is executed.
        const broken = await settle(pool, [entry()], { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
        expect(broken.failures).toEqual([expect.stringMatching(new RegExp(`^densifier-01 settlement ${agreement.cid}: `))]);
        expect(broken.report).toEqual(['densifier-01: settled 0/1']);
        expect(chain.agreement(agreement.account).status).toBe('Active');
    });

    it('expires its own agreement after the deadline', async () => {
        const agreement = await earlierAgreement('Lapsed');
        // The deadline passed: move the account's deadline into the past on the emulated chain.
        const state = chain.agreement(agreement.account);
        chain.putAgreement(agreement.account, {
            ...state, status: state.statusCode, decision: state.decisionCode, decisionAttestation: undefined, decisionHash: undefined, deadline: NOW - 60
        });
        const pool = createLedgerPool({ runs: [
            runRow('2026-10-20-densifier-01', '2026-10-20', [agreement]),
            { run_id: '2026-10-22-densifier-01', persona: persona.name, day: '2026-10-22', summary: {} }
        ] });
        const { failures } = await settle(pool, [{ persona, runId: '2026-10-22-densifier-01', day: '2026-10-22', run: pool.run('2026-10-22-densifier-01') }]);
        expect(failures).toEqual([]);
        expect(chain.agreement(agreement.account)).toMatchObject({ status: 'Expired', escrowLamports: 0n });
        expect(pool.run('2026-10-22-densifier-01').summary.settlements[agreement.account]).toMatchObject({ settled: true, expiry: { status: 'Expired' } });
        expect(await world.decisionStore.list(agreement.cid)).toEqual([]);
    });
});
