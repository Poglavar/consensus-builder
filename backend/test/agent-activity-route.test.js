// The public activity feeds on agreements (routes/agent-activity.js): agreements proposed and designs
// published to the index, the agreement program's instructions (decoded by discriminator) and the
// market and pledge instructions whose subject is an agreement account, mapped to the agreement's CID
// through the account index, and the agent runs' recorded activities, merged into one envelope whose
// entity is { type: 'agreement' | 'design', id: <cid> }; plus the landing feed, the run index and its
// drill-down. The pool and the transaction decoder are fakes; no database or RPC is touched.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import {
    ACTIVITY_SCAN_WINDOW, activityFilters, agreementAccountIndex, agreementEvents, chainEvents, controllerOf, designEvents,
    matchesActivityFilters, recentWithBets, runDetail, runEvents, setupAgentActivityRoute
} from '../routes/agent-activity.js';
import { AGREEMENT_PROGRAM_ID, AgreementClient, agreementAccountOf } from '../agreements/onchain.js';
import { encodeBase58 } from '../solana/tx-decoder.js';
import { cidOfObject } from '../cid.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const marketClient = require('../../frontend/js/solana/market-client.js').configure({ web3 });
const MARKET_PROGRAM_ID = marketClient.constants.PROGRAM_ID;

const SPONSOR = Keypair.generate().publicKey.toBase58();
const OTHER_SPONSOR = Keypair.generate().publicKey.toBase58();
const HUMAN = Keypair.generate().publicKey.toBase58();
const AGREEMENT = cidOfObject({ schema: 'agreement/v1', title: 'Pocket park deal' });
const RECORDED = cidOfObject({ schema: 'agreement/v1', title: 'Recorded deal' });
const DESIGN = cidOfObject({ schema: 'design/v1', title: 'Pocket park' });
const ACCOUNT = agreementAccountOf(AGREEMENT, SPONSOR);
// A recorded account the index holds for RECORDED (e.g. minted under another program id); it wins over the derived one.
const RECORDED_ACCOUNT = Keypair.generate().publicKey.toBase58();
const MARKET = marketClient.getMarketPda(ACCOUNT)[0].toBase58();
const BOUNDS = { west: 15.9, south: 45.8, east: 15.92, north: 45.82 };

// consensus.agreement rows as AGREEMENT_ROWS selects them.
const agreementRow = (cid, extra = {}) => ({
    cid, city: 'zagreb', title: cid === AGREEMENT ? 'Pocket park deal' : 'Recorded deal', created_at: '2026-10-21T10:00:00Z',
    onchain: null, sponsor: SPONSOR, design_goal: 'park', design_bounds: BOUNDS, ...extra
});
const ROWS = [agreementRow(AGREEMENT), agreementRow(RECORDED, { onchain: { account: RECORDED_ACCOUNT }, design_bounds: null, created_at: '2026-10-21T11:00:00Z' })];

const agreementIx = (name, account, extra = {}) => {
    const data = name === 'fund' ? AgreementClient.encodeFundData(5000n)
        : name === 'create' ? AgreementClient.encodeCreateData({ cid: AGREEMENT, lens: HUMAN, payout: SPONSOR, requiredLamports: 5000n })
            : AgreementClient[`encode${name[0].toUpperCase()}${name.slice(1)}Data`]();
    return { index: 0, inner: false, program: { address: AGREEMENT_PROGRAM_ID, name: null }, data: encodeBase58(Buffer.from(data)), accounts: [{ address: account }, { address: SPONSOR, signer: true }], ...extra };
};
const marketIx = (action, accounts, args = {}) => ({ index: 0, inner: false, program: { name: 'proposal_market', address: MARKET_PROGRAM_ID }, action, args, accounts });
const tx = (signature, instructions, extra = {}) => ({ signature, slot: 42, status: 'success', time: '2026-10-21T12:00:00Z', feePayer: { address: HUMAN, label: null }, instructions, ...extra });

// A pool answering the feeds' statements by what they select.
function poolFor({ proposed = ROWS, withAccount = ROWS, transactions = [], marketTransactions = [], runs = [], designs = [], costs = [] } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (sql.includes('consensus.agent_cost')) return { rows: costs };
            if (sql.includes('consensus.agent_run')) return { rows: runs };
            if (sql.includes('touched_addresses')) return { rows: marketTransactions };
            if (sql.includes('consensus.solana_transaction')) return { rows: transactions };
            if (sql.includes('FROM consensus.design') && !sql.includes('consensus.agreement')) return { rows: designs };
            if (sql.includes("a.onchain IS NOT NULL OR a.content->>'sponsor' IS NOT NULL")) return { rows: withAccount };
            if (sql.includes('FROM consensus.agreement a')) return { rows: proposed };
            if (sql.includes('GROUP BY city')) return { rows: [] };
            throw new Error(`unexpected statement ${sql}`);
        }
    };
}

function appFor(pool, decode = raw => raw) {
    const app = express();
    setupAgentActivityRoute(app, pool, { book: { entryFor: () => null, entries: [] }, idls: {}, decode });
    return app;
}

describe('agreementAccountIndex', () => {
    it('maps the recorded account, else the one sponsor and CID derive, and each one\'s market PDA, to the agreement', () => {
        const index = agreementAccountIndex([...ROWS, agreementRow(cidOfObject({ none: true }), { sponsor: null })]);
        expect(index.get(ACCOUNT)).toEqual({ cid: AGREEMENT, account: ACCOUNT });
        expect(index.get(MARKET)).toEqual({ cid: AGREEMENT, account: ACCOUNT });
        expect(index.get(RECORDED_ACCOUNT)).toEqual({ cid: RECORDED, account: RECORDED_ACCOUNT });
        expect(index.has(agreementAccountOf(RECORDED, SPONSOR))).toBe(false);
        // An agreement with neither a recorded account nor a sponsor has none: two agreements, two accounts, two markets.
        expect(index.size).toBe(4);
    });
});

describe('chainEvents', () => {
    const index = agreementAccountIndex(ROWS);

    it('decodes every agreement program instruction by its discriminator into the agreement\'s action', () => {
        const names = ['create', 'fund', 'attest', 'execute', 'cancel', 'expire'];
        const rows = names.map((name, at) => ({ raw: tx(`${name}-tx`, [agreementIx(name, ACCOUNT, { index: at })]) }));
        const events = chainEvents(rows, { agreementsByAccount: index, decode: raw => raw, book: { entryFor: () => null } });
        expect(events.map(event => event.action.type)).toEqual(['mint', 'fund', 'attest', 'execute', 'cancel', 'expire']);
        expect(events[1].action).toEqual({ type: 'fund', agreementCid: AGREEMENT, lamports: '5000' });
        expect(events[0]).toMatchObject({
            id: 'chain:create-tx:0:mint', source: 'live', entity: { type: 'agreement', id: AGREEMENT }, agreementAccount: ACCOUNT, ok: true,
            actor: { id: SPONSOR, kind: 'human', controller: 'human', wallet: SPONSOR }, transaction: 'create-tx',
            message: `${SPONSOR} submitted mint for agreement ${AGREEMENT}.`,
            provenance: { source: 'solana_transaction', slot: 42, program: AGREEMENT_PROGRAM_ID, instruction: 'create' }
        });
    });

    it('maps market and pledge instructions by their agreement account, or a market PDA, and keeps their side and amount', () => {
        const rows = [
            { raw: tx('stake-tx', [marketIx('stake', [{ role: 'market', address: MARKET }, { role: 'proposal', address: ACCOUNT }, { role: 'staker', address: HUMAN, signer: true }], { side: 1, amount: '1500000' })]) },
            { raw: tx('claim-tx', [marketIx('claim', [{ role: 'market', address: MARKET }, { role: 'claimer', address: HUMAN, signer: true }])]) },
            { raw: tx('donate-tx', [{ index: 0, inner: false, program: { name: 'proposal_pledge', address: 'pledge-program' }, action: 'donate', args: { amount: '50000' },
                accounts: [{ role: 'escrow', address: 'escrow' }, { role: 'proposal', address: RECORDED_ACCOUNT }, { role: 'donor', address: HUMAN, signer: true }] }]) }
        ];
        const events = chainEvents(rows, { agreementsByAccount: index, decode: raw => raw, book: { entryFor: () => null } });
        expect(events.map(event => [event.action, event.entity.id])).toEqual([
            [{ type: 'stake', agreementCid: AGREEMENT, side: 'yes', amount: '1.5' }, AGREEMENT],
            [{ type: 'claim', agreementCid: AGREEMENT }, AGREEMENT],
            [{ type: 'donate', agreementCid: RECORDED, amount: '0.05' }, RECORDED]
        ]);
        expect(events[0].actor).toMatchObject({ id: HUMAN, kind: 'human' });
    });

    it('leaves out inner instructions, unknown discriminators, foreign accounts and other programs\' instructions', () => {
        const foreign = agreementAccountOf(AGREEMENT, OTHER_SPONSOR);
        const unknown = { ...agreementIx('create', ACCOUNT), data: encodeBase58(Buffer.alloc(8, 7)) };
        const rows = [{ raw: tx('mixed-tx', [
            { ...agreementIx('execute', ACCOUNT), inner: true },
            unknown,
            agreementIx('execute', foreign),
            agreementIx('execute', agreementAccountOf(RECORDED, SPONSOR)),
            marketIx('create_market', [{ role: 'market', address: 'not-indexed' }, { role: 'proposal', address: 'not-an-agreement' }]),
            { index: 5, inner: false, program: { name: 'proposal_nft', address: 'nft' }, action: 'accept_proposal', accounts: [{ role: 'proposal', address: ACCOUNT }] }
        ]) }, { raw: { status: 'success' } }];
        expect(chainEvents(rows, { agreementsByAccount: index, decode: raw => raw, book: { entryFor: () => null } })).toEqual([]);
    });

    it('names an agent by its persona from the address book and marks a failed transaction', () => {
        const book = { entryFor: address => (address === SPONSOR ? { persona: 'densifier-01' } : null) };
        const [event] = chainEvents([{ raw: tx('failed-tx', [agreementIx('execute', ACCOUNT)], { status: 'failed' }) }], { agreementsByAccount: index, decode: raw => raw, book });
        expect(event).toMatchObject({ ok: false, actor: { id: SPONSOR, name: 'densifier-01', kind: 'agent', controller: 'algorithm' } });
    });
});

describe('index events', () => {
    it('makes one propose event per agreement and one design event per design, when the index received them', () => {
        expect(agreementEvents([agreementRow(AGREEMENT)])).toEqual([{
            id: `agreement:${AGREEMENT}:proposed`, source: 'live', action: { type: 'propose', agreementCid: AGREEMENT },
            entity: { type: 'agreement', id: AGREEMENT }, ok: true, transaction: null,
            occurredAt: '2026-10-21T10:00:00Z', recordedAt: '2026-10-21T10:00:00Z', message: 'Agreement Pocket park deal was proposed.'
        }]);
        const created = new Date('2026-10-21T09:00:00Z');
        expect(designEvents([{ cid: DESIGN, title: null, created_at: created }])[0]).toMatchObject({
            id: `design:${DESIGN}:published`, action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN },
            occurredAt: '2026-10-21T09:00:00.000Z', message: `Design ${DESIGN} was published.`
        });
    });
});

describe('GET /activity/recent', () => {
    it('serves proposed agreements and confirmed outcomes, bets and support, newest first, placed on the map', async () => {
        const pool = poolFor({
            transactions: [
                { raw: tx('execute-tx', [agreementIx('execute', ACCOUNT)], { time: '2026-10-21T13:00:00Z' }), signature: 'execute-tx' },
                { raw: tx('fund-tx', [agreementIx('fund', ACCOUNT)], { time: '2026-10-21T13:30:00Z' }), signature: 'fund-tx' },
                { raw: tx('failed-tx', [agreementIx('cancel', ACCOUNT)], { status: 'failed', time: '2026-10-21T14:00:00Z' }), signature: 'failed-tx' }
            ],
            marketTransactions: [{ raw: tx('stake-tx', [marketIx('stake', [{ role: 'proposal', address: ACCOUNT }], { side: 0, amount: '20000' })], { time: '2026-10-21T12:30:00Z' }), signature: 'stake-tx' }]
        });
        const response = await request(appFor(pool)).get('/activity/recent?limit=4');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toContain('no-store');
        // fund is detail for the explorer; a failed cancel is no outcome.
        expect(response.body.events.map(event => event.action.type)).toEqual(['execute', 'stake', 'propose', 'propose']);
        expect(response.body.events[0]).toMatchObject({
            action: { type: 'execute', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT },
            agreementName: 'Pocket park deal', designGoal: 'park', cityId: 'zagreb', location: { lat: 45.81, lon: 15.91 }, transaction: 'execute-tx'
        });
        expect(response.body.events[1].action).toEqual({ type: 'stake', agreementCid: AGREEMENT, side: 'no', amount: '0.02' });
        expect(response.body.events.find(event => event.entity.id === RECORDED)).not.toHaveProperty('location');
        expect(pool.calls.find(call => call.sql.includes('ORDER BY a.created_at')).params).toEqual([4]);
        expect(pool.calls.find(call => call.sql.includes('consensus.solana_transaction') && !call.sql.includes('touched_addresses')).params).toEqual([16]);
        expect(pool.calls.find(call => call.sql.includes('touched_addresses')).params).toEqual([MARKET_PROGRAM_ID, 8]);
    });

    it('defaults to twelve, caps at thirty, and answers 500 when the database fails', async () => {
        const pool = poolFor();
        await request(appFor(pool)).get('/activity/recent');
        await request(appFor(pool)).get('/activity/recent?limit=999');
        expect(pool.calls.filter(call => call.sql.includes('ORDER BY a.created_at')).map(call => call.params)).toEqual([[12], [30]]);
        const failing = { query: async () => { throw new Error('connection refused'); } };
        const response = await request(appFor(failing)).get('/activity/recent');
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'Failed to read recent activity', source: 'live' });
    });
});

describe('recentWithBets', () => {
    it('keeps up to half the landing feed for bets when a burst of new agreements is newer', () => {
        const at = minute => `2026-10-10T10:${String(minute).padStart(2, '0')}:00Z`;
        const proposed = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, action: { type: 'propose' }, occurredAt: at(30 + i) }));
        const bets = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, action: { type: i % 2 ? 'stake' : 'claim' }, occurredAt: at(i) }));
        const feed = recentWithBets([...bets, ...proposed], 12);
        expect(feed).toHaveLength(12);
        expect(feed.filter(event => event.id.startsWith('b')).map(event => event.id)).toEqual(['b7', 'b6', 'b5', 'b4', 'b3', 'b2']);
        expect(feed.slice(0, 6).map(event => event.id)).toEqual(['p19', 'p18', 'p17', 'p16', 'p15', 'p14']);
        expect(recentWithBets(bets, 12)).toHaveLength(8);
        expect(recentWithBets([...proposed, bets[0]], 12).filter(event => event.action.type === 'propose')).toHaveLength(11);
    });
});

// A proposer run: the design and agreement it published for its pick, the mint and the stake.
const run = {
    run_id: '2026-10-21-densifier-01', persona: 'densifier-01', mode: 'live', status: 'done', stage: 'staked',
    started_at: '2026-10-21T08:00:00Z', updated_at: '2026-10-21T08:05:00Z',
    summary: {
        controller: 'algorithm', lens: 'LensKey1111111111111111111111111111111111111',
        picks: [{ candidateId: 'c1', name: 'Courtyard homes', rationale: 'Six storeys on a parcel it owns.' }],
        designs: { c1: { cid: DESIGN } }, agreements: { c1: { cid: AGREEMENT } }, mints: { c1: { account: ACCOUNT } },
        activities: [
            { action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN }, actor: { id: 'densifier-01', name: 'densifier-01', controller: 'algorithm' }, recordedAt: '2026-10-21T08:01:00Z' },
            { action: { type: 'propose', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, actor: { id: 'densifier-01', name: 'densifier-01' }, recordedAt: '2026-10-21T08:02:00Z' },
            { action: { type: 'mint', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'create-tx', actor: { id: 'densifier-01', name: 'densifier-01' }, recordedAt: '2026-10-21T08:03:00Z' },
            { action: { type: 'stake', agreementCid: AGREEMENT, side: 'yes' }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'stake-tx', actor: { id: 'other-persona', name: 'other-persona' }, recordedAt: '2026-10-21T08:04:00Z' }
        ]
    }
};

describe('agent run events', () => {
    it('projects a run\'s recorded activities on designs and agreements with the rationale of the pick behind them', () => {
        const book = { entries: [{ kind: 'wallet', persona: 'densifier-01', address: SPONSOR }] };
        const events = runEvents(run, book);
        expect(events.map(event => [event.id, event.action.type, event.entity.type])).toEqual([
            [`activity:${run.run_id}:0`, 'design', 'design'], [`activity:${run.run_id}:1`, 'propose', 'agreement'],
            [`activity:${run.run_id}:2`, 'mint', 'agreement'], [`activity:${run.run_id}:3`, 'stake', 'agreement']
        ]);
        expect(events.every(event => event.rationale === 'Six storeys on a parcel it owns.' && event.runId === run.run_id)).toBe(true);
        expect(events[2].provenance).toEqual({ runId: run.run_id, stage: 'staked', mode: 'live', transaction: 'create-tx' });
        // The run's wallet fills its own persona's events, never another actor's.
        expect(events[0].actor.wallet).toBe(SPONSOR);
        expect(events[3].actor).not.toHaveProperty('wallet');
    });

    it('shows that a run ran when it recorded no activity, without inventing model provenance', () => {
        const [event] = runEvents({ ...run, status: 'done', stage: 'chosen', summary: { controller: 'algorithm', picks: [] } });
        expect(event).toMatchObject({ id: `run:${run.run_id}:chosen`, action: { type: 'run_status', stage: 'chosen' }, actor: { controller: 'algorithm' }, model: null });
        expect(event.message).toBe(`densifier-01 agent run done: chosen.`);
    });

    it('keeps each pick\'s design, agreement and account, the lens and exact costs in the drill-down', () => {
        const detail = runDetail(run, [{
            item: 'c1', provider: 'anthropic', model: 'claude-x', batch_id: 'msgbatch-1', input_tokens: 120, output_tokens: 45,
            cache_read_tokens: 0, cache_creation_tokens: 0, usd: '0.005400', created_at: '2026-10-21T08:03:00Z'
        }]);
        expect(detail).toMatchObject({
            id: run.run_id, role: 'proposer', controller: 'algorithm', modelCostUsd: 0.0054, lens: run.summary.lens,
            costs: [{ usd: 0.0054, inputTokens: 120, batchId: 'msgbatch-1' }]
        });
        expect(detail.picks).toEqual([{ candidateId: 'c1', name: 'Courtyard homes', rationale: 'Six storeys on a parcel it owns.', designCid: DESIGN, agreementCid: AGREEMENT, agreementAccount: ACCOUNT }]);
    });

    it('recognises legacy LLM runs from their batch and cost evidence', () => {
        expect(controllerOf({ batchId: 'msgbatch-legacy', pickCostUsd: 0.0054 })).toBe('llm');
        expect(controllerOf({ decisionResult: { controller: 'collect' } })).toBe('collect');
        expect(controllerOf({})).toBe('algorithm');
    });
});

describe('GET /agent/activity', () => {
    const stakeRow = { raw: tx('human-stake-tx', [marketIx('stake', [{ role: 'proposal', address: ACCOUNT }, { role: 'staker', address: HUMAN, signer: true }], { side: 1, amount: '10000' })], { time: '2026-10-21T09:00:00Z' }) };
    const mintRow = { raw: tx('create-tx', [agreementIx('create', ACCOUNT)], { time: '2026-10-21T08:03:30Z' }) };
    const pool = () => poolFor({
        runs: [run], transactions: [mintRow, stakeRow], proposed: [agreementRow(AGREEMENT)],
        designs: [{ cid: DESIGN, city: 'zagreb', goal: 'park', title: 'Pocket park', bounds: BOUNDS, created_at: '2026-10-21T07:59:00Z' }]
    });

    it('merges index, chain and run events: a run\'s record replaces the index\'s and the decoded chain\'s copy', async () => {
        const response = await request(appFor(pool())).get('/agent/activity');
        expect(response.status).toBe(200);
        const keyed = response.body.events.map(event => `${event.action.type}:${event.runId ?? '-'}`);
        // One design, one propose and one mint (the run's), the run's stake and the human's decoded stake.
        expect(keyed.sort()).toEqual(['design:2026-10-21-densifier-01', 'mint:2026-10-21-densifier-01', 'propose:2026-10-21-densifier-01', 'stake:-', 'stake:2026-10-21-densifier-01']);
        const design = response.body.events.find(event => event.action.type === 'design');
        expect(design).toMatchObject({ designName: 'Pocket park', designGoal: 'park', cityId: 'zagreb', location: { lat: 45.81, lon: 15.91 } });
        const chainStake = response.body.events.find(event => event.action.type === 'stake' && !event.runId);
        expect(chainStake).toMatchObject({ actor: { id: HUMAN }, agreementName: 'Pocket park deal', action: { side: 'yes', amount: '0.01' } });
        expect(response.body).toMatchObject({ count: 5, source: 'live' });
        expect(response.body).not.toHaveProperty('scanWindow');
    });

    it('filters by agreement, action, actor, run and source over a wider bounded window', async () => {
        const filtered = pool();
        const byAgreement = await request(appFor(filtered)).get(`/agent/activity?agreement=${AGREEMENT}`);
        expect(byAgreement.body.events.map(event => event.action.type).sort()).toEqual(['mint', 'propose', 'stake', 'stake']);
        expect(byAgreement.body).toMatchObject({ filters: { agreement: AGREEMENT }, scanWindow: ACTIVITY_SCAN_WINDOW });
        expect(filtered.calls.find(call => call.sql.includes('consensus.agent_run')).params).toEqual([ACTIVITY_SCAN_WINDOW]);
        const stakes = await request(appFor(pool())).get(`/agent/activity?action=stake&run=${run.run_id}`);
        expect(stakes.body.events).toHaveLength(1);
        expect(stakes.body.events[0]).toMatchObject({ action: { type: 'stake' }, runId: run.run_id });
        expect((await request(appFor(pool())).get(`/agent/activity?actor=${HUMAN}`)).body.events.map(event => event.action.type)).toEqual(['stake']);
        expect((await request(appFor(pool())).get(`/agent/activity?agreement=${RECORDED}`)).body.count).toBe(0);
        expect((await request(appFor(pool())).get('/agent/activity?source=simulation')).body.count).toBe(0);
    });

    it('bounds the window to 250 without filters', async () => {
        const bounded = pool();
        const response = await request(appFor(bounded)).get('/agent/activity?limit=999');
        expect(response.status).toBe(200);
        expect(bounded.calls.find(call => call.sql.includes('consensus.agent_run')).params).toEqual([250]);
        expect(bounded.calls.find(call => call.sql.includes('consensus.solana_transaction')).params).toEqual([250]);
    });

    it('matches actors by id, wallet or name, agreements by entity or action, and ignores empty filters', () => {
        const event = { source: 'live', actor: { id: 'a1', wallet: 'w1', name: 'Mira' }, action: { type: 'claim', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, runId: 'r1' };
        for (const actor of ['a1', 'w1', 'Mira']) expect(matchesActivityFilters(event, { actor })).toBe(true);
        expect(matchesActivityFilters(event, { actor: 'x' })).toBe(false);
        expect(matchesActivityFilters(event, { agreement: AGREEMENT })).toBe(true);
        expect(matchesActivityFilters({ ...event, entity: { type: 'design', id: DESIGN } }, { agreement: AGREEMENT })).toBe(true);
        expect(matchesActivityFilters({ ...event, entity: { type: 'design', id: DESIGN }, action: { type: 'design' } }, { agreement: AGREEMENT })).toBe(false);
        expect(activityFilters({ actor: '  ', action: ' stake ', agreement: AGREEMENT, proposal: 'p1', unknown: 'x' })).toEqual({ action: 'stake', agreement: AGREEMENT });
    });
});

describe('agent runs', () => {
    it('serves a run with its events and immutable cost rows, and 404 for an unknown one', async () => {
        const pool = poolFor({ runs: [run], costs: [{ item: 'c1', provider: 'anthropic', model: 'claude-x', batch_id: 'b1', input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, usd: '0.01', created_at: '2026-10-21T08:03:00Z' }] });
        const response = await request(appFor(pool)).get(`/agent/runs/${run.run_id}`);
        expect(response.status).toBe(200);
        expect(response.body.run).toMatchObject({ id: run.run_id, costs: [{ usd: 0.01 }], picks: [{ agreementCid: AGREEMENT }] });
        expect(response.body.events).toHaveLength(4);
        expect((await request(appFor(poolFor({ runs: [] }))).get('/agent/runs/nothing')).status).toBe(404);
    });

    it('lists recent runs filtered by controller and refuses an unknown controller', async () => {
        const supporter = { ...run, run_id: '2026-10-21-supporter-01', persona: 'supporter-01',
            summary: { role: 'supporter', controller: 'algorithm', wallet: 'wallet-2', outcome: 'completed', support: { type: 'pledge', agreementCid: AGREEMENT } } };
        const llmRun = { ...run, run_id: '2026-10-21-llm', summary: { batchId: 'msgbatch-1', pickCostUsd: 0.01 } };
        const pool = poolFor({ runs: [supporter, llmRun] });
        const response = await request(appFor(pool)).get('/agent/runs?controller=algorithm&limit=10');
        expect(response.status).toBe(200);
        expect(response.body.count).toBe(1);
        expect(response.body.runs[0]).toMatchObject({ id: '2026-10-21-supporter-01', role: 'supporter', wallet: 'wallet-2', support: { type: 'pledge', agreementCid: AGREEMENT } });
        expect((await request(appFor(pool)).get('/agent/runs?controller=magic')).status).toBe(400);
    });
});
