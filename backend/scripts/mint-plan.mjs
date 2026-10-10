#!/usr/bin/env node
// Mints a named plan (plans.md) on Solana devnet as one site-only proposal account, so one yes/no pool
// can be opened on the whole plan. The account's site hash is the plan's site (the union of its
// members' sites) and its image_uri is `ugt-plan:<slug>@<plan_hash>`, so the account commits to the
// exact members the plan was named with. Dry run by default; --run signs; --record stores the account
// on the plan row (set once). Idempotent: a plan that already has an account is left alone.
//
//   node scripts/mint-plan.mjs --slug <plan> --keypair <owner.json> --lens <key,key> [--run] [--record]
//   node scripts/mint-plan.mjs --slug <plan> --record-existing <account>
//
// --record-existing records an account minted from ANOTHER database's copy of the same plan (the plan
// hash is over stable proposal ids, so it is equal everywhere): it reads the account's image_uri on
// chain and refuses unless it is exactly this plan's `ugt-plan:<slug>@<plan_hash>`.
// The database is the one backend/.env selects (PG* / DATABASE_URL), like mint-published-proposal.mjs.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import pg from 'pg';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeProposalState } from '../agents/lifecycle-actions.js';
import { mintProposal } from '../agents/minter.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';
import { PROPOSAL_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';
import { proposalAccountOf } from '../markets/contests.js';
import { createPlanStore } from '../plans/plan-store.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

export const planUri = (slug, planHash) => `ugt-plan:${slug}@${planHash}`;

function usage(code = 0) {
    console.log([
        'Usage: node scripts/mint-plan.mjs --slug <plan> --keypair <owner.json> --lens <key[,key…]> [options]',
        '',
        '  --slug <plan>        The named plan (ens_plan slug).',
        '  --keypair <file>     Owner keypair JSON; pays the account rent (devnet SOL).',
        '  --lens <keys>        Comma-separated lens member public keys (include the lifecycle member so expiry can settle it).',
        '  --rpc <url>          RPC (default $SOLANA_RPC_URL or devnet).',
        '  --run                Sign the mint. Without it: show what would be minted.',
        '  --record             After a successful mint, store the account on the plan row.',
        '  --record-existing <account>  Record an account already minted for this plan (verified on chain).',
        '  --help               This text.'
    ].join('\n'));
    process.exit(code);
}

async function main() {
    const { values } = parseArgs({
        options: { slug: { type: 'string' }, keypair: { type: 'string' }, lens: { type: 'string' }, rpc: { type: 'string' },
            'record-existing': { type: 'string' },
            run: { type: 'boolean', default: false }, record: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
        strict: true
    });
    const recordExisting = values['record-existing'] || null;
    if (values.help || !values.slug || (!recordExisting && (!values.keypair || !values.lens))) usage(values.help ? 0 : 1);
    const lens = recordExisting ? [] : values.lens.split(',').map(key => key.trim()).filter(Boolean);
    if (!recordExisting && !lens.length) throw new Error('--lens needs at least one key');
    const owner = recordExisting ? null : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(values.keypair, 'utf8'))));
    const connection = new Connection(values.rpc || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
    try {
        const store = createPlanStore(pool);
        const plan = await store.mintInput(values.slug);
        if (!plan) throw new Error(`no plan ${values.slug}`);
        const existing = proposalAccountOf(plan.onchain_data);
        if (existing) { log(`${plan.slug} is already minted as ${existing}; nothing to do`); return; }
        if (!plan.plan_hash) throw new Error(`${plan.slug} was named before plans carried a content hash; name a new version to bet on it`);
        if (!plan.site) throw new Error(`${plan.slug} has no site (a member had none when it was named)`);
        const uri = planUri(plan.slug, plan.plan_hash);
        log(`${plan.slug} (${plan.city}): "${plan.title}" · ${uri}`);
        if (recordExisting) {
            const info = await connection.getAccountInfo(new PublicKey(recordExisting), 'confirmed');
            if (!info || info.owner.toBase58() !== PROPOSAL_PROGRAM_ID) throw new Error(`${recordExisting} is not a proposal account of ${PROPOSAL_PROGRAM_ID}`);
            const onChainUri = decodeProposalState(info.data).imageUri;
            if (onChainUri !== uri) throw new Error(`${recordExisting} commits to "${onChainUri}", not this plan's "${uri}"`);
            const onchain = { chainId: 'solana-devnet', proposalId: recordExisting, contractAddress: PROPOSAL_PROGRAM_ID, imageUri: uri };
            await store.recordMint(plan.slug, onchain);
            log(`verified and recorded on plan ${plan.slug}: ${JSON.stringify(onchain)}`);
            return;
        }
        log(`owner ${owner.publicKey.toBase58()} · lens ${lens.join(', ')} · program ${PROPOSAL_PROGRAM_ID}`);
        log(`owner balance ${((await connection.getBalance(owner.publicKey)) / 1e9).toFixed(3)} SOL`);
        if (!values.run) { log('dry run: nothing signed (add --run)'); return; }
        const minted = await mintProposal({
            connection, programId: PROPOSAL_PROGRAM_ID, ownerKeypair: owner,
            parcelIds: [], isConditional: true, imageUri: uri, lamports: 0n, lens,
            site: plan.site, binding: null, verdictMayExecute: true,
            sendAndConfirm: sendAndConfirmPolling
        });
        log(`minted plan account ${minted.proposalPda} · tx ${minted.signature} · https://explorer.solana.com/address/${minted.proposalPda}?cluster=devnet`);
        if (!values.record) { log('not recorded (add --record to store the account on the plan row)'); return; }
        const onchain = { chainId: 'solana-devnet', proposalId: minted.proposalPda, contractAddress: PROPOSAL_PROGRAM_ID,
            transactionHash: minted.signature, imageUri: uri };
        await store.recordMint(plan.slug, onchain);
        log(`recorded on plan ${plan.slug}: ${JSON.stringify(onchain)}`);
    } finally {
        await pool.end();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[${new Date().toISOString()}] mint failed:`, error);
        process.exit(1);
    });
}
