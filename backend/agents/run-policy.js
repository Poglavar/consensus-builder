// Pure execution limits for the live agent. Model spend is capped separately in ledger.js; this
// policy bounds irreversible/signed work before the runner touches a wallet.

function finiteNonNegative(value, fallback, label) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
    return number;
}

export function executionPolicy(env = {}) {
    return {
        maxActions: Math.floor(finiteNonNegative(env.AGENT_DAILY_ACTION_CAP, 3, 'AGENT_DAILY_ACTION_CAP')),
        maxUsdc: finiteNonNegative(env.AGENT_DAILY_USDC_CAP, 0.35, 'AGENT_DAILY_USDC_CAP'),
        proposalFeeUsdc: finiteNonNegative(env.AGENT_PROPOSAL_FEE_USDC, 0.05, 'AGENT_PROPOSAL_FEE_USDC')
    };
}

export function summarizeExecutionPlan(entries, policy = executionPolicy()) {
    const plans = [];
    for (const entry of entries || []) {
        const picks = entry?.run?.summary?.picks || [];
        const stakeUsdc = finiteNonNegative(entry?.persona?.stakeUsdc, 0, 'persona.stakeUsdc');
        for (const pick of picks) {
            plans.push({
                persona: entry.persona.name,
                proposalId: pick.proposalId,
                actions: 3,
                usdc: policy.proposalFeeUsdc + stakeUsdc
            });
        }
    }
    return {
        proposalCount: plans.length,
        actionCount: plans.reduce((sum, plan) => sum + plan.actions, 0),
        maxUsdc: plans.reduce((sum, plan) => sum + plan.usdc, 0),
        proposals: plans
    };
}

export function assertExecutionPlan(plan, policy = executionPolicy()) {
    if (plan.actionCount > policy.maxActions) {
        throw new Error(`agent action cap reached: ${plan.actionCount} planned > ${policy.maxActions}`);
    }
    if (plan.maxUsdc > policy.maxUsdc + Number.EPSILON) {
        throw new Error(`agent USDC cap reached: ${plan.maxUsdc.toFixed(2)} planned > ${policy.maxUsdc.toFixed(2)}`);
    }
    return plan;
}

export function decisionCompletion(picks) {
    const noPicks = !Array.isArray(picks) || picks.length === 0;
    return { noPicks, status: noPicks ? 'done' : 'running', outcome: noPicks ? 'no-picks' : null };
}
