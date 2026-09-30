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
        maxActions: Math.floor(finiteNonNegative(env.AGENT_DAILY_ACTION_CAP, 4, 'AGENT_DAILY_ACTION_CAP')),
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
                // Worst case: proposal mint, x402 settlement, market creation and YES stake. A
                // pre-existing market removes one signature, but the pre-flight cap is conservative.
                actions: 4,
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

// ---- retire phase ------------------------------------------------------------------------------
// The daily proposer mints real parcels nobody accepts, so each run first retires its own stale
// proposals (cancel → resolve NO → claim the YES refund). These are pure limits and selection; the
// chain reads and signing live in lifecycle-actions.js (inspectRetirement / executeRetirement).

export function retirePolicy(env = {}) {
    return {
        afterDays: Math.floor(finiteNonNegative(env.AGENT_RETIRE_AFTER_DAYS, 7, 'AGENT_RETIRE_AFTER_DAYS')),
        maxPerRun: Math.floor(finiteNonNegative(env.AGENT_RETIRE_MAX_PER_RUN, 3, 'AGENT_RETIRE_MAX_PER_RUN'))
    };
}

/**
 * The lifecycle lens member the retire phase asks for "expired" verdicts, or null (keep cancelling).
 * AGENT_LIFECYCLE_LENS_SERVICE_URL names the member's service; its operator route needs
 * AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN, so a URL without a token is a configuration error, not a
 * silent fallback to cancel.
 */
export function lifecycleLensConfig(env = {}) {
    const serviceUrl = String(env.AGENT_LIFECYCLE_LENS_SERVICE_URL || '').trim();
    if (!serviceUrl) return null;
    const operatorToken = String(env.AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN || '').trim();
    if (!operatorToken) throw new Error('AGENT_LIFECYCLE_LENS_SERVICE_URL is set but AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN is not; the expiry verdict route is operator-only');
    return { serviceUrl: serviceUrl.replace(/\/+$/, ''), operatorToken };
}

/**
 * Source time of an expiry verdict: the UTC midnight of the proposal's run day plus `afterDays` —
 * the instant the retire policy made it stale. Deterministic, so the member's verdict nonce (and the
 * attestation address) is the same on every retry.
 */
export function expiryObservedAt(sourceDay, afterDays) {
    const day = dayString(sourceDay);
    if (!day) throw new Error(`expiry needs the proposal's run day, got ${sourceDay}`);
    if (!Number.isInteger(afterDays) || afterDays < 0) throw new Error('afterDays must be a non-negative integer');
    return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + afterDays * 86400;
}

// pg hands a DATE column back as a Date at LOCAL midnight; read it back with local getters so the
// calendar day survives any server timezone. Strings are already YYYY-MM-DD.
export function dayString(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return null;
}

/** Whole UTC days from `sourceDay` to `runDay` (both YYYY-MM-DD), or null when either is missing. */
export function ageInDays(sourceDay, runDay) {
    const from = dayString(sourceDay);
    const to = dayString(runDay);
    if (!from || !to) return null;
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * This persona's minted proposals from its own consensus.agent_run rows. The age source is the
 * ledger row's `day` — the UTC run day the mint was made under — never a fetch time.
 */
export function ownedProposalsFromRuns(runs, personaName, runDay) {
    const owned = [];
    const seen = new Set();
    for (const run of runs || []) {
        if (run?.persona !== personaName) continue;
        const sourceDay = dayString(run.day);
        if (!sourceDay || sourceDay >= runDay) continue;
        const summary = run.summary || {};
        for (const pick of summary.picks || []) {
            const proposalPda = summary.mints?.[pick.candidateId]?.proposalPda;
            if (!proposalPda || seen.has(proposalPda)) continue;
            seen.add(proposalPda);
            owned.push({
                proposalId: pick.proposalId, proposalPda, sourceRunId: run.run_id, sourceDay,
                staked: Boolean(summary.stakes?.[pick.candidateId])
            });
        }
    }
    return owned.sort((a, b) => a.sourceDay.localeCompare(b.sourceDay) || a.proposalId.localeCompare(b.proposalId));
}

/** Signed actions and retirements already spent today, read from today's run checkpoint. */
export function retirementsSpent(retirements = {}) {
    let actions = 0;
    let count = 0;
    for (const record of Object.values(retirements || {})) {
        const signed = [record?.cancel, record?.expiry, record?.resolution, record?.claim].filter(step => step?.signature).length;
        actions += signed;
        if (signed) count += 1;
    }
    return { actions, count };
}

/**
 * Pick which inspected proposals to retire this run. An Active proposal must have no acceptances
 * and be at least `afterDays` old; a proposal already cancelled with steps outstanding (a previous
 * run failed half-way, or the owner cancelled by hand) is finished regardless of age. Oldest first,
 * bounded by the per-run cap and by the signed actions the daily cap has left after proposing.
 */
export function planRetirements(inspections, { policy = retirePolicy(), runDay, actionBudget, spent = { actions: 0, count: 0 } } = {}) {
    if (typeof actionBudget !== 'number' || !Number.isFinite(actionBudget)) throw new Error('actionBudget must be a finite number');
    const selected = [];
    const skipped = [];
    let actionsLeft = Math.max(0, actionBudget - spent.actions);
    let slotsLeft = Math.max(0, policy.maxPerRun - spent.count);
    const ordered = [...(inspections || [])].sort((a, b) => String(a.sourceDay).localeCompare(String(b.sourceDay)));
    for (const item of ordered) {
        const ageDays = ageInDays(item.sourceDay, runDay);
        const base = { proposalId: item.proposalId, proposalPda: item.proposalPda, sourceDay: item.sourceDay, ageDays, state: item.state };
        if (!item.steps?.length) { skipped.push({ ...base, reason: item.state === 'retired' ? 'already-retired' : item.state }); continue; }
        if (item.state === 'active') {
            if (item.acceptedParcels?.length) { skipped.push({ ...base, reason: 'has-acceptances' }); continue; }
            if (ageDays === null) { skipped.push({ ...base, reason: 'no-age' }); continue; }
            if (ageDays < policy.afterDays) { skipped.push({ ...base, reason: 'too-young' }); continue; }
        }
        if (slotsLeft <= 0) { skipped.push({ ...base, reason: 'retire-cap' }); continue; }
        if (item.steps.length > actionsLeft) { skipped.push({ ...base, reason: 'action-cap' }); continue; }
        selected.push({ ...item, ageDays });
        slotsLeft -= 1;
        actionsLeft -= item.steps.length;
    }
    return {
        selected,
        skipped,
        actions: selected.reduce((sum, item) => sum + item.steps.length, 0),
        budget: Math.max(0, actionBudget - spent.actions),
        limited: skipped.filter(item => item.reason === 'retire-cap' || item.reason === 'action-cap').length
    };
}

/**
 * The action-engine action for a mint. The lens rides inside the action so it lands in the activity
 * envelope as `action.lens` (the proof audit's no_self_lens check reads it from create events).
 */
export function createAction({ proposalId, lens } = {}) {
    if (!Array.isArray(lens) || !lens.length) throw new Error('a create action needs the lens it mints with');
    return { type: 'create', ...(proposalId ? { proposalId } : {}), lens: [...lens] };
}
