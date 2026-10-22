// agents/run-policy.js: the pure limits of a live proposer run (signed actions and USDC per run), the
// zero-pick outcome, and the settlement phase's selection: the persona's own minted agreements from its
// run checkpoints, what was already spent, and which inspected agreements this run settles within its caps.
import { describe, expect, it } from 'vitest';
import {
    assertExecutionPlan, dayString, decisionCompletion, executionPolicy, ownedAgreementsFromRuns, planSettlements,
    settlementPolicy, settlementsSpent, summarizeExecutionPlan
} from '../agents/run-policy.js';

const WALLET = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const cid = seed => `bafkrei${seed.padEnd(52, 'a').slice(0, 52)}`;

function entry(picks = 1, stakeUsdc = '0.25') {
    return {
        persona: { name: 'densifier-01', stakeUsdc },
        run: { summary: { picks: Array.from({ length: picks }, (_, index) => ({ pickId: `agent-densifier-01-2026-10-22-${index + 1}` })) } }
    };
}

describe('live agent execution policy', () => {
    it('defaults to four signed actions and 0.35 USDC, overridable from env', () => {
        expect(executionPolicy({})).toEqual({ maxActions: 4, maxUsdc: 0.35 });
        expect(executionPolicy({ AGENT_DAILY_ACTION_CAP: '15', AGENT_DAILY_USDC_CAP: '0.02' })).toEqual({ maxActions: 15, maxUsdc: 0.02 });
        expect(() => executionPolicy({ AGENT_DAILY_ACTION_CAP: 'many' })).toThrow(/AGENT_DAILY_ACTION_CAP/);
        expect(() => executionPolicy({ AGENT_DAILY_USDC_CAP: '-1' })).toThrow(/AGENT_DAILY_USDC_CAP/);
    });

    it('plans three signed actions per pick (create+fund, market, stake) and only the stake in USDC', () => {
        const plan = assertExecutionPlan(summarizeExecutionPlan([entry()]));
        expect(plan).toEqual({
            pickCount: 1, actionCount: 3, maxUsdc: 0.25,
            picks: [{ persona: 'densifier-01', pickId: 'agent-densifier-01-2026-10-22-1', actions: 3, usdc: 0.25 }]
        });
        expect(summarizeExecutionPlan([entry(0)])).toMatchObject({ pickCount: 0, actionCount: 0, maxUsdc: 0 });
        expect(summarizeExecutionPlan([{ persona: { name: 'p' }, run: null }])).toMatchObject({ pickCount: 0 });
    });

    it('refuses more signed actions than the cap, and more USDC than the ceiling', () => {
        expect(() => assertExecutionPlan(summarizeExecutionPlan([entry(2)]))).toThrow('agent action cap reached: 6 planned > 4');
        const policy = executionPolicy({ AGENT_DAILY_ACTION_CAP: '4', AGENT_DAILY_USDC_CAP: '0.20' });
        expect(() => assertExecutionPlan(summarizeExecutionPlan([entry()], policy), policy)).toThrow('agent USDC cap reached: 0.25 planned > 0.20');
        expect(() => summarizeExecutionPlan([entry(1, 'lots')])).toThrow(/persona.stakeUsdc/);
    });

    it('makes a valid zero-pick decision terminal instead of leaving a running row', () => {
        expect(decisionCompletion([])).toEqual({ noPicks: true, status: 'done', outcome: 'no-picks' });
        expect(decisionCompletion(undefined)).toEqual({ noPicks: true, status: 'done', outcome: 'no-picks' });
        expect(decisionCompletion([{ pickId: 'p-1' }])).toEqual({ noPicks: false, status: 'running', outcome: null });
    });
});

// A proposer run checkpoint whose picks reached minting (or not).
function proposerRun({ runId, persona = 'densifier-01', day, picks, settlements = undefined }) {
    const summary = { picks: [], agreements: {}, mints: {}, stakes: {}, ...(settlements ? { settlements } : {}) };
    for (const pick of picks) {
        summary.picks.push({ pickId: `pick-${pick.key}`, candidateId: pick.key });
        if (pick.cid) {
            summary.agreements[pick.key] = { cid: pick.cid, deadline: pick.deadline ?? '2026-10-29T09:00:00.000Z', content: pick.content ?? soleContent(WALLET) };
        }
        if (pick.account) summary.mints[pick.key] = { account: pick.account };
        if (pick.staked) summary.stakes[pick.key] = { stakeSignature: 'stake-sig' };
    }
    return { run_id: runId, persona, day, summary };
}

function soleContent(ownerId, { binding = true, share = '1/1', extraOwner = false, lens = 'lens-key' } = {}) {
    return {
        rule: {
            binding, lens: [lens],
            approvalConfig: { rights: { parcels: [{ parcelId: 'HR-1', owners: [{ ownerId, share }, ...(extraOwner ? [{ ownerId: OTHER, share }] : [])] }] } }
        }
    };
}

describe('the persona\'s own agreements', () => {
    it('lists each minted agreement of this persona once, oldest run first, with its lens and whether it owns the land alone', () => {
        const runs = [
            proposerRun({ runId: '2026-10-21-densifier-01', day: '2026-10-21', picks: [
                { key: 'c1', cid: cid('one'), account: 'acct-1', staked: true },
                { key: 'c2', cid: cid('unminted') },
                { key: 'c3', cid: cid('shared'), account: 'acct-3', content: soleContent(WALLET, { share: '1/2', extraOwner: true }) }
            ] }),
            proposerRun({ runId: '2026-10-19-densifier-01', day: new Date(2026, 9, 19), picks: [
                { key: 'c9', cid: cid('nine'), account: 'acct-9', content: soleContent(WALLET, { binding: false, lens: 'other-lens' }) }
            ] }),
            proposerRun({ runId: '2026-10-21-h02-densifier-01', day: '2026-10-21', picks: [{ key: 'c1', cid: cid('one'), account: 'acct-1' }] }),
            proposerRun({ runId: '2026-10-21-gentle-01', persona: 'gentle-01', day: '2026-10-21', picks: [{ key: 'g', cid: cid('gentle'), account: 'acct-g' }] })
        ];
        expect(ownedAgreementsFromRuns(runs, 'densifier-01', WALLET)).toEqual([
            { pickId: 'pick-c9', cid: cid('nine'), account: 'acct-9', deadline: '2026-10-29T09:00:00.000Z', content: runs[1].summary.agreements.c9.content,
                lens: 'other-lens', soleOwner: false, sourceRunId: '2026-10-19-densifier-01', sourceDay: '2026-10-19', staked: false },
            { pickId: 'pick-c1', cid: cid('one'), account: 'acct-1', deadline: '2026-10-29T09:00:00.000Z', content: runs[0].summary.agreements.c1.content,
                lens: 'lens-key', soleOwner: true, sourceRunId: '2026-10-21-densifier-01', sourceDay: '2026-10-21', staked: true },
            { pickId: 'pick-c3', cid: cid('shared'), account: 'acct-3', deadline: '2026-10-29T09:00:00.000Z', content: runs[0].summary.agreements.c3.content,
                lens: 'lens-key', soleOwner: false, sourceRunId: '2026-10-21-densifier-01', sourceDay: '2026-10-21', staked: false }
        ]);
        // Without the wallet nobody is its sole owner.
        expect(ownedAgreementsFromRuns(runs, 'densifier-01').every(item => item.soleOwner === false)).toBe(true);
        expect(ownedAgreementsFromRuns(runs, 'gentle-01', WALLET).map(item => item.account)).toEqual(['acct-g']);
    });

    it('leaves out an account some run recorded as settled', () => {
        const runs = [
            proposerRun({ runId: 'a', day: '2026-10-20', picks: [{ key: 'c1', cid: cid('one'), account: 'acct-1' }, { key: 'c2', cid: cid('two'), account: 'acct-2' }] }),
            proposerRun({ runId: 'b', day: '2026-10-22', picks: [], settlements: { 'acct-1': { settled: true }, 'acct-2': { settled: false, attest: { signature: 's' } } } })
        ];
        expect(ownedAgreementsFromRuns(runs, 'densifier-01', WALLET).map(item => item.account)).toEqual(['acct-2']);
    });

    it('reads pg DATE values back as their calendar day', () => {
        expect(dayString(new Date(2026, 9, 2))).toBe('2026-10-02');
        expect(dayString('2026-10-02T00:00:00Z')).toBe('2026-10-02');
        expect(dayString(new Date('invalid'))).toBeNull();
        expect(dayString(null)).toBeNull();
    });
});

describe('settlement selection', () => {
    const inspected = (account, sourceDay, steps, state = 'decidable') => ({ pickId: `pick-${account}`, cid: cid(account), account, sourceDay, state, steps });

    it('defaults to three agreements a run, overridable from env', () => {
        expect(settlementPolicy({})).toEqual({ maxPerRun: 3 });
        expect(settlementPolicy({ AGENT_SETTLE_MAX_PER_RUN: '1' })).toEqual({ maxPerRun: 1 });
        expect(() => settlementPolicy({ AGENT_SETTLE_MAX_PER_RUN: 'x' })).toThrow(/AGENT_SETTLE_MAX_PER_RUN/);
    });

    it('settles the oldest first; decide and the lens decision cost no signed action', () => {
        const plan = planSettlements([
            inspected('newer', '2026-10-21', ['expire', 'resolve', 'claim'], 'due'),
            inspected('older', '2026-10-19', ['decide', 'lens', 'attest', 'execute', 'resolve', 'claim']),
            inspected('waiting', '2026-10-18', [], 'awaiting-owners'),
            inspected('closed', '2026-10-17', [], 'closed')
        ], { actionBudget: 12 });
        expect(plan.selected.map(item => item.account)).toEqual(['older', 'newer']);
        expect(plan.actions).toBe(7);
        expect(plan.budget).toBe(12);
        expect(plan.limited).toBe(0);
        expect(Object.fromEntries(plan.skipped.map(item => [item.account, item.reason]))).toEqual({ waiting: 'awaiting-owners', closed: 'closed' });
    });

    it('defers the rest past the per-run cap and past the signed actions the picks leave', () => {
        const backlog = ['a', 'b', 'c', 'd'].map((account, index) => inspected(account, `2026-10-1${index}`, ['expire', 'resolve', 'claim'], 'due'));
        const capped = planSettlements(backlog, { actionBudget: 100 });
        expect(capped.selected.map(item => item.account)).toEqual(['a', 'b', 'c']);
        expect(capped.skipped).toEqual([expect.objectContaining({ account: 'd', reason: 'settle-cap' })]);
        expect(capped.limited).toBe(1);

        // AGENT_DAILY_ACTION_CAP 4 with one pick planned (3 actions) leaves one signature: nothing fits.
        const starved = planSettlements(backlog, { actionBudget: 4 - summarizeExecutionPlan([entry()]).actionCount });
        expect(starved.selected).toEqual([]);
        expect(starved.skipped.every(item => item.reason === 'action-cap')).toBe(true);
        expect(starved.limited).toBe(4);

        // A smaller job further back still fits what is left.
        const mixed = planSettlements([backlog[0], inspected('small', '2026-10-15', ['resolve'], 'executed')], { actionBudget: 2 });
        expect(mixed.selected.map(item => item.account)).toEqual(['small']);
        expect(mixed.skipped).toEqual([expect.objectContaining({ account: 'a', reason: 'action-cap' })]);
    });

    it('counts what this run already signed against both caps on a rerun', () => {
        const spent = settlementsSpent({
            'acct-1': { attest: { signature: 's1' }, execution: { signature: 's2' }, resolution: { signature: 's3' }, claim: { signature: 's4' } },
            'acct-2': { approval: { replayed: true }, lensDecision: { address: 'x' } },
            'acct-3': { expiry: { replayed: true, signature: null }, claim: { skipped: true, signature: null } }
        });
        expect(spent).toEqual({ actions: 4, count: 2 });
        const plan = planSettlements([
            inspected('c', '2026-10-10', ['expire', 'resolve'], 'due'),
            inspected('d', '2026-10-11', ['expire'], 'due')
        ], { actionBudget: 6, spent, policy: { maxPerRun: 3 } });
        expect(plan.budget).toBe(2);
        expect(plan.selected.map(item => item.account)).toEqual(['c']);
        expect(plan.skipped).toEqual([expect.objectContaining({ account: 'd', reason: 'settle-cap' })]);
        expect(() => planSettlements([], { actionBudget: Number.NaN })).toThrow(/actionBudget/);
    });
});
