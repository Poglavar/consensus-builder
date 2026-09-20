import { describe, expect, it } from 'vitest';
import { assertExecutionPlan, decisionCompletion, executionPolicy, summarizeExecutionPlan } from '../agents/run-policy.js';

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
