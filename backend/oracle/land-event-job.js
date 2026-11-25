// The land-event oracle's job body behind oracle/agreement-lifecycle-job.mjs: checks that the RPC is
// the cluster the index records agreements on, runs one agreement lifecycle pass
// (agreement-lifecycle.js: `onchain` refreshes, `agreement_lifecycle` and per-parcel
// `agreement_executed` land events) and turns its result into the run verdict. Every step is
// injectable, so the ordering and the verdict are testable without RPC or PostgreSQL.

import { syncAgreementLifecycle } from './agreement-lifecycle.js';

export const timestampedLog = message => console.log(`[${new Date().toISOString()}] [agreement-lifecycle] ${message}`);

/** Why a finished pass must fail the run, or null: accounts that are not the agreement's, terminal
 * accounts whose transaction was not found and agreements whose step threw are per-item failures
 * that poison the verdict. */
export function landEventProblem(result) {
    const problems = [];
    if (result.invalidAccounts.length) problems.push(`${result.invalidAccounts.length} agreement account(s) missing or not the agreement's`);
    if (result.missingEvidence.length) problems.push(`${result.missingEvidence.length} terminal agreement(s) lack their transaction`);
    if (result.failed.length) problems.push(`${result.failed.length} agreement(s) failed: ${result.failed.slice(0, 3).map(item => `${item.cid} (${item.error})`).join(', ')}`);
    return problems.length ? problems.join('; ') : null;
}

/**
 * @param {{ pool, chain, apply?: boolean, now?: () => number, log?: (message: string) => void,
 *   sync?: typeof syncAgreementLifecycle }} options  chain: agreements/onchain.js createAgreementChain
 * @returns {Promise<{ result: object|null, error: Error|null, exitCode: 0|1 }>}  result null only when
 *   the network check or the pass itself threw
 */
export async function runLandEventJob({ pool, chain, apply = false, now = () => Date.now(), log = timestampedLog, sync = syncAgreementLifecycle } = {}) {
    // Every event is labelled with the cluster: check the RPC really is it before anything is written.
    try {
        await chain.connection();
    } catch (error) {
        log(`network check failed: ${error.message}`);
        return { result: null, error, exitCode: 1 };
    }
    let result;
    try {
        result = await sync({ pool, chain, apply, now, log });
    } catch (error) {
        log(`agreement lifecycle pass failed: ${error.stack || error.message}`);
        return { result: null, error, exitCode: 1 };
    }
    log(`pass done: scanned ${result.scanned} · onchain written ${result.reconciled} · moved ${result.moved} · terminal ${result.terminal} · events ${result.events.length} · inserted ${result.inserted} · invalid ${result.invalidAccounts.length} · missing evidence ${result.missingEvidence.length} · failed ${result.failed.length}${apply ? '' : ' (dry run, nothing written)'}`);
    const problem = landEventProblem(result);
    return { result, error: problem ? new Error(problem) : null, exitCode: problem ? 1 : 0 };
}
