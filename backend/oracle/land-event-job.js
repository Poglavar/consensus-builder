// The land-event oracle's job body behind oracle/agreement-lifecycle-job.mjs: checks that the RPC is
// the cluster the index records agreements on, runs one agreement lifecycle pass
// (agreement-lifecycle.js: `onchain` refreshes, `agreement_lifecycle` and per-parcel
// `agreement_executed` land events), then pins what the minted agreements reference on IPFS
// (agreements/pin-minted.js), and turns both results into the run verdict. The pin step runs whether or
// not the lifecycle pass succeeded, and its failures fail the run without hiding the pass's result.
// Every step is injectable, so the ordering and the verdict are testable without RPC or PostgreSQL.

import { syncAgreementLifecycle } from './agreement-lifecycle.js';
import { createPinStore, pinMintedContent, pinProblem } from '../agreements/pin-minted.js';

const defaultPin = ({ pool, cluster, apply, log }) => pinMintedContent({ store: createPinStore(pool), cluster, apply, log });

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
 *   sync?: typeof syncAgreementLifecycle, pin?: Function }} options  chain: agreements/onchain.js createAgreementChain
 * @returns {Promise<{ result: object|null, pins: object|null, error: Error|null, exitCode: 0|1 }>}  result
 *   null when the network check or the pass itself threw; pins null when the network check or the pin step threw
 */
export async function runLandEventJob({ pool, chain, apply = false, now = () => Date.now(), log = timestampedLog, sync = syncAgreementLifecycle, pin = defaultPin } = {}) {
    // Every event is labelled with the cluster: check the RPC really is it before anything is written.
    try {
        await chain.connection();
    } catch (error) {
        log(`network check failed: ${error.message}`);
        return { result: null, pins: null, error, exitCode: 1 };
    }
    const problems = [];
    let result = null;
    let passError = null;
    try {
        result = await sync({ pool, chain, apply, now, log });
        log(`pass done: scanned ${result.scanned} · onchain written ${result.reconciled} · moved ${result.moved} · terminal ${result.terminal} · events ${result.events.length} · inserted ${result.inserted} · invalid ${result.invalidAccounts.length} · missing evidence ${result.missingEvidence.length} · failed ${result.failed.length}${apply ? '' : ' (dry run, nothing written)'}`);
        const problem = landEventProblem(result);
        if (problem) problems.push(problem);
    } catch (error) {
        passError = error;
        log(`agreement lifecycle pass failed: ${error.stack || error.message}`);
    }
    let pins = null;
    try {
        pins = await pin({ pool, cluster: chain.cluster, apply, log });
        const problem = pinProblem(pins);
        if (problem) problems.push(problem);
    } catch (error) {
        log(`pin step failed: ${error.stack || error.message}`);
        problems.push(`pin step failed: ${error.message}`);
    }
    if (passError) {
        const error = problems.length ? new Error(`${passError.message}; ${problems.join('; ')}`) : passError;
        return { result: null, pins, error, exitCode: 1 };
    }
    return { result, pins, error: problems.length ? new Error(problems.join('; ')) : null, exitCode: problems.length ? 1 : 0 };
}
