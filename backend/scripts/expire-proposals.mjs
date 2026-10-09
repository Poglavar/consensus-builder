#!/usr/bin/env node
// Auto-settlement of expired proposals: every minted proposal whose `expires_at` has passed and that
// is still Active on-chain gets the lifecycle lens member's "expired" verdict (settle_with_verdict),
// and its yes/no pool, if one exists, is then resolved NO. This is what makes a bet with a closing
// date actually close. Dry run by default; --run signs. Idempotent: the chain is the checkpoint
// (an Expired proposal or a resolved pool is skipped on a rerun), and the run reports what it skipped.
//
//   node scripts/expire-proposals.mjs [--run] [--city <id>] [--limit <n>] [--keypair <file>]
//
// Needs AGENT_LIFECYCLE_LENS_SERVICE_URL + AGENT_LIFECYCLE_LENS_OPERATOR_TOKEN (the member that signs
// verdicts), SOLANA_RPC_URL and PG* in backend/.env. The submitter keypair pays the verdict record's
// rent and the resolve fee; it needs devnet SOL only.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import { lifecycleLensConfig } from '../agents/run-policy.js';
import { fetchLensStatus } from '../agents/lens-ownership-client.js';
import { decodeProposalState, expireWithVerdict, resolveProposalMarket } from '../agents/lifecycle-actions.js';
import { EFFECTIVE_STATUS_SQL } from '../routes/proposals.js';
import { proposalAccountOf } from '../markets/contests.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3 });

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
const DEFAULT_LIMIT = 20;
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/expire-proposals.mjs [options]',
        '',
        '  --run               Sign the verdicts and resolve the pools. Without it: list what would be settled.',
        '  --city <id>         Only this city (default: every city).',
        `  --limit <n>         At most this many proposals per run (default ${DEFAULT_LIMIT}).`,
        '  --keypair <file>    Submitter keypair JSON (default $AGENT_EXPIRY_KEYPAIR, else ~/.config/solana/ugt-lifecycle-01.json).',
        '  --help              This text.'
    ].join('\n'));
    process.exit(code);
}

// Pure: which rows the job acts on. A row qualifies when its expiry has passed, it is minted on Solana,
// the chain still says Active, and the lifecycle member sits in its lens (otherwise its verdict could
// not settle the proposal). Every other row is reported with the reason it was skipped.
export function selectExpiryCandidates(rows, { statuses, now = new Date(), lifecycleKey }) {
    const selected = [];
    const skipped = [];
    for (const row of rows) {
        const account = proposalAccountOf(row.onchain_data);
        const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
        const skip = reason => skipped.push({ proposalId: row.proposal_id, account, reason });
        if (!account) { skip('not minted on Solana'); continue; }
        if (!expiresAt || Number.isNaN(expiresAt.getTime())) { skip('no expiry'); continue; }
        if (expiresAt.getTime() > now.getTime()) { skip('not expired yet'); continue; }
        const state = statuses.get(account);
        if (!state) { skip('proposal account unreadable'); continue; }
        if (state.status !== 'Active') { skip(`already ${state.status} on-chain`); continue; }
        if (lifecycleKey && !(state.lens || []).includes(lifecycleKey)) { skip('lifecycle member not in its lens'); continue; }
        selected.push({ proposalId: row.proposal_id, account, city: row.city, title: row.title, expiresAt, lens: state.lens || [] });
    }
    return { selected, skipped };
}

function loadKeypair(file) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')));
    return Keypair.fromSecretKey(secret);
}

async function readStatuses(connection, accounts) {
    const result = new Map();
    for (let offset = 0; offset < accounts.length; offset += 100) {
        const slice = accounts.slice(offset, offset + 100);
        const infos = await connection.getMultipleAccountsInfo(slice.map(account => new web3.PublicKey(account)), 'confirmed');
        slice.forEach((account, index) => {
            const info = infos[index];
            if (!info || !info.data) return;
            try {
                const state = decodeProposalState(info.data);
                result.set(account, { status: STATUS_NAMES[state.status] || `status-${state.status}`, lens: (state.lens || []).map(key => key.toBase58 ? key.toBase58() : String(key)) });
            } catch (error) {
                log(`proposal ${account} did not decode: ${error.message}`);
            }
        });
    }
    return result;
}

async function main() {
    const { values } = parseArgs({
        options: { run: { type: 'boolean', default: false }, city: { type: 'string' }, limit: { type: 'string' }, keypair: { type: 'string' }, help: { type: 'boolean', default: false } },
        strict: true
    });
    if (values.help) usage(0);
    const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');

    const lensConfig = lifecycleLensConfig(process.env);
    if (!lensConfig) throw new Error('AGENT_LIFECYCLE_LENS_SERVICE_URL is not set: no lifecycle member can sign expiry verdicts');
    const status = await fetchLensStatus({ serviceUrl: lensConfig.serviceUrl });
    const lifecycle = { ...lensConfig, key: status.key, credentialName: status.credentialName || undefined };
    log(`lifecycle lens member ${lifecycle.key} at ${lifecycle.serviceUrl}`);

    const pool = new pg.Pool();
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    try {
        const params = [];
        const cityClause = values.city ? `AND city = $${params.push(values.city)}` : '';
        const { rows } = await pool.query(`
            SELECT id, proposal_id, city, COALESCE(title, name) AS title, expires_at, onchain_data, ${EFFECTIVE_STATUS_SQL} AS effective_status
            FROM proposal
            WHERE expires_at IS NOT NULL AND expires_at <= now()
              AND onchain_data->>'chainId' LIKE 'solana%'
              AND LOWER(COALESCE(lifecycle_status, '')) NOT IN ('executed', 'cancelled', 'expired')
              ${cityClause}
            ORDER BY expires_at ASC
            LIMIT 500`, params);
        const accounts = Array.from(new Set(rows.map(row => proposalAccountOf(row.onchain_data)).filter(Boolean)));
        const statuses = await readStatuses(connection, accounts);
        const { selected, skipped } = selectExpiryCandidates(rows, { statuses, lifecycleKey: lifecycle.key });
        for (const item of skipped) log(`skip ${item.proposalId}: ${item.reason}`);
        log(`${rows.length} expired row(s) in the database · ${selected.length} to settle · ${skipped.length} skipped`);
        const batch = selected.slice(0, limit);
        if (selected.length > limit) log(`limiting this run to ${limit}; ${selected.length - limit} wait for the next run`);
        if (!values.run) {
            batch.forEach(item => log(`would expire ${item.proposalId} (${item.account}) · expired ${item.expiresAt.toISOString()}`));
            log('dry run: nothing signed (add --run)');
            return;
        }
        const keypairPath = values.keypair || process.env.AGENT_EXPIRY_KEYPAIR || path.join(process.env.HOME || '', '.config/solana/ugt-lifecycle-01.json');
        const submitter = loadKeypair(keypairPath);
        log(`submitter ${submitter.publicKey.toBase58()} (${keypairPath})`);
        let done = 0;
        for (const [index, item] of batch.entries()) {
            const started = Date.now();
            try {
                const verdict = await expireWithVerdict({
                    connection, submitterKeypair: submitter, proposalAccount: item.account,
                    lifecycle: { ...lifecycle, evidenceRef: `expires_at:${item.expiresAt.toISOString()}` },
                    sourceObservedAt: Math.floor(item.expiresAt.getTime() / 1000)
                });
                let market = 'no pool';
                if (await marketClient.readMarket(connection, item.account)) {
                    const resolved = await resolveProposalMarket({ connection, resolverKeypair: submitter, proposalAccount: item.account });
                    market = resolved.replayed ? `pool already ${resolved.outcome}` : `pool settled ${resolved.outcome} (${resolved.signature})`;
                }
                done += 1;
                log(`[${index + 1}/${batch.length}] expired ${item.proposalId} · verdict ${verdict.signature || verdict.address || 'settled'} · ${market} · ${Date.now() - started} ms`);
            } catch (error) {
                log(`[${index + 1}/${batch.length}] FAILED ${item.proposalId}: ${error.message}`);
            }
        }
        log(`done: ${done}/${batch.length} settled`);
        if (done < batch.length) process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] expire-proposals failed:`, error);
        process.exit(1);
    });
}
