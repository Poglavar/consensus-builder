// What an agreement's lens walkthrough says, as data: the parties' roles, the checklist of what the
// agreement needs (owner approvals, lens member confirmations, funding, execution) and who stated
// each fact. Pure: the page (lens-walkthrough.js) and the MCP evidence tool read sources and render.
(function attach(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LensWalkthroughModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
    'use strict';

    const keyOf = entry => typeof entry === 'string' ? entry : entry?.address || entry?.key || null;
    const keys = list => (Array.isArray(list) ? list : []).map(keyOf).filter(Boolean);
    const big = value => {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
        if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
        return null;
    };
    const wholeSeconds = value => {
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
        if (typeof value === 'string' && value.trim()) {
            const ms = Date.parse(value);
            return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
        }
        return null;
    };

    // An index row minted under another agreement program (a retired devnet deployment) is read as
    // not minted: this program's client cannot read or verify its account.
    function isRetiredProgram(record, programId) {
        return Boolean(record?.onchain && programId && record.onchain.programId !== programId);
    }

    // Which electorate decides: owners (binding), investors (crowdfunding), or a poll counted off chain.
    function kindOf(record) {
        const rule = record?.content?.rule || {};
        if (rule.binding === false) return 'poll';
        if (rule.electorate === 'owners') return 'owners';
        if (rule.electorate === 'investors') return 'investors';
        return 'poll';
    }

    // The owner approvals a lens member counted when it stated the rule was met: those signed no later
    // than the statement's source time (the last counted decision, in whole seconds). Later approvals
    // and withdrawals do not change what that statement cited.
    function approvalsCountedBy(receipts, sourceObservedAt) {
        const limit = wholeSeconds(sourceObservedAt);
        if (limit == null) return [];
        return (receipts || []).filter(receipt => {
            const at = wholeSeconds(receipt?.decidedAt);
            return at != null && at <= limit;
        });
    }

    // The lens as the best available source states it: the chain account once read, else the index
    // row of a current-program agreement, else the published rule.
    function lensOf({ record, account, retired }) {
        const rule = record?.content?.rule || {};
        const indexed = !retired && record?.onchain && Array.isArray(record.onchain.lenses) ? record.onchain : null;
        const lensKeys = account ? keys(account.lenses) : indexed ? keys(indexed.lenses) : keys(rule.lens);
        const threshold = account ? account.lensThreshold
            : indexed && Number.isInteger(indexed.lensThreshold) ? indexed.lensThreshold
                : Number.isInteger(rule.lensThreshold) ? rule.lensThreshold : lensKeys.length ? 1 : 0;
        const confirmed = account ? keys(account.lensConfirmed) : indexed ? keys(indexed.lensConfirmed) : [];
        return { keys: lensKeys, threshold, confirmed, fromChain: Boolean(account) };
    }

    function lensMembers({ lens, issued, services, account, statement }) {
        return lens.keys.map(key => {
            const statements = (issued || []).filter(row => row.authority === key);
            const recorded = account?.decisionAttestation && statement?.signer === key ? statement : null;
            const service = services?.[key] || null;
            let state;
            if (lens.confirmed.includes(key)) state = 'confirmed';
            else if (statements.length) state = 'issued';
            else if (service === 'unlisted') state = 'unlisted';
            else if (service === 'error') state = 'unknown';
            else if (issued == null && service !== 'ok') state = 'loading';
            else state = 'none';
            return { key, state, recorded, statements };
        });
    }

    function executionOf({ record, account, retired, chainPending, chainError }) {
        if (retired) return { state: 'retired' };
        if (kindOf(record) === 'poll') return { state: 'poll' };
        if (account) {
            const states = { Executed: 'executed', Active: 'active', Expired: 'expired', Cancelled: 'cancelled' };
            return { state: states[account.status] || 'unknown', status: account.status, account: account.address, at: account.status === 'Executed' ? account.executedAt : null };
        }
        if (chainPending) return { state: 'loading' };
        if (chainError) return { state: 'unreadable' };
        return { state: 'unminted' };
    }

    // checks: [{ id, state }] with state met | waiting | failed | unknown | loading | none.
    function build(input = {}) {
        const { record, programId, receipts = null, receiptsError = false, tally = null, approvalsRef = null,
            issued = null, services = {}, chain = null, chainPending = false, chainError = false } = input;
        const kind = kindOf(record);
        const retired = isRetiredProgram(record, programId);
        const account = retired ? null : chain?.account || null;
        const statement = account ? chain?.statement || null : null;
        const lens = lensOf({ record, account, retired });
        const members = lensMembers({ lens, issued, services, account, statement });
        const execution = executionOf({ record, account, retired, chainPending, chainError: chainError && !retired });
        const checks = [];
        const approvals = (receipts || []).map(({ receipt, verified }) => ({
            receipt,
            verified: verified === true,
            decision: receipt?.decision || null,
            owner: receipt?.ownerId || null,
            signer: receipt?.actorId || null,
            rightsBy: receipt?.evidence?.rights?.member || null,
            authorityBy: receipt?.evidence?.authority?.member || null,
            decidedAt: receipt?.decidedAt || null
        }));

        if (kind === 'owners') {
            const state = receiptsError ? 'unknown' : receipts == null ? 'loading' : tally?.passed ? 'met' : tally && tally.ready === false ? 'unknown' : 'waiting';
            checks.push({ id: 'approvals', state, approved: tally?.acceptedOwners ?? null, total: tally?.totalOwners ?? null });
        }

        const required = big(account ? account.requiredFunding : !retired ? record?.onchain?.requiredFunding : null);
        if (kind === 'investors' || (required != null && required > 0n)) {
            const met = account ? account.fundingMet === true : !retired && record?.onchain?.fundingMet === true;
            const state = met ? 'met' : account || (!retired && record?.onchain) ? 'waiting' : chainPending ? 'loading' : 'unknown';
            checks.push({ id: 'funding', state, observed: account ? big(account.fundingObserved) : null, required: required != null && required > 0n ? required : null });
        }

        if (kind !== 'poll') {
            if (!lens.keys.length) checks.push({ id: 'lens', state: 'none', confirmed: 0, threshold: 0, count: 0 });
            else {
                const decided = Boolean(account?.decisionAttestation);
                const state = lens.confirmed.length >= lens.threshold || decided ? 'met'
                    : chainPending ? 'loading' : chainError && !retired ? 'unknown' : 'waiting';
                checks.push({ id: 'lens', state, confirmed: lens.confirmed.length, threshold: lens.threshold, count: lens.keys.length });
            }
        }

        // Whether the recorded statement cited the approvals shown: its evidenceRef against the hash of
        // the approvals counted up to its source time. Only once a statement is checked on Solana.
        if (kind === 'owners' && statement?.fields?.evidenceRef) {
            const state = receiptsError || receipts == null ? (receiptsError ? 'unknown' : 'loading')
                : !approvalsRef ? 'unknown' : approvalsRef === statement.fields.evidenceRef ? 'met' : 'failed';
            checks.push({ id: 'cited', state, expected: statement.fields.evidenceRef, actual: approvalsRef });
        }

        if (kind !== 'poll') {
            const state = { executed: 'met', active: 'waiting', expired: 'failed', cancelled: 'failed', loading: 'loading', unminted: 'waiting', retired: 'unknown', unreadable: 'unknown' }[execution.state] || 'unknown';
            checks.push({ id: 'execution', state, execution: execution.state });
        }

        const servicesFailed = Object.values(services || {}).includes('error');
        return {
            kind,
            retired,
            lens: { ...lens, members },
            approvals,
            statement,
            statementError: account ? chain?.statementError || null : null,
            execution,
            checks,
            retry: Boolean(receiptsError || (chainError && !retired) || servicesFailed)
        };
    }

    return { build, isRetiredProgram, kindOf, approvalsCountedBy };
});
