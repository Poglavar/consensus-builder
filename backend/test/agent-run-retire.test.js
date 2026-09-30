// The daily proposer's retire step against a fake chain: read-only inspection decides which of
// cancel → resolve → claim a proposal still needs, and execution signs them in that order through
// the action engine, checkpointing after each step. Adapters are stubbed; the proposal account is
// real Borsh bytes read through decodeProposalState.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { executeRetirement, inspectRetirement } from '../agents/lifecycle-actions.js';
import { planRetirements } from '../agents/run-policy.js';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const actionEngineApi = require('../../frontend/js/agent-action-engine.js');

function string(value) {
    const text = Buffer.from(value);
    const length = Buffer.alloc(4); length.writeUInt32LE(text.length);
    return Buffer.concat([length, text]);
}

function stringVector(values) {
    const count = Buffer.alloc(4); count.writeUInt32LE(values.length);
    return Buffer.concat([count, ...values.map(string)]);
}

// Proposal v2 bytes: v1 prefix, lens, bump, verdict_may_execute.
function proposalBytes(status, owner, accepted = [], lens = []) {
    const lensCount = Buffer.alloc(4); lensCount.writeUInt32LE(lens.length);
    return Buffer.concat([
        Buffer.alloc(8), Buffer.alloc(8), owner.toBuffer(), stringVector(['335550:1']),
        Buffer.from([1]), string(''), Buffer.from([1, status]), Buffer.alloc(24),
        stringVector(accepted), lensCount, ...lens.map(key => key.toBuffer()), Buffer.from([255, 0])
    ]);
}

// One fake chain holding proposals by PDA plus market/position state the stubs mutate.
function fakeChain(owner) {
    const proposals = new Map();
    const markets = new Map();
    const positions = new Map();
    const calls = [];
    const connection = {
        async getAccountInfo(key) {
            const entry = proposals.get(key.toBase58());
            return entry ? { data: proposalBytes(entry.status, entry.owner ?? owner, entry.accepted, entry.lens) } : null;
        }
    };
    const readers = {
        readMarket: async (_connection, pda) => markets.get(pda) ?? null,
        readPosition: async (_connection, pda) => positions.get(pda) ?? null
    };
    const adapters = {
        async expireWithVerdict({ proposalAccount, lifecycle, sourceObservedAt }) {
            calls.push(['expire', proposalAccount, lifecycle.key, sourceObservedAt]);
            proposals.get(proposalAccount).status = 3;
            return { replayed: false, signature: `expire-${proposalAccount.slice(0, 4)}`, status: 'expired', verdictAttestation: 'verdict-1' };
        },
        async cancelProposal({ proposalAccount }) {
            calls.push(['cancel', proposalAccount]);
            proposals.get(proposalAccount).status = 2;
            return { replayed: false, signature: `cancel-${proposalAccount.slice(0, 4)}`, status: 'cancelled' };
        },
        async resolveProposalMarket({ proposalAccount }) {
            calls.push(['resolve', proposalAccount]);
            Object.assign(markets.get(proposalAccount), { resolved: true, outcome: 0 });
            return { replayed: false, signature: `resolve-${proposalAccount.slice(0, 4)}`, outcome: 'NO' };
        },
        async claimProposalMarket({ proposalAccount, side }) {
            calls.push(['claim', proposalAccount, side]);
            positions.get(proposalAccount).claimed = true;
            return { replayed: false, signature: `claim-${proposalAccount.slice(0, 4)}`, claimed: true };
        }
    };
    return { proposals, markets, positions, calls, connection, readers, adapters };
}

function addProposal(chain, { status = 0, accepted = [], owner, yes = 250000n, no = 0n, market = true, lens = [] } = {}) {
    const pda = Keypair.generate().publicKey.toBase58();
    chain.proposals.set(pda, { status, accepted, owner, lens });
    if (market) {
        chain.markets.set(pda, { yesPool: yes, noPool: no, resolved: false, outcome: 0 });
        if (yes > 0n) chain.positions.set(pda, { amount: yes, claimed: false });
    }
    return pda;
}

function engine(activities) {
    return actionEngineApi.createEngine({
        decisionProviders: { algorithm: (_actor, context) => context.action },
        actionHandlers: { '*': (_actor, _action, context) => context.execute() },
        onActivity: activity => activities.push(activity)
    });
}

describe('daily proposer retire step', () => {
    it('cancels, resolves NO and reclaims the YES stake in order, checkpointing each step', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const pda = addProposal(chain);
        const proposal = { proposalId: 'agent-densifier-01-2026-09-01-1', proposalPda: pda, sourceRunId: '2026-09-01-densifier-01', sourceDay: '2026-09-01' };

        const inspection = await inspectRetirement({ connection: chain.connection, owner: signer.publicKey.toBase58(), proposal, readers: chain.readers });
        expect(inspection).toMatchObject({ state: 'active', steps: ['cancel', 'resolve', 'claim'], expectedRefund: '250000' });

        const [item] = planRetirements([inspection], { runDay: '2026-10-01', actionBudget: 3 }).selected;
        const activities = [];
        const runtime = engine(activities);
        const actor = { id: 'densifier-01', name: 'densifier-01', controller: 'algorithm', wallet: signer.publicKey.toBase58() };
        const checkpoints = [];
        const record = await executeRetirement({
            connection: chain.connection, ownerKeypair: signer, item, readers: chain.readers, adapters: chain.adapters,
            perform: async (action, execute) => (await runtime.run(actor, { action, execute, source: 'live' })).outcome,
            checkpoint: async (snapshot) => { checkpoints.push(snapshot); }
        });

        expect(chain.calls).toEqual([['cancel', pda], ['resolve', pda], ['claim', pda, 'yes']]);
        expect(activities.map(activity => activity.action?.type ?? activity.type)).toEqual(['cancel', 'resolve', 'claim']);
        expect(checkpoints).toHaveLength(3);
        expect(checkpoints[0]).toMatchObject({ proposalPda: pda, sourceDay: '2026-09-01', ageDays: 30, cancel: { signature: expect.stringMatching(/^cancel-/) } });
        expect(checkpoints[0]).not.toHaveProperty('resolution');
        expect(checkpoints[1].resolution).toMatchObject({ outcome: 'NO' });
        expect(checkpoints[2].claim).toMatchObject({ claimed: true, signature: expect.stringMatching(/^claim-/) });
        expect(record).toEqual(checkpoints[2]);

        // A same-day rerun reads the chain and finds nothing left to do.
        const again = await inspectRetirement({ connection: chain.connection, owner: signer.publicKey.toBase58(), proposal, readers: chain.readers });
        expect(again).toMatchObject({ state: 'retired', steps: [] });
        expect(planRetirements([again], { runDay: '2026-10-01', actionBudget: 3 }).skipped[0].reason).toBe('already-retired');
    });

    it('leaves proposals with acceptances, younger than the threshold, executed or not ours alone', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const owner = signer.publicKey.toBase58();
        const accepted = addProposal(chain, { accepted: ['335550:1'] });
        const young = addProposal(chain);
        const executed = addProposal(chain, { status: 1 });
        const foreign = addProposal(chain, { owner: Keypair.generate().publicKey });
        const inspections = [];
        for (const [proposalPda, sourceDay] of [[accepted, '2026-09-01'], [young, '2026-09-29'], [executed, '2026-09-01'], [foreign, '2026-09-01']]) {
            inspections.push(await inspectRetirement({ connection: chain.connection, owner, proposal: { proposalId: proposalPda, proposalPda, sourceDay }, readers: chain.readers }));
        }
        const plan = planRetirements(inspections, { runDay: '2026-10-01', actionBudget: 12 });
        expect(plan.selected).toEqual([]);
        expect(plan.skipped.map(item => [item.proposalPda, item.reason])).toEqual(expect.arrayContaining([
            [accepted, 'has-acceptances'], [young, 'too-young'], [executed, 'executed'], [foreign, 'foreign']
        ]));
        expect(chain.calls).toEqual([]);
    });

    it('does not claim when NO stakers won the YES stake, and resumes a half-retired proposal', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const lost = addProposal(chain, { status: 2, no: 100000n });
        const inspection = await inspectRetirement({ connection: chain.connection, owner: signer.publicKey.toBase58(), proposal: { proposalId: 'lost', proposalPda: lost, sourceDay: '2026-09-30' }, readers: chain.readers });
        // Already cancelled (a previous run stopped after cancel): only resolve remains, age is irrelevant.
        expect(inspection).toMatchObject({ state: 'cancelled', steps: ['resolve'], expectedRefund: '0' });
        expect(inspection.note).toMatch(/lost/);
        const [item] = planRetirements([inspection], { runDay: '2026-10-01', actionBudget: 3 }).selected;
        const checkpoints = [];
        await executeRetirement({
            connection: chain.connection, ownerKeypair: signer, item, readers: chain.readers, adapters: chain.adapters,
            record: { cancel: { signature: 'earlier-cancel' } },
            perform: async (_action, execute) => execute(),
            checkpoint: async (snapshot) => { checkpoints.push(snapshot); }
        });
        expect(chain.calls).toEqual([['resolve', lost]]);
        expect(checkpoints.at(-1)).toMatchObject({ cancel: { signature: 'earlier-cancel' }, resolution: { outcome: 'NO' } });
    });

    it('cancels a proposal whose market was never opened without resolving or claiming', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const bare = addProposal(chain, { market: false });
        const inspection = await inspectRetirement({ connection: chain.connection, owner: signer.publicKey.toBase58(), proposal: { proposalId: 'bare', proposalPda: bare, sourceDay: '2026-09-01' }, readers: chain.readers });
        expect(inspection.steps).toEqual(['cancel']);
    });

    it('expires by a lifecycle member verdict when that member is in the lens, and cancels otherwise', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const member = Keypair.generate().publicKey;
        const owner = signer.publicKey.toBase58();
        const inLens = addProposal(chain, { lens: [Keypair.generate().publicKey, member] });
        const notInLens = addProposal(chain, { lens: [Keypair.generate().publicKey] });
        const lifecycleMember = { key: member.toBase58() };
        const expiring = await inspectRetirement({ connection: chain.connection, owner, proposal: { proposalId: 'a', proposalPda: inLens, sourceDay: '2026-09-01' }, readers: chain.readers, lifecycleMember });
        expect(expiring).toMatchObject({ state: 'active', steps: ['expire', 'resolve', 'claim'] });
        const cancelling = await inspectRetirement({ connection: chain.connection, owner, proposal: { proposalId: 'b', proposalPda: notInLens, sourceDay: '2026-09-01' }, readers: chain.readers, lifecycleMember });
        expect(cancelling.steps).toEqual(['cancel', 'resolve', 'claim']);
        // Without a configured member nothing expires, whatever the lens says.
        expect((await inspectRetirement({ connection: chain.connection, owner, proposal: { proposalId: 'a', proposalPda: inLens, sourceDay: '2026-09-01' }, readers: chain.readers })).steps[0]).toBe('cancel');

        const [item] = planRetirements([expiring], { runDay: '2026-10-01', actionBudget: 3 }).selected;
        const checkpoints = [];
        const lifecycle = { serviceUrl: 'http://lens.test', operatorToken: 't', key: member.toBase58(), afterDays: 7 };
        await expect(executeRetirement({
            connection: chain.connection, ownerKeypair: signer, item, readers: chain.readers, adapters: chain.adapters,
            perform: async (_action, execute) => execute(), checkpoint: async () => {}
        })).rejects.toThrow(/lifecycle lens member config/);
        const activities = [];
        const runtime = engine(activities);
        const actor = { id: 'densifier-01', name: 'densifier-01', controller: 'algorithm', wallet: owner };
        const record = await executeRetirement({
            connection: chain.connection, ownerKeypair: signer, item, readers: chain.readers, adapters: chain.adapters, lifecycle,
            perform: async (action, execute) => (await runtime.run(actor, { action, execute, source: 'live' })).outcome,
            checkpoint: async (snapshot) => { checkpoints.push(snapshot); }
        });
        // 2026-09-01T00:00Z + 7 days = 2026-09-08T00:00Z: the policy's expiry instant, not the run time.
        expect(chain.calls).toEqual([['expire', inLens, member.toBase58(), Date.parse('2026-09-08T00:00:00Z') / 1000], ['resolve', inLens], ['claim', inLens, 'yes']]);
        expect(activities.map(activity => activity.action.type)).toEqual(['verdict', 'resolve', 'claim']);
        expect(record.expiry).toMatchObject({ status: 'expired', verdictAttestation: 'verdict-1' });
        expect(record).not.toHaveProperty('cancel');

        const again = await inspectRetirement({ connection: chain.connection, owner, proposal: { proposalId: 'a', proposalPda: inLens, sourceDay: '2026-09-01' }, readers: chain.readers, lifecycleMember });
        expect(again).toMatchObject({ state: 'retired', steps: [] });
    });

    it('finishes an expired proposal whose market is still open', async () => {
        const signer = Keypair.generate();
        const chain = fakeChain(signer.publicKey);
        const expired = addProposal(chain, { status: 3 });
        const inspection = await inspectRetirement({ connection: chain.connection, owner: signer.publicKey.toBase58(), proposal: { proposalId: 'x', proposalPda: expired, sourceDay: '2026-09-30' }, readers: chain.readers });
        expect(inspection).toMatchObject({ state: 'expired', steps: ['resolve', 'claim'] });
        expect(planRetirements([inspection], { runDay: '2026-10-01', actionBudget: 3 }).selected).toHaveLength(1);
    });
});
