// The agreements the support and society agents act on: newest-first pages of the index (GET
// /agreements, per city or all cities), each with its chain account (PDA(sponsor, CID), only the
// sponsor can create it) and that account's status read from the chain in batches. The index's own
// status lags the chain, so a policy only ever acts on the chain's word; an agreement whose account
// does not exist yet (or that names no sponsor) is not minted and is never a target.
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountOf } from './agreement-minter.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../frontend/js/solana/agreement-client.js');

// GET /agreements answers at most this many rows per call (routes/designs.js MAX_DESIGN_LIST_LIMIT).
export const AGREEMENT_PAGE = 1000;

/** One index row as the policies read it: the CID is the key, the account the chain subject. */
export function agreementSummary(row) {
    const content = row?.content || {};
    if (!row?.cid) throw new Error('agreement row is missing its CID');
    const sponsor = typeof content.sponsor === 'string' && content.sponsor ? content.sponsor : null;
    let account = null;
    if (sponsor) {
        try { account = agreementAccountOf(row.cid, sponsor); } catch (_) { account = null; }
    }
    return {
        cid: row.cid,
        name: row.title || content.title || row.cid,
        city: row.city ?? null,
        author: row.author ?? content.author ?? null,
        sponsor,
        account,
        createdAt: row.createdAt ?? content.createdAt ?? null,
        deadline: row.deadline ?? content.deadline ?? null,
        planCid: row.planCid ?? content.planCid ?? null,
        designCids: Array.isArray(row.designCids) ? row.designCids : [],
        inputParcelIds: row.inputParcelIds || [],
        rule: content.rule || null,
        // Filled from the chain by readAgreementStatuses: 'active' | 'executed' | 'cancelled' | 'expired',
        // or null while the account does not exist.
        chainStatus: null
    };
}

/**
 * The newest agreements of each city (null = every city), de-duplicated, newest first. A page cut at
 * AGREEMENT_PAGE is logged, never silent.
 * @param index publication-client.js createIndexClient()
 */
export async function discoverAgreements({ index, cities, log = () => {} }) {
    const byCid = new Map();
    for (const city of cities) {
        const page = await index.listAgreements({ city, limit: AGREEMENT_PAGE });
        if (page.agreements.length >= AGREEMENT_PAGE) log(`${city || 'all cities'}: read the newest ${AGREEMENT_PAGE} agreements (the index answers at most that many)`);
        for (const row of page.agreements) if (!byCid.has(row.cid)) byCid.set(row.cid, agreementSummary(row));
    }
    return Array.from(byCid.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * Set chainStatus on every agreement with an account, from one batched read of the accounts. An account
 * owned by another program, or holding another CID or sponsor, fails the whole read: nothing acts on it.
 */
export async function readAgreementStatuses(agreements, connection, { env = process.env, programId = AGREEMENT_PROGRAM_ID } = {}) {
    const withAccount = (agreements || []).filter(agreement => agreement.account);
    if (!withAccount.length) return agreements;
    const infos = await getMultipleAccountsBatched(connection, withAccount.map(agreement => new PublicKey(agreement.account)), { batchSize: accountsPerRequest(env) });
    const program = new PublicKey(programId);
    const statuses = withAccount.map((agreement, index) => {
        const info = infos[index];
        if (!info?.data) return null;
        if (!info.owner || !new PublicKey(info.owner).equals(program)) throw new Error(`agreement ${agreement.cid}: account ${agreement.account} is not owned by the agreement program`);
        const state = agreementClient.readAgreement(Uint8Array.from(info.data), agreement.account);
        if (!state) throw new Error(`agreement ${agreement.cid}: account ${agreement.account} is not an Agreement account`);
        if (state.cid !== agreement.cid || state.authority !== agreement.sponsor) {
            throw new Error(`agreement ${agreement.cid}: account ${agreement.account} holds ${state.cid} of ${state.authority}`);
        }
        return state.status.toLowerCase();
    });
    withAccount.forEach((agreement, index) => { agreement.chainStatus = statuses[index]; });
    return agreements;
}

/** Minted: its account exists on chain. */
export const isMinted = agreement => Boolean(agreement?.account && agreement.chainStatus);

/** Open for support: Active on chain and before its deadline (a passed deadline can only expire). */
export function isOpen(agreement, now = Date.now()) {
    if (agreement?.chainStatus !== 'active') return false;
    const deadline = Date.parse(agreement.deadline || '');
    return !Number.isFinite(deadline) || deadline > now;
}
