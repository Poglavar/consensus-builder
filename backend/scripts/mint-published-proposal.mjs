#!/usr/bin/env node
// Mints an already-published proposal on Solana devnet so a yes/no pool can be opened on it. The
// browser mints only at publish time, so an imported plan (scripts/import-candlestick-courtyard.mjs)
// needs this path: a site-only mint (no parcel consent list, the lens decides) under the given
// lens members, then the proposal account is recorded on the local row with --record. Dry run by
// default; --run signs. Idempotent: a row that already carries a Solana account is left alone.
//
//   node scripts/mint-published-proposal.mjs --proposal-id <id> --keypair <owner.json> --lens <key,key> [--run] [--record]
//   node scripts/mint-published-proposal.mjs --proposal-id <id> --record-existing <account> --tx <signature>
//
// Confirmation polls getSignatureStatuses (agents/solana-send.js): RPC providers without
// signatureSubscribe otherwise report a mint that has long since landed as failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import { mintProposal } from '../agents/minter.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';
import { proposalAccountOf } from '../markets/contests.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/mint-published-proposal.mjs --proposal-id <id> --keypair <owner.json> --lens <key[,key…]> [options]',
        '',
        '  --proposal-id <id>   The published proposal (its proposal_id).',
        '  --keypair <file>     Owner keypair JSON; pays the account rent (devnet SOL).',
        '  --lens <keys>        Comma-separated lens member public keys (at least one; include the lifecycle member so expiry can settle it).',
        '  --rpc <url>          RPC (default $SOLANA_RPC_URL or devnet).',
        '  --run                Sign the mint. Without it: show what would be minted.',
        '  --record             After a successful mint, store the account on the local proposal row (onchain_data).',
        '  --record-existing <account> --tx <sig>   Record a mint that already happened (no signing) on the local row.',
        '  --help               This text.'
    ].join('\n'));
    process.exit(code);
}

async function main() {
    const { values } = parseArgs({
        options: { 'proposal-id': { type: 'string' }, keypair: { type: 'string' }, lens: { type: 'string' }, rpc: { type: 'string' }, run: { type: 'boolean', default: false }, record: { type: 'boolean', default: false }, 'record-existing': { type: 'string' }, tx: { type: 'string' }, help: { type: 'boolean', default: false } },
        strict: true
    });
    if (values.help) usage(0);
    const recordExisting = values['record-existing'] || null;
    if (!values['proposal-id'] || (!recordExisting && (!values.keypair || !values.lens))) usage(1);
    const lens = recordExisting ? [] : values.lens.split(',').map(key => key.trim()).filter(Boolean);
    if (!recordExisting && !lens.length) throw new Error('--lens needs at least one key');
    const owner = recordExisting ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(values.keypair, 'utf8'))));
    const connection = new Connection(values.rpc || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const pool = new pg.Pool();
    try {
        const { rows } = await pool.query(`
            SELECT id, proposal_id, city, COALESCE(title, name) AS title, onchain_data, binding,
                   ST_AsGeoJSON(site, 9)::json AS site
            FROM proposal WHERE proposal_id = $1`, [values['proposal-id']]);
        if (!rows.length) throw new Error(`no proposal ${values['proposal-id']}`);
        const row = rows[0];
        const existing = proposalAccountOf(row.onchain_data);
        if (existing) { log(`${row.proposal_id} (row ${row.id}) is already minted as ${existing}; nothing to do`); return; }
        log(`${row.proposal_id} (row ${row.id}, ${row.city}): "${row.title}"`);
        if (recordExisting) {
            const info = await connection.getAccountInfo(new (await import('@solana/web3.js')).PublicKey(recordExisting), 'confirmed');
            if (!info || info.owner.toBase58() !== PROPOSAL_PROGRAM_ID) throw new Error(`${recordExisting} is not a proposal account of ${PROPOSAL_PROGRAM_ID}`);
            const onchain = { chainId: 'solana-devnet', proposalId: recordExisting, contractAddress: PROPOSAL_PROGRAM_ID, transactionHash: values.tx || null };
            await pool.query('UPDATE proposal SET onchain_data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(onchain), row.id]);
            log(`recorded existing mint on row ${row.id}: ${JSON.stringify(onchain)}`);
            return;
        }
        if (!row.site) throw new Error('the proposal has no site; a site-only mint needs one');
        log(`site ${row.site.type}, binding ${row.binding ? `${(row.binding.parcels || []).length} parcels, coverage ${row.binding.coverage}` : 'none'}`);
        log(`owner ${owner.publicKey.toBase58()} · lens ${lens.join(', ')} · program ${PROPOSAL_PROGRAM_ID}`);
        const lamports = await connection.getBalance(owner.publicKey);
        log(`owner balance ${(lamports / 1e9).toFixed(3)} SOL`);
        if (!values.run) { log('dry run: nothing signed (add --run)'); return; }
        const minted = await mintProposal({
            connection, programId: PROPOSAL_PROGRAM_ID, ownerKeypair: owner,
            parcelIds: [], isConditional: true, imageUri: '', lamports: 0n, lens,
            site: row.site, binding: row.binding || null, verdictMayExecute: true,
            sendAndConfirm: sendAndConfirmPolling
        });
        log(`minted proposal account ${minted.proposalPda} · tx ${minted.signature} · https://explorer.solana.com/address/${minted.proposalPda}?cluster=devnet`);
        if (!values.record) { log('not recorded (add --record to store the account on the local row)'); return; }
        const onchain = { chainId: 'solana-devnet', proposalId: minted.proposalPda, contractAddress: PROPOSAL_PROGRAM_ID, transactionHash: minted.signature };
        await pool.query('UPDATE proposal SET onchain_data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(onchain), row.id]);
        log(`recorded on row ${row.id}: onchain_data = ${JSON.stringify(onchain)}`);
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] mint failed:`, error);
    process.exit(1);
});
