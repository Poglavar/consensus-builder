import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { runEvents } from '../routes/agent-activity.js';
import {
    ageInDays, assertExecutionPlan, createAction, dayString, decisionCompletion, executionPolicy, expiryObservedAt, lifecycleLensConfig,
    ownedProposalsFromRuns, planRetirements, retirePolicy, retirementsSpent, summarizeExecutionPlan
} from '../agents/run-policy.js';

function entry(picks = 1, stakeUsdc = '0.25') {
    return {
        persona: { name: 'densifier-01', stakeUsdc },
        run: { summary: { picks: Array.from({ length: picks }, (_, index) => ({ proposalId: `p-${index + 1}` })) } }
    };
}

describe('live agent execution policy', () => {
    it('defaults to one proposal worth of signed actions and USDC', () => {
        expect(executionPolicy({})).toEqual({ maxActions: 4, maxUsdc: 0.35, proposalFeeUsdc: 0.05 });
        expect(assertExecutionPlan(summarizeExecutionPlan([entry()]))).toMatchObject({ proposalCount: 1, actionCount: 4, maxUsdc: 0.3 });
    });

    it('refuses additional signed actions even if a persona is misconfigured', () => {
        const plan = summarizeExecutionPlan([entry(2)]);
        expect(() => assertExecutionPlan(plan)).toThrow(/action cap reached/);
    });

    it('enforces the USDC ceiling independently of the action count', () => {
        const policy = executionPolicy({ AGENT_DAILY_ACTION_CAP: '4', AGENT_DAILY_USDC_CAP: '0.20' });
        expect(() => assertExecutionPlan(summarizeExecutionPlan([entry()], policy), policy)).toThrow(/USDC cap reached/);
    });

    it('makes a valid zero-pick decision terminal instead of leaving a running row', () => {
        expect(decisionCompletion([])).toEqual({ noPicks: true, status: 'done', outcome: 'no-picks' });
        expect(decisionCompletion([{ proposalId: 'p-1' }])).toEqual({ noPicks: false, status: 'running', outcome: null });
    });
});

function inspected(proposalId, sourceDay, { state = 'active', steps = ['cancel', 'resolve', 'claim'], acceptedParcels = [] } = {}) {
    return { proposalId, proposalPda: `pda-${proposalId}`, sourceDay, state, steps, acceptedParcels };
}

describe('retire policy', () => {
    it('defaults to seven days and three retirements per run, overridable from env', () => {
        expect(retirePolicy({})).toEqual({ afterDays: 7, maxPerRun: 3 });
        expect(retirePolicy({ AGENT_RETIRE_AFTER_DAYS: '10', AGENT_RETIRE_MAX_PER_RUN: '1' })).toEqual({ afterDays: 10, maxPerRun: 1 });
        expect(() => retirePolicy({ AGENT_RETIRE_AFTER_DAYS: 'soon' })).toThrow(/AGENT_RETIRE_AFTER_DAYS/);
    });

    it('measures age in whole UTC days from the ledger run day, reading pg DATE values back correctly', () => {
        expect(ageInDays('2026-09-24', '2026-10-01')).toBe(7);
        expect(ageInDays(new Date(2026, 8, 24), '2026-10-01')).toBe(7);
        expect(dayString(new Date(2026, 8, 24))).toBe('2026-09-24');
        expect(ageInDays(null, '2026-10-01')).toBeNull();
    });

    it('lists only this persona\'s minted proposals from earlier days, oldest first', () => {
        const runs = [
            { run_id: '2026-09-20-densifier-01', persona: 'densifier-01', day: '2026-09-20', summary: {
                picks: [{ proposalId: 'agent-a', candidateId: 'c1' }, { proposalId: 'agent-unminted', candidateId: 'c2' }],
                mints: { c1: { proposalPda: 'PdaA' } }, stakes: { c1: { stakeSignature: 's' } }
            } },
            { run_id: '2026-09-18-densifier-01', persona: 'densifier-01', day: new Date(2026, 8, 18), summary: {
                picks: [{ proposalId: 'agent-b', candidateId: 'c9' }], mints: { c9: { proposalPda: 'PdaB' } }
            } },
            { run_id: '2026-10-01-densifier-01', persona: 'densifier-01', day: '2026-10-01', summary: {
                picks: [{ proposalId: 'agent-today', candidateId: 'c3' }], mints: { c3: { proposalPda: 'PdaT' } }
            } },
            { run_id: 'case', persona: 'hackathon-case', day: '2026-09-01', summary: {
                picks: [{ proposalId: 'x', candidateId: 'c' }], mints: { c: { proposalPda: 'PdaX' } }
            } }
        ];
        expect(ownedProposalsFromRuns(runs, 'densifier-01', '2026-10-01')).toEqual([
            { proposalId: 'agent-b', proposalPda: 'PdaB', sourceRunId: '2026-09-18-densifier-01', sourceDay: '2026-09-18', staked: false },
            { proposalId: 'agent-a', proposalPda: 'PdaA', sourceRunId: '2026-09-20-densifier-01', sourceDay: '2026-09-20', staked: true }
        ]);
    });

    it('retires only old, unaccepted Active proposals and finishes half-retired ones regardless of age', () => {
        const plan = planRetirements([
            inspected('young', '2026-09-28'),
            inspected('accepted', '2026-09-01', { acceptedParcels: ['335550:1'] }),
            inspected('old', '2026-09-10'),
            inspected('half', '2026-09-30', { state: 'cancelled', steps: ['resolve', 'claim'] }),
            inspected('done', '2026-09-02', { state: 'retired', steps: [] }),
            inspected('won', '2026-09-03', { state: 'executed', steps: [] })
        ], { runDay: '2026-10-01', actionBudget: 9 });
        expect(plan.selected.map(item => item.proposalId)).toEqual(['old', 'half']);
        expect(plan.selected[0].ageDays).toBe(21);
        expect(plan.actions).toBe(5);
        expect(Object.fromEntries(plan.skipped.map(item => [item.proposalId, item.reason]))).toEqual({
            young: 'too-young', accepted: 'has-acceptances', done: 'already-retired', won: 'executed'
        });
    });

    it('treats exactly the threshold as old enough', () => {
        const plan = planRetirements([inspected('edge', '2026-09-24')], { runDay: '2026-10-01', actionBudget: 3 });
        expect(plan.selected).toHaveLength(1);
    });

    it('caps retirements per run and by the signed actions the proposal leaves, deferring the rest', () => {
        const backlog = ['a', 'b', 'c', 'd', 'e'].map((id, index) => inspected(id, `2026-09-0${index + 1}`));
        const capped = planRetirements(backlog, { runDay: '2026-10-01', actionBudget: 100 });
        expect(capped.selected.map(item => item.proposalId)).toEqual(['a', 'b', 'c']);
        expect(capped.limited).toBe(2);
        expect(capped.skipped.every(item => item.reason === 'retire-cap')).toBe(true);

        // Daily cap 4 with one proposal (4 worst-case actions) leaves nothing to retire with.
        const starved = planRetirements(backlog, { runDay: '2026-10-01', actionBudget: 4 - summarizeExecutionPlan([entry()]).actionCount });
        expect(starved.selected).toEqual([]);
        expect(starved.limited).toBe(5);
        expect(starved.skipped[0].reason).toBe('action-cap');

        const partial = planRetirements(backlog, { runDay: '2026-10-01', actionBudget: 7 });
        expect(partial.selected.map(item => item.proposalId)).toEqual(['a', 'b']);
    });

    it('counts retirements already signed today against both caps on a same-day rerun', () => {
        const spent = retirementsSpent({
            PdaA: { cancel: { signature: 's1' }, resolution: { signature: 's2' }, claim: { signature: 's3' } },
            PdaB: { cancel: { signature: null, replayed: true }, claim: { skipped: true, signature: null } }
        });
        expect(spent).toEqual({ actions: 3, count: 1 });
        const plan = planRetirements([inspected('c', '2026-09-01'), inspected('d', '2026-09-02')], {
            runDay: '2026-10-01', actionBudget: 6, spent, policy: { afterDays: 7, maxPerRun: 3 }
        });
        expect(plan.budget).toBe(3);
        expect(plan.selected.map(item => item.proposalId)).toEqual(['c']);
    });

    it('produces the dry-run listing (selection with steps) from inspections alone, without signing', () => {
        const plan = planRetirements([inspected('old', '2026-09-01', { steps: ['cancel', 'resolve'] })], { runDay: '2026-10-01', actionBudget: 3 });
        expect(plan.selected).toEqual([expect.objectContaining({ proposalId: 'old', proposalPda: 'pda-old', steps: ['cancel', 'resolve'], ageDays: 30 })]);
    });
});

describe('lifecycle lens member for expiry verdicts', () => {
    it('is off without a service URL and refuses a URL without the operator token', () => {
        expect(lifecycleLensConfig({})).toBeNull();
        expect(() => lifecycleLensConfig({ AGENT_LIFECYCLE_LENS_SERVICE_URL: 'http://lens.test' })).toThrow(/OPERATOR_TOKEN/);
        expect(lifecycleLensConfig({ AGENT_LIFECYCLE_LENS_SERVICE_URL: 'http://lens.test/', AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN: 't' }))
            .toEqual({ serviceUrl: 'http://lens.test', operatorToken: 't' });
    });

    it('dates the expiry at run day + afterDays (UTC midnight), deterministically', () => {
        expect(expiryObservedAt('2026-09-01', 7)).toBe(Date.parse('2026-09-08T00:00:00Z') / 1000);
        expect(expiryObservedAt(new Date(2026, 8, 1), 0)).toBe(Date.parse('2026-09-01T00:00:00Z') / 1000);
        expect(() => expiryObservedAt(null, 7)).toThrow(/run day/);
        expect(() => expiryObservedAt('2026-09-01', -1)).toThrow(/afterDays/);
    });

    it('counts a signed expiry toward the day\'s retire budget like a cancel', () => {
        expect(retirementsSpent({ a: { expiry: { signature: 'e' }, resolution: { signature: 'r' } }, b: { expiry: { signature: null } } }))
            .toEqual({ actions: 2, count: 1 });
    });
});

describe('create activity carries the lens', () => {
    const require = createRequire(import.meta.url);
    const actionEngineApi = require('../../frontend/js/agent-action-engine.js');
    const LENS = ['5x8hiYo9V6kWpG8eVoyXZf4BHXnKSoCP3r7r3PyMBg4z'];

    it('puts the mint lens into the activity envelope and /agent/activity keeps it', async () => {
        const activities = [];
        const runtime = actionEngineApi.createEngine({
            decisionProviders: { algorithm: (_actor, context) => context.action },
            actionHandlers: { '*': (_actor, _action, context) => context.execute() },
            onActivity: activity => activities.push(activity)
        });
        const actor = { id: 'densifier-01', name: 'densifier-01', controller: 'algorithm', wallet: 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg' };
        await runtime.run(actor, {
            source: 'live', action: createAction({ proposalId: 'agent-densifier-01-2026-10-01-1', lens: LENS }),
            execute: async () => ({ signature: 'mint-tx', proposalPda: 'pda' })
        });
        expect(activities).toHaveLength(1);
        expect(activities[0].action).toEqual({ type: 'create', proposalId: 'agent-densifier-01-2026-10-01-1', lens: LENS });
        expect(activities[0].transaction).toBe('mint-tx');

        const events = runEvents({
            run_id: '2026-10-01-densifier-01', persona: 'densifier-01', status: 'done', stage: 'staked', mode: 'live',
            summary: { activities, lensChoice: { lens: LENS, source: 'directory' } }, started_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:01:00Z'
        });
        expect(events.find(event => event.action.type === 'create').action.lens).toEqual(LENS);
    });

    it('refuses a create action without a lens', () => {
        expect(() => createAction({ proposalId: 'p' })).toThrow(/lens/);
        expect(() => createAction({ proposalId: 'p', lens: [] })).toThrow(/lens/);
    });
});
