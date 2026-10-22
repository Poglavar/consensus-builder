// Pure execution limits for the live agents. Model spend is capped separately in ledger.js; this
// policy bounds irreversible/signed work before a runner touches a wallet.

function finiteNonNegative(value, fallback, label) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
    return number;
}

export function executionPolicy(env = {}) {
    return {
        maxActions: Math.floor(finiteNonNegative(env.AGENT_DAILY_ACTION_CAP, 4, 'AGENT_DAILY_ACTION_CAP')),
        maxUsdc: finiteNonNegative(env.AGENT_DAILY_USDC_CAP, 0.35, 'AGENT_DAILY_USDC_CAP')
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
                pickId: pick.pickId,
                // Worst case: the agreement's create + fund (one transaction), the market creation and
                // the YES stake. A pre-existing market removes one signature, but the pre-flight cap is
                // conservative. Pinning and indexing sign nothing.
                actions: 3,
                usdc: stakeUsdc
            });
        }
    }
    return {
        pickCount: plans.length,
        actionCount: plans.reduce((sum, plan) => sum + plan.actions, 0),
        maxUsdc: plans.reduce((sum, plan) => sum + plan.usdc, 0),
        picks: plans
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

// ---- settlement phase --------------------------------------------------------------------------
// Every agreement the proposer mints is a binding owners' agreement with a deadline (the persona's
// agreement.deadlineDays). On its next runs the proposer settles its own agreements: one it owns alone it
// decides itself (its approval, its lens member's decision, attest, execute; then the market resolves
// YES and it claims), one past its deadline it expires (the market resolves NO and it claims any YES
// refund). These are pure limits and selection; the chain reads and signing live in
// lifecycle-actions.js (inspectSettlement / executeSettlement).

const SIGNED_STEPS = new Set(['attest', 'execute', 'expire', 'resolve', 'claim']);
const signedCount = steps => (steps || []).filter(step => SIGNED_STEPS.has(step)).length;

export function settlementPolicy(env = {}) {
    return { maxPerRun: Math.floor(finiteNonNegative(env.AGENT_SETTLE_MAX_PER_RUN, 3, 'AGENT_SETTLE_MAX_PER_RUN')) };
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

// Whether `wallet` is the only owner of every input parcel in the agreement's rights snapshot: then its
// own approval passes the unanimous rule and the proposer can get the agreement decided alone.
function soleOwnerOf(content, wallet) {
    const parcels = content?.rule?.approvalConfig?.rights?.parcels;
    return Boolean(wallet) && content?.rule?.binding === true && Array.isArray(parcels) && parcels.length > 0
        && parcels.every(parcel => parcel.owners?.length === 1 && parcel.owners[0].ownerId === wallet && parcel.owners[0].share === '1/1');
}

/**
 * This persona's minted agreements from its own consensus.agent_run rows (summary.mints and
 * summary.agreements per pick), oldest run first, one entry per account, each with its published content,
 * its lens and whether `wallet` owns all of its land alone (soleOwner). An account some run recorded as
 * settled (summary.settlements[account].settled) is left out.
 */
export function ownedAgreementsFromRuns(runs, personaName, wallet = null) {
    const mine = (runs || []).filter(run => run?.persona === personaName);
    // Settled for good in some run (terminal, its market resolved and claimed): never read again.
    const settled = new Set(mine.flatMap(run => Object.entries(run.summary?.settlements || {})
        .filter(([, record]) => record?.settled === true).map(([account]) => account)));
    const owned = [];
    const seen = new Set(settled);
    for (const run of mine) {
        const summary = run.summary || {};
        for (const pick of summary.picks || []) {
            const mint = summary.mints?.[pick.candidateId];
            const agreement = summary.agreements?.[pick.candidateId];
            if (!mint?.account || !agreement?.cid || seen.has(mint.account)) continue;
            seen.add(mint.account);
            owned.push({
                pickId: pick.pickId, cid: agreement.cid, account: mint.account, deadline: agreement.deadline ?? null,
                content: agreement.content ?? null, lens: agreement.content?.rule?.lens?.[0] ?? null,
                soleOwner: soleOwnerOf(agreement.content, wallet),
                sourceRunId: run.run_id, sourceDay: dayString(run.day), staked: Boolean(summary.stakes?.[pick.candidateId])
            });
        }
    }
    return owned.sort((a, b) => String(a.sourceDay).localeCompare(String(b.sourceDay)) || a.cid.localeCompare(b.cid));
}

/** Signed transactions and agreements already settled in this run's checkpoint (summary.settlements). */
export function settlementsSpent(settlements = {}) {
    let actions = 0;
    let count = 0;
    for (const record of Object.values(settlements || {})) {
        const signed = [record?.attest, record?.execution, record?.expiry, record?.resolution, record?.claim].filter(step => step?.signature).length;
        actions += signed;
        if (signed || record?.approval) count += 1;
    }
    return { actions, count };
}

/**
 * Pick which inspected agreements to settle this run: those with outstanding steps, oldest first,
 * bounded by the per-run cap and by the signed transactions the action cap has left after proposing
 * (decide and lens sign no transaction of the proposer's, so they cost none).
 */
export function planSettlements(inspections, { policy = settlementPolicy(), actionBudget, spent = { actions: 0, count: 0 } } = {}) {
    if (typeof actionBudget !== 'number' || !Number.isFinite(actionBudget)) throw new Error('actionBudget must be a finite number');
    const selected = [];
    const skipped = [];
    let actionsLeft = Math.max(0, actionBudget - spent.actions);
    let slotsLeft = Math.max(0, policy.maxPerRun - spent.count);
    const ordered = [...(inspections || [])].sort((a, b) => String(a.sourceDay).localeCompare(String(b.sourceDay)));
    for (const item of ordered) {
        const base = { pickId: item.pickId, cid: item.cid, account: item.account, sourceDay: item.sourceDay, state: item.state };
        if (!item.steps?.length) { skipped.push({ ...base, reason: item.state }); continue; }
        if (slotsLeft <= 0) { skipped.push({ ...base, reason: 'settle-cap' }); continue; }
        const actions = signedCount(item.steps);
        if (actions > actionsLeft) { skipped.push({ ...base, reason: 'action-cap' }); continue; }
        selected.push(item);
        slotsLeft -= 1;
        actionsLeft -= actions;
    }
    return {
        selected,
        skipped,
        actions: selected.reduce((sum, item) => sum + signedCount(item.steps), 0),
        budget: Math.max(0, actionBudget - spent.actions),
        limited: skipped.filter(item => item.reason === 'settle-cap' || item.reason === 'action-cap').length
    };
}

// ---- society roles (society-run.mjs) -----------------------------------------------------------
// One invocation of a society persona plays one or more turns; the caps below bound the whole
// invocation, not each turn, so `--turns 5` cannot multiply the spend.

export const MAX_SOCIETY_TURNS = 10;

export function societyPolicy(env = {}) {
    return {
        maxActions: Math.floor(finiteNonNegative(env.AGENT_SOCIETY_ACTION_CAP, 4, 'AGENT_SOCIETY_ACTION_CAP')),
        maxUsdc: finiteNonNegative(env.AGENT_SOCIETY_USDC_CAP, 0.05, 'AGENT_SOCIETY_USDC_CAP')
    };
}

/**
 * `--slot`: a label that lets one persona run several times on the same UTC day. `auto` is `h` plus
 * the two-digit UTC hour of `now` (e.g. `h08`); anything else must be a short [a-z0-9-] label.
 * Without a slot (null) the run ids stay exactly the daily ones.
 */
export function societySlot(value, now = new Date()) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim().toLowerCase();
    if (text === 'auto') return `h${String(now.getUTCHours()).padStart(2, '0')}`;
    if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(text)) throw new Error(`--slot must be auto or a short label of a-z, 0-9 and -, got ${value}`);
    return text;
}

/**
 * The turns of one invocation. Without `turns` it is the ordinary daily run: run id `<day>-<persona>`
 * and seed `<day>`. With `--turns N` turn k is its own game day: run id `<day>-<persona>-t<k>` and
 * seed `<day>:t<k>`, each checkpointed separately so a rerun resumes at the first unfinished turn.
 * With `--slot S` the run id becomes `<day>-<S>-<persona>[-t<k>]` and the seed `<day>:<S>[:t<k>]`, so a
 * second invocation on the same day is a new run instead of a replay; the run's `day` is unchanged.
 */
export function societyTurns({ day, personaName, turns = null, slot = null } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error(`day must be YYYY-MM-DD, got ${day}`);
    if (!personaName) throw new Error('personaName is required');
    if (slot !== null && slot !== undefined && !/^[a-z0-9][a-z0-9-]{0,15}$/.test(String(slot))) throw new Error(`slot must be a short [a-z0-9-] label, got ${slot}`);
    const runBase = slot ? `${day}-${slot}-${personaName}` : `${day}-${personaName}`;
    const seedBase = slot ? `${day}:${slot}` : day;
    if (turns === null || turns === undefined) return [{ turn: null, runId: runBase, seed: seedBase }];
    if (!Number.isInteger(turns) || turns < 1 || turns > MAX_SOCIETY_TURNS) throw new Error(`--turns must be an integer from 1 to ${MAX_SOCIETY_TURNS}`);
    return Array.from({ length: turns }, (_, index) => ({
        turn: index + 1, runId: `${runBase}-t${index + 1}`, seed: `${seedBase}:t${index + 1}`
    }));
}

/** Signed actions and USDC one finished turn spent, read from its checkpoint (summary.society). */
export function societyTurnSpent(summary = {}) {
    const society = summary?.society || {};
    const execution = society.execution || {};
    // A claim that first settled its market signed the resolve as well.
    const actions = [execution.createSignature, execution.stakeSignature, execution.resolveSignature, execution.signature].filter(Boolean).length;
    const usdc = society.acted ? Number(society.action?.usdc) || 0 : 0;
    return { actions, usdc };
}

/** What is left of the invocation caps after the spent turns. */
export function societyBudget(policy, spent = { actions: 0, usdc: 0 }) {
    return {
        actionsLeft: Math.max(0, policy.maxActions - spent.actions),
        usdcLeft: Math.max(0, Number((policy.maxUsdc - spent.usdc).toFixed(6)))
    };
}
