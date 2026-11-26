// Agreement discovery: the index learns of agreements minted on chain that nobody reported to it.
// Until now the index heard of a mint only when the browser or an agent posted it
// (POST /agreements/:cid/onchain). One pass lists every account of the current agreement program
// (agreements/onchain.js listAccounts: size and discriminator filters, each account checked to sit at
// the PDA of its own sponsor and CID) and, for each one the index lacks or holds without `onchain`:
// fetches the agreement content from IPFS gateways (storage/gateway-read.js: only bytes that hash to the
// account's CID), with its plan and designs when the index lacks them, indexes it through the same
// checks as POST /agreements (routes/agreements.js indexAgreement, judged at the account's own creation
// time) and records `onchain` from the account through the same checks as POST /agreements/:cid/onchain
// (mintedAccountOf, accountRefusal). The account and the content are the proof; no signature, ours
// included, is taken as one. The lifecycle oracle (agreement-lifecycle.js) refreshes the recorded row
// from then on.
//
// Idempotent: a recorded account is skipped, an agreement row is inserted once (ON CONFLICT) and
// `onchain` is written only where it is absent or older. An account that could not be imported is
// recorded in the retry state (agreement-discovery-job.mjs keeps it in a file) and tried again after a
// growing wait, so a missing object costs at most a few gateway requests a day.

import {
    agreementAccountOf, onchainFromAccount, writeOnchain
} from '../agreements/onchain.js';
import { accountRefusal, indexAgreement as indexAgreementWithChecks, mintedAccountOf } from '../routes/agreements.js';

// Accounts imported per pass at most; the rest wait for the next pass (counted as deferred).
export const DEFAULT_MAX_IMPORTS = 10;
// Gateway requests per pass at most (an agreement, its plan and every design the index lacks).
export const DEFAULT_MAX_FETCHES = 60;
// After a failed import the next try waits this long, doubling with each further miss up to a day.
export const RETRY_WAIT_MS = 15 * 60 * 1000;
export const RETRY_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
// How often POST /agreements may answer "send the plan" or "send the designs" before giving up.
const MAX_INDEX_ROUNDS = 3;

/** When an account with this retry entry may next be tried (ms), 0 when it never failed. */
export function nextAttemptAt(entry) {
    const misses = Number(entry?.misses);
    const lastAt = Date.parse(entry?.lastAt || '');
    if (!Number.isSafeInteger(misses) || misses < 1 || !Number.isFinite(lastAt)) return 0;
    return lastAt + Math.min(RETRY_WAIT_MS * 2 ** (misses - 1), RETRY_MAX_WAIT_MS);
}

class ImportProblem extends Error {
    constructor(kind, message, extra = {}) {
        super(message);
        Object.assign(this, { kind, ...extra });
    }
}

/**
 * One discovery pass on `chain` (agreements/onchain.js createAgreementChain: its program is the current
 * agreement program). Dry run unless `apply`: every check runs, gateways are read, nothing is written.
 * @param options.index (body, { now, dryRun }) → { status, body }: POST /agreements's checks
 *   (indexAgreement bound to the pool and its thumbnail queue)
 * @param options.readJson cid → { content, gateway }: gateway-read.js
 * @param options.retries Map account → { cid, misses, lastAt, reason }, read and updated in place
 * @returns {Promise<{ listed, known, recordedElsewhere: object[], invalidAccounts: object[], waiting: object[],
 *   deferred: number, imported: object[], refused: object[], unavailable: object[], failed: object[],
 *   fetches: number, dryRun: boolean }>}  imported: { cid, account, indexed (the row is new), recorded };
 *   refused: the content or account fails the index's checks; unavailable: an object no gateway served
 *   under its CID; failed: a step threw (RPC, database); waiting: earlier failures not due again yet
 */
export async function discoverChainAgreements({
    pool, chain, index, readJson, apply = false, retries = new Map(),
    maxImports = DEFAULT_MAX_IMPORTS, maxFetches = DEFAULT_MAX_FETCHES, now = () => Date.now(), log = () => {}
} = {}) {
    if (!pool || !chain || !index || !readJson) throw new Error('pool, chain, index and readJson are required');
    const result = {
        listed: 0, known: 0, recordedElsewhere: [], invalidAccounts: [], waiting: [], deferred: 0,
        imported: [], refused: [], unavailable: [], failed: [], fetches: 0, dryRun: !apply
    };
    const { slot, rows } = await chain.listAccounts();
    result.listed = rows.length;
    // A retry entry lives only as long as its account does.
    const listedAddresses = new Set(rows.map(row => row.address));
    for (const account of [...retries.keys()]) if (!listedAddresses.has(account)) retries.delete(account);
    log(`${rows.length} agreement account(s) on ${chain.cluster} program ${chain.programId} at slot ${slot}${apply ? '' : ' (dry run: nothing is written)'}`);
    for (const row of rows.filter(entry => entry.problem)) {
        result.invalidAccounts.push({ account: row.address, problem: row.problem });
        log(`account ${row.address}: ${row.problem === 'not-pda' ? 'not at the PDA of its own sponsor and CID' : 'not decodable as an agreement'}; not imported`);
    }
    const valid = rows.filter(entry => !entry.problem)
        .sort((a, b) => (a.account.createdAt - b.account.createdAt) || (a.address < b.address ? -1 : 1));
    if (!valid.length) return result;

    const { rows: indexedRows } = await pool.query(
        'SELECT cid, content, onchain FROM consensus.agreement WHERE cid = ANY($1::text[])',
        [[...new Set(valid.map(entry => entry.account.cid))]]
    );
    const indexed = new Map(indexedRows.map(row => [row.cid, row]));
    const due = [];
    for (const read of valid) {
        const row = indexed.get(read.account.cid) ?? null;
        if (row?.onchain) {
            if (row.onchain.programId === chain.programId && row.onchain.account === read.address) {
                result.known += 1;
                retries.delete(read.address);
            } else {
                // Most likely recorded on a retired program; the agreement's own row says where. Left as it
                // is: replacing a recorded mint is the remint flow's decision, not discovery's.
                result.recordedElsewhere.push({ cid: read.account.cid, account: read.address, recordedAs: `${row.onchain.programId}/${row.onchain.account}` });
                log(`account ${read.address}: ${read.account.cid} is recorded as ${row.onchain.programId}/${row.onchain.account}; left as it is`);
            }
            continue;
        }
        const retryAt = nextAttemptAt(retries.get(read.address));
        if (retryAt > now()) {
            const entry = retries.get(read.address);
            result.waiting.push({ cid: read.account.cid, account: read.address, misses: entry.misses, reason: entry.reason, nextAt: new Date(retryAt).toISOString() });
            continue;
        }
        due.push({ read, row });
    }
    if (result.known) log(`${result.known} account(s) already recorded`);
    if (result.waiting.length) log(`${result.waiting.length} account(s) wait for their next try after earlier failures`);
    const attempt = due.slice(0, maxImports);
    result.deferred = due.length - attempt.length;
    if (result.deferred) log(`${result.deferred} account(s) deferred to the next pass (at most ${maxImports} a pass)`);

    // Gateway reads within the pass budget; running out defers the account instead of failing it.
    const fetchJson = async cid => {
        if (result.fetches >= maxFetches) throw new ImportProblem('budget', `the pass used its ${maxFetches} gateway reads`);
        result.fetches += 1;
        try {
            return (await readJson(cid)).content;
        } catch (error) {
            // A CID that is not one of the index's scheme can never be fetched or indexed: the account is refused.
            if (error.code === 'invalid-cid') throw new ImportProblem('refused', error.message, { code: 'invalid-cid', object: cid });
            if (error.code === 'content-unavailable' || error.code === 'content-not-json') {
                throw new ImportProblem('unavailable', error.message, { object: cid });
            }
            throw error;
        }
    };

    for (let position = 0; position < attempt.length; position += 1) {
        const { read, row } = attempt[position];
        const step = `${position + 1}/${attempt.length} ${read.account.cid} (${read.address})`;
        const item = { cid: read.account.cid, account: read.address };
        try {
            const outcome = await importAccount({ read, row });
            result.imported.push({ ...item, ...outcome });
            retries.delete(read.address);
            log(`${step}: ${outcome.indexed ? 'indexed' : 'already indexed'}, ${apply ? (outcome.recorded ? 'onchain recorded' : 'a later observation was already stored') : 'would record onchain'}`);
        } catch (error) {
            if (error.kind === 'budget') {
                result.deferred += attempt.length - position;
                log(`${step}: ${error.message}; ${attempt.length - position} account(s) deferred to the next pass`);
                break;
            }
            const kind = error instanceof ImportProblem ? error.kind : 'failed';
            const entry = { ...item, error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.object ? { object: error.object } : {}) };
            result[kind === 'refused' ? 'refused' : kind === 'unavailable' ? 'unavailable' : 'failed'].push(entry);
            const misses = (Number(retries.get(read.address)?.misses) || 0) + 1;
            retries.set(read.address, { cid: read.account.cid, misses, lastAt: new Date(now()).toISOString(), reason: `${kind}: ${error.message}`.slice(0, 500) });
            log(`${step}: ${kind.toUpperCase()} ${kind === 'failed' ? (error.stack || error.message) : error.message} (miss ${misses})`);
        }
    }
    return result;

    // Indexes the account's agreement when the index lacks it, then records `onchain` from the account.
    async function importAccount({ read, row }) {
        const { account } = read;
        const cid = account.cid;
        let content = row?.content ?? null;
        let indexedNow = false;
        if (!row) {
            // Judged when the account was created: the chain's own time, as close to publication as the chain knows.
            if (!Number.isSafeInteger(account.createdAt) || account.createdAt <= 0) {
                throw new ImportProblem('refused', `account ${read.address} has no creation time`);
            }
            const createdAtMs = account.createdAt * 1000;
            content = await fetchJson(cid);
            let body = { cid, content };
            for (let round = 1; ; round += 1) {
                const answer = await index(body, { now: () => createdAtMs, dryRun: !apply });
                const existing = answer.status === 409 && answer.body?.cid === cid && !answer.body?.code;
                if (answer.status === 201 || (answer.status === 200 && answer.body?.dryRun) || existing) {
                    indexedNow = !existing;
                    break;
                }
                const code = answer.body?.code;
                if (round < MAX_INDEX_ROUNDS && code === 'plan-not-indexed' && !body.plan) {
                    body = { ...body, plan: { cid: content.planCid, content: await fetchJson(content.planCid) } };
                    continue;
                }
                if (round < MAX_INDEX_ROUNDS && code === 'design-not-indexed' && !body.designs && Array.isArray(answer.body.missing)) {
                    const designs = [];
                    for (const designCid of answer.body.missing) designs.push({ cid: designCid, content: await fetchJson(designCid) });
                    body = { ...body, designs };
                    continue;
                }
                throw new ImportProblem('refused', `the index refuses it: ${answer.body?.error || `HTTP ${answer.status}`}`, { code: code || `http-${answer.status}` });
            }
        }

        const mint = mintedAccountOf(cid, content);
        if (mint.refusal) throw new ImportProblem('refused', mint.refusal.body.error, { code: mint.refusal.body.code });
        if (mint.expected !== read.address || agreementAccountOf(cid, account.authority, chain.programId) !== read.address) {
            throw new ImportProblem('refused', `the agreement's account is ${mint.expected}, not ${read.address}`, { code: 'onchain-account-mismatch' });
        }
        const refusal = accountRefusal({ cid, content, read, expected: mint.expected, sponsor: mint.sponsor, cluster: chain.cluster });
        if (refusal) throw new ImportProblem('refused', refusal.body.error, { code: refusal.body.code });
        const onchain = onchainFromAccount(account, {
            cluster: chain.cluster, programId: chain.programId, observedAt: new Date(now()).toISOString(), observedSlot: read.slot
        });
        const recorded = apply ? await writeOnchain(pool, cid, onchain) : false;
        return { indexed: indexedNow, recorded, status: onchain.status };
    }
}

/** POST /agreements's checks bound to a pool and its route dependencies ({ thumbnailQueue, baseUrl }). */
export function agreementIndexer(pool, deps = {}) {
    return (body, options) => indexAgreementWithChecks(pool, deps, body, options);
}

/**
 * The job body behind agreement-discovery-job.mjs: checks that the RPC is the cluster `onchain` will
 * name, runs one pass and turns its result into the run verdict. `pass` is discoverChainAgreements's
 * options. @returns {Promise<{ result: object|null, error: Error|null, exitCode: 0|1 }>}
 */
export async function runAgreementDiscoveryJob({ chain, log = () => {}, discover = discoverChainAgreements, ...pass } = {}) {
    try {
        await chain.connection();
    } catch (error) {
        log(`network check failed: ${error.message}`);
        return { result: null, error, exitCode: 1 };
    }
    let result;
    try {
        result = await discover({ chain, log, ...pass });
    } catch (error) {
        log(`discovery pass failed: ${error.stack || error.message}`);
        return { result: null, error, exitCode: 1 };
    }
    log(`pass done: listed ${result.listed} → already recorded ${result.known} · recorded elsewhere ${result.recordedElsewhere.length} · `
        + `${result.dryRun ? 'would import' : 'imported'} ${result.imported.length} (${result.imported.filter(item => item.indexed).length} newly indexed) · `
        + `refused ${result.refused.length} · unavailable ${result.unavailable.length} · failed ${result.failed.length} · invalid ${result.invalidAccounts.length} · `
        + `waiting ${result.waiting.length} · deferred ${result.deferred} · gateway reads ${result.fetches}${result.dryRun ? ' (dry run, nothing written)' : ''}`);
    const problem = discoveryProblem(result);
    return { result, error: problem ? new Error(problem) : null, exitCode: problem ? 1 : 0 };
}

/** Retry state as the job keeps it in a file: { version: 1, accounts: { [account]: entry } } ↔ Map. */
export function retriesFromState(state) {
    const accounts = state && typeof state === 'object' && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
    return new Map(Object.entries(accounts));
}

export function stateFromRetries(retries) {
    return { version: 1, accounts: Object.fromEntries([...retries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** Why a finished pass must fail its run, or null. Every account that failed in this pass poisons the
 * verdict (refused, unavailable, failed), as does an account the program holds outside its PDA. One
 * still waiting for its next try does not: it fails the pass that tries it again, at least once a day
 * (RETRY_MAX_WAIT_MS), and the run stats count it as waiting in between. */
export function discoveryProblem(result) {
    const problems = [];
    if (result.invalidAccounts.length) problems.push(`${result.invalidAccounts.length} account(s) not at their agreement's PDA or not decodable`);
    if (result.refused.length) problems.push(`${result.refused.length} refused by the index's checks: ${result.refused.slice(0, 3).map(item => `${item.cid} (${item.error})`).join(', ')}`);
    if (result.unavailable.length) problems.push(`${result.unavailable.length} with content no gateway serves: ${result.unavailable.slice(0, 3).map(item => item.object || item.cid).join(', ')}`);
    if (result.failed.length) problems.push(`${result.failed.length} failed: ${result.failed.slice(0, 3).map(item => `${item.cid} (${item.error})`).join(', ')}`);
    return problems.length ? problems.join('; ') : null;
}
