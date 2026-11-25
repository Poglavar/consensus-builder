#!/usr/bin/env node
// One-off: pins on IPFS the content of agreements minted before minting required it (docs/ipfs-storage.md).
// A minted account commits to the agreement's CID, and through the CIDs inside each record to its plan and
// designs; pinning exactly those bytes now makes the existing chain reference resolvable. Dry run unless
// --apply. Idempotent and resumable: consensus.ipfs_pin records each CID the provider confirmed, and a
// rerun skips them. One object's failure is reported and the rest carry on.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { createPool } from '../db/connection.cjs';
import { createPinStore, mintedTree, pinAgreementTrees } from '../agreements/pin-content.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = message => console.log(`[${new Date().toISOString()}] [pin-minted] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/pin-minted-agreements.mjs (--dry-run | --apply) [--cluster devnet]',
        '',
        '  --dry-run         List what minted agreements reference and what is not pinned yet; pins nothing.',
        '  --apply           Pin what is missing (IPFS_PINNING_PROVIDER and its credentials) and record it in consensus.ipfs_pin.',
        '  --cluster <name>  The cluster the index records the mints on (default devnet).',
        '',
        'Env (backend/.env): DATABASE_URL, IPFS_PINNING_PROVIDER and its credentials.'
    ].join('\n'));
    process.exit(code);
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, cluster: { type: 'string', default: 'devnet' }, help: { type: 'boolean' } } });
    if (values.help || values['dry-run'] === values.apply) usage(values.help ? 0 : 2);
    dotenv.config({ path: path.join(HERE, '..', '.env'), quiet: true });
    const pool = createPool();
    try {
        const { rows } = await pool.query(`
            SELECT cid, content FROM consensus.agreement
            WHERE onchain->>'chain' = 'solana' AND onchain->>'cluster' = $1
            ORDER BY created_at, cid`, [values.cluster]);
        const store = createPinStore(pool);
        log(`${rows.length} minted agreement(s) on ${values.cluster}${values.apply ? '' : ' (dry run: nothing is pinned)'}`);
        if (!values.apply) {
            const { objects, missing } = await mintedTree(store, rows);
            const pinned = await store.pinnedCids(objects.map(object => object.cid));
            const todo = objects.filter(object => !pinned.has(object.cid));
            const counts = kind => todo.filter(object => object.kind === kind).length;
            log(`they reference ${objects.length} object(s): ${pinned.size} already pinned, ${todo.length} to pin (${counts('agreement')} agreement(s), ${counts('plan')} plan(s), ${counts('design')} design(s)), ${missing.length} not in the index`);
            for (const item of missing) log(`not in the index: ${item.kind} ${item.cid ?? `(none named by ${item.referencedBy})`}`);
            return;
        }
        const result = await pinAgreementTrees({ store, agreements: rows, log });
        log(`done: ${result.referenced} object(s) referenced · already pinned ${result.alreadyPinned} · pinned ${result.pinned.length} · failed ${result.failed.length} · not in the index ${result.missing.length}`);
        if (result.failed.length || result.missing.length) process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(`[${new Date().toISOString()}] [pin-minted] failed: ${error.stack || error.message}`);
    process.exit(1);
});
