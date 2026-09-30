// The land-oracle job body behind scripts/sync-land-events.mjs: first top up the transaction store
// (terminal proposals are matched to their executing transaction from that store, so a stale store
// means "missing evidence"), then materialize proposal lifecycle events, then the lens-model v2
// evidence log (acceptance and verdict events, attester directory; a no-op until v2 is deployed).
// Every step is injectable so the ordering and failure verdicts are unit-testable without RPC or
// PostgreSQL.

import { IDL_DIR, syncProposalLifecycleEvents } from './proposal-lifecycle.js';
import { syncProposalConsentEvents } from './proposal-consent.js';
import { decodeParsedTransaction, loadIdls } from '../solana/tx-decoder.js';
import { runTransactionSync, timestampedLog } from '../solana/transaction-sync-job.js';

function defaultSyncConsent(options) {
    const idls = loadIdls(IDL_DIR);
    return syncProposalConsentEvents({ ...options, decode: raw => decodeParsedTransaction(raw, { idls }) });
}

const EMPTY_TRANSACTION_SYNC = Object.freeze({ scanned: 0, newSignatures: 0, fetched: 0, failed: 0, error: null });

/** Why a transaction sync must fail the run, or null. Unfetched signatures are per-item failures. */
export function transactionSyncProblem(sync) {
    if (!sync || sync.skipped) return null;
    if (sync.error) return `transaction sync incomplete: ${sync.error}`;
    if (sync.failed > 0) return `transaction sync incomplete: ${sync.failed} signature(s) could not be fetched`;
    return null;
}

/**
 * @returns {Promise<{result: object|null, error: Error|null, exitCode: 0|1}>}
 *   `result` is the lifecycle result plus `transactionSync` (its counters, `error`, `skipped`);
 *   null only when the lifecycle scan itself threw (`error`).
 */
export async function runLandEventJob({
    pool,
    connection,
    dryRun = false,
    syncTransactionsFirst = true,
    transactionSync = options => runTransactionSync(options),
    syncLifecycle = syncProposalLifecycleEvents,
    syncConsent = defaultSyncConsent,
    log = timestampedLog
} = {}) {
    let transactionSyncSummary;
    if (!syncTransactionsFirst) {
        transactionSyncSummary = { ...EMPTY_TRANSACTION_SYNC, skipped: true };
        log('transaction sync skipped (--skip-transaction-sync); terminal proposals are matched against the store as it is');
    } else {
        log('transaction sync: topping up consensus.solana_transaction before the land-event scan (writes the store even in a land-event dry run)');
        try {
            const synced = await transactionSync({ pool, connection, log });
            transactionSyncSummary = {
                scanned: Number(synced?.scanned || 0),
                newSignatures: Number(synced?.newSignatures || 0),
                fetched: Number(synced?.fetched || 0),
                failed: Number(synced?.failed || 0),
                error: synced?.error || null,
                skipped: false
            };
        } catch (error) {
            // A database or personas failure here must not stop the scan: the store may already
            // hold the evidence. The failure still fails the run below.
            transactionSyncSummary = { ...EMPTY_TRANSACTION_SYNC, error: error.message, skipped: false };
        }
        const t = transactionSyncSummary;
        log(`transaction sync: scanned ${t.scanned} · new ${t.newSignatures} · fetched ${t.fetched} · failed ${t.failed}${t.error ? ` · ERROR ${t.error}` : ''}`);
    }

    let lifecycle;
    try {
        lifecycle = await syncLifecycle({
            pool,
            connection,
            dryRun,
            onProgress: progress => log(`${progress.phase} ${progress.done}/${progress.total}`)
        });
    } catch (error) {
        log(`land-event sync failed: ${error.stack || error.message}`);
        return { result: null, error, exitCode: 1, transactionSync: transactionSyncSummary };
    }

    // The consent step runs after the lifecycle so a failure here never hides lifecycle results;
    // it still fails the run.
    let consent;
    let consentError = null;
    try {
        consent = await syncConsent({
            pool,
            connection,
            dryRun,
            onProgress: progress => log(`${progress.phase} ${progress.done}/${progress.total}`)
        });
    } catch (error) {
        consentError = error;
        consent = null;
        log(`consent evidence sync failed: ${error.stack || error.message}`);
    }

    const result = { ...lifecycle, consent, transactionSync: transactionSyncSummary };
    log(`land events: scanned ${result.scanned} · terminal ${result.terminal} · events ${result.events.length} · inserted ${result.inserted} · reconciled ${result.reconciled} · missingEvidence ${result.missingEvidence.length}${dryRun ? ' (dry run, nothing inserted)' : ''}`);
    if (consent) {
        log(`consent evidence: records ${consent.records} · acceptance events ${consent.acceptanceEvents} · verdict events ${consent.verdictEvents} · inserted ${consent.inserted} · members ${consent.members} · missingEvidence ${consent.missingEvidence.length} · invalidRecords ${consent.invalidRecords.length}${dryRun ? ' (dry run, nothing written)' : ''}`);
    }
    const problem = transactionSyncProblem(transactionSyncSummary)
        ?? (consentError ? `consent evidence sync failed: ${consentError.message}` : null);
    const consentIncomplete = Boolean(consent && (consent.missingEvidence.length || consent.invalidRecords.length));
    return {
        result,
        error: problem ? new Error(problem) : null,
        exitCode: problem || result.missingEvidence.length || consentIncomplete ? 1 : 0,
        transactionSync: transactionSyncSummary
    };
}
