// Open-ground audit (PARCEL-OPTIONAL.md phase 3, item 5): compares each proposal_nft v3 account's
// proposer-declared `site_hash`, `open_ground` and `parcel_ids` with the published record's site and
// server binding, which are authoritative off chain. It REPORTS mismatches and never fixes anything.
//
// The pure comparison is `auditOpenGround(accounts, records)`; `runOpenGroundAudit({ pool, connection })`
// is the thin I/O wrapper (proposal accounts by discriminator over RPC, records from the proposal table).
// Accounts are told apart by `layout_version`, which every v3 mint writes as 3: v1/v2 accounts read 0
// (zero padding) and are skipped as legacy, so a zero site hash on a v3 account is a real claim.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { encodeBase58 } from '../solana/tx-decoder.js';
import { decodeProposalState } from '../agents/lifecycle-actions.js';
import { PROPOSAL_PROGRAM_ID } from './proposal-lifecycle.js';

const siteHashApi = createRequire(import.meta.url)('../../frontend/js/proposals/site-hash.js');

export const PROPOSAL_ACCOUNT_DISCRIMINATOR = createHash('sha256').update('account:Proposal').digest().subarray(0, 8);
// Set by scripts/migrate-proposal-sites.mjs on bindings it attached to existing records. Such a site
// was added after the proposal was minted, so a zero site hash on its account is not a lie.
export const SITE_MIGRATION_ID = 'proposal-sites-v1';
export const SITE_MIGRATION_SOURCE = 'migration:declaration';

// proposal_nft's PROPOSAL_LAYOUT_VERSION: the first layout that carries site_hash/open_ground.
export const SITE_LAYOUT_VERSION = 3;

export const MISMATCH_KINDS = Object.freeze([
    'record-missing',          // the account has a site hash but no published record claims it
    'record-ambiguous',        // more than one published record claims the same account
    'site-hash-mismatch',      // account hash ≠ hash of the record's site
    'site-missing',            // one side has a site and the other does not
    'open-ground-understated', // record: open ground; account: open_ground false (consent-only over unowned ground)
    'open-ground-overstated',  // account: open_ground; record: complete binding with parcels (advisory)
    'parcels-mismatch'         // account parcel_ids ≠ record declaration or binding parcels
]);

function uniqueSorted(values) {
    return [...new Set((values || []).map(value => String(value)))].sort();
}

function difference(left, right) {
    const other = new Set(right);
    return left.filter(value => !other.has(value));
}

function isSiteMigrated(binding) {
    return Boolean(binding && (binding.migration === SITE_MIGRATION_ID || binding.source === SITE_MIGRATION_SOURCE));
}

/** The parcels the record binds: the server binding's when it has one, else the declaration. */
function recordParcels(record) {
    if (record.binding && Array.isArray(record.binding.parcels)) {
        return uniqueSorted(record.binding.parcels.map(entry => (entry && typeof entry === 'object' ? entry.parcelId : entry)));
    }
    return uniqueSorted(record.cadastreParcelIds);
}

/**
 * Pure comparison. Each account is checked against the one record that names it.
 *
 * @param {{ address: string, parcelIds: string[], siteHash: string|null, openGround: boolean,
 *   layoutVersion?: number }[]} accounts decoded proposal accounts; `siteHash` lowercase hex, null for
 *   the zero hash; `layoutVersion` 0 (or absent) for a v1/v2 account, which is skipped as
 *   `legacy-layout`, 3 for a v3 mint, whose zero hash against a record with its own site is
 *   `site-missing` (unless the site migration attached that site after the mint).
 * @param {{ id, proposalId?, account: string, site: object|null, binding: object|null,
 *   cadastreParcelIds: string[], createdAt?: string }[]} records published records keyed by account.
 * @returns {Promise<{ accounts: number, checked: number, mismatches: object[], skipped: object[],
 *   byKind: Record<string, number>, skippedByReason: Record<string, number> }>}
 */
export async function auditOpenGround(accounts, records) {
    const byAccount = new Map();
    for (const record of records || []) {
        if (!record?.account) continue;
        const list = byAccount.get(record.account) || [];
        list.push(record);
        byAccount.set(record.account, list);
    }
    const mismatches = [];
    const skipped = [];
    let checked = 0;

    for (const account of accounts || []) {
        const claims = byAccount.get(account.address) || [];
        const record = claims.length === 1 ? claims[0] : null;
        const proposal = {
            account: account.address,
            recordId: record?.id ?? null,
            proposalId: record?.proposalId ?? null
        };
        const hasHash = typeof account.siteHash === 'string' && account.siteHash.length === 64;

        if (claims.length > 1) {
            mismatches.push({ kind: 'record-ambiguous', proposal, recordIds: claims.map(item => item.id) });
            checked += 1;
            continue;
        }
        const layoutVersion = Number.isInteger(account.layoutVersion) ? account.layoutVersion : 0;
        if (layoutVersion < SITE_LAYOUT_VERSION) {
            // v1/v2: minted before sites existed, so there is nothing to compare.
            skipped.push({ reason: 'legacy-layout', proposal, layoutVersion });
            continue;
        }
        if (!record) {
            if (hasHash) {
                mismatches.push({ kind: 'record-missing', proposal, siteHash: account.siteHash, openGround: account.openGround });
                checked += 1;
            } else {
                skipped.push({ reason: 'no-record-no-site', proposal });
            }
            continue;
        }

        const parcels = recordParcels(record);
        const coverage = record.binding && typeof record.binding === 'object' ? record.binding.coverage ?? null : null;
        if (!hasHash && record.site && parcels.length > 0 && isSiteMigrated(record.binding)) {
            // A v3 mint with parcels and no site, whose record got its site from the migration later.
            skipped.push({ reason: 'site-migrated', proposal, note: 'record site was attached by the site migration after the mint' });
            continue;
        }

        checked += 1;
        let expected = null;
        if (record.site) {
            try {
                const args = await siteHashApi.chainSiteArgs({ site: record.site, binding: record.binding || null, parcelIds: parcels });
                expected = { siteHash: siteHashApi.siteHashFromChain(args.siteHash), openGround: args.openGround };
            } catch (error) {
                mismatches.push({ kind: 'site-hash-mismatch', proposal, account: account.siteHash, record: null,
                    error: `record site cannot be hashed: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
        const recordOpenGround = expected ? expected.openGround : parcels.length === 0;

        if (hasHash && !record.site) {
            mismatches.push({ kind: 'site-missing', proposal, side: 'record', siteHash: account.siteHash });
        } else if (!hasHash && record.site) {
            mismatches.push({ kind: 'site-missing', proposal, side: 'account', expectedSiteHash: expected?.siteHash ?? null });
        } else if (hasHash && expected && expected.siteHash !== account.siteHash) {
            mismatches.push({ kind: 'site-hash-mismatch', proposal, account: account.siteHash, record: expected.siteHash });
        }

        if (recordOpenGround && !account.openGround) {
            mismatches.push({ kind: 'open-ground-understated', proposal, coverage, recordParcels: parcels.length,
                unsurveyedM2: record.binding?.unsurveyedM2 ?? null });
        } else if (!recordOpenGround && account.openGround) {
            mismatches.push({ kind: 'open-ground-overstated', proposal, coverage, recordParcels: parcels.length });
        }

        const onChain = uniqueSorted(account.parcelIds);
        const sources = [['declaration', uniqueSorted(record.cadastreParcelIds)]];
        if (record.binding && Array.isArray(record.binding.parcels)) sources.push(['binding', parcels]);
        for (const [against, ids] of sources) {
            const missing = difference(ids, onChain);
            const extra = difference(onChain, ids);
            if (missing.length || extra.length) mismatches.push({ kind: 'parcels-mismatch', proposal, against, missing, extra });
        }
    }

    const count = (items, key) => items.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] || 0) + 1; return acc; }, {});
    return {
        accounts: (accounts || []).length,
        checked,
        mismatches,
        skipped,
        byKind: count(mismatches, 'kind'),
        skippedByReason: count(skipped, 'reason')
    };
}

/** A proposal row (as selected by RECORDS_SQL) → the record shape `auditOpenGround` compares. */
export function recordFromRow(row) {
    const data = row.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {};
    const siteColumn = typeof row.site_geojson === 'string' ? JSON.parse(row.site_geojson) : row.site_geojson || null;
    return {
        id: row.id,
        proposalId: row.proposal_id ?? null,
        account: row.proposal_account,
        site: siteColumn || data.site || null,
        binding: row.binding || data.binding || null,
        cadastreParcelIds: Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : [],
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null
    };
}

// Same account key sources as the lifecycle oracle (proposal-lifecycle.js syncProposalLifecycleEvents).
export const RECORDS_SQL = `
    SELECT id, proposal_id, cadastre_parcel_ids, proposal_data, binding, created_at,
           ST_AsGeoJSON(site) AS site_geojson,
           COALESCE(
               onchain_data->>'proposalId',
               proposal_data #>> '{onchain,proposalId}',
               proposal_data #>> '{onchainData,proposalId}'
           ) AS proposal_account
    FROM proposal
    WHERE COALESCE(
        onchain_data->>'proposalId',
        proposal_data #>> '{onchain,proposalId}',
        proposal_data #>> '{onchainData,proposalId}'
    ) IS NOT NULL
`;

/**
 * Loads every proposal_nft Proposal account and every published record that names one. Accounts that
 * do not decode are returned in `undecodable` (never silently dropped).
 */
export async function loadOpenGroundAuditInputs({ pool, connection, programId = PROPOSAL_PROGRAM_ID } = {}) {
    if (!pool || !connection) throw new Error('pool and connection are required');
    const raw = await connection.getProgramAccounts(new PublicKey(programId), {
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(PROPOSAL_ACCOUNT_DISCRIMINATOR) } }]
    });
    const accounts = [];
    const undecodable = [];
    for (const { pubkey, account } of raw || []) {
        const address = pubkey?.toBase58?.() ?? String(pubkey);
        try {
            const state = decodeProposalState(account.data);
            accounts.push({ address, parcelIds: state.parcelIds, siteHash: state.siteHash, openGround: state.openGround,
                layoutVersion: state.layoutVersion });
        } catch (error) {
            undecodable.push({ address, error: error instanceof Error ? error.message : String(error) });
        }
    }
    const result = await pool.query(RECORDS_SQL);
    return { accounts, records: (result.rows || []).map(recordFromRow), undecodable };
}

/** I/O wrapper: load, compare, and report. Read-only. */
export async function runOpenGroundAudit({ pool, connection, programId } = {}) {
    const { accounts, records, undecodable } = await loadOpenGroundAuditInputs({ pool, connection, programId });
    const report = await auditOpenGround(accounts, records);
    return { ...report, records: records.length, undecodable };
}
