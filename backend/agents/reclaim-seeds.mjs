// One-off recovery of devnet test USDC the bots left behind (2026-11-12): (1) every resolved market a
// proposer opened gives its creator back what the payouts leave of the LMSR seed (reclaim_seed; the
// settlement phase does this itself from now on), then (2) every persona wallet's USDC above the 0.5
// USDC top-up target goes back to the funding wallet (densifier-01), so the bots draw from one pool.
// Idempotent: a reclaimed market has nothing left, a swept wallet sits at the target.
//
//   node agents/reclaim-seeds.mjs --dry-run     # list what would move, sign nothing
//   node agents/reclaim-seeds.mjs --apply       # reclaim, then sweep, one transaction at a time
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createPool } from '../db/connection.cjs';
import { createRpcConnection } from '../solana/rpc.js';
import { listRuns } from './ledger.js';
import { readAgreementMarket } from './bettor.js';
import { reclaimableSeed, reclaimAgreementMarketSeed } from './lifecycle-actions.js';
import { BOT_USDC_MINT } from './funding.js';
import { sendAndConfirmPolling } from './solana-send.js';

const SOURCE_PERSONA = 'densifier-01';   // funding.js SOURCE_PERSONA
const KEEP_ATOMIC = 500_000n;            // funding.js TARGET_BOT_USDC: what a top-up fills a persona to
const usdc = atomic => (Number(atomic) / 1e6).toFixed(6);
const log = (...parts) => console.log(`[${new Date().toISOString()}] [reclaim-seeds]`, ...parts);

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--dry-run') ? 'dry-run' : null;
if (!mode || process.argv.includes('--help')) {
    console.log('usage: node agents/reclaim-seeds.mjs --dry-run | --apply\n'
        + '  reclaims the seed of every resolved market a proposer opened, then sweeps persona USDC above 0.5 to densifier-01');
    process.exit(mode ? 0 : 1);
}

const personas = JSON.parse(fs.readFileSync(new URL('./personas.json', import.meta.url), 'utf8')).personas;
const byName = new Map(personas.map(p => [p.name, p]));
const loadKeypair = keypairPath => {
    const resolved = keypairPath.startsWith('~') ? path.join(os.homedir(), keypairPath.slice(1)) : keypairPath;
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(resolved, 'utf8'))));
};

async function usdcBalance(connection, owner) {
    const ata = getAssociatedTokenAddressSync(BOT_USDC_MINT, new PublicKey(owner));
    const info = await connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
}

async function reclaimMarkets(connection, pool) {
    // Every agreement a persona minted, settled or not: summary.mints[candidate].account per run.
    const minted = new Map();
    for (const run of await listRuns(pool)) {
        for (const mint of Object.values(run.summary?.mints || {})) {
            if (mint?.account && !minted.has(mint.account)) minted.set(mint.account, run.persona);
        }
    }
    log(`${minted.size} minted agreement(s) in consensus.agent_run`);
    let total = 0n, taken = 0n, done = 0, open = 0, empty = 0, failed = 0;
    for (const [account, personaName] of minted) {
        try {
            const context = await readAgreementMarket(connection, account);
            const market = context.market;
            if (!market) { empty += 1; continue; }
            if (!market.resolved) { open += 1; continue; }
            const vault = await connection.getTokenAccountBalance(new PublicKey(market.vault), 'confirmed');
            const amount = reclaimableSeed(market, BigInt(vault.value.amount));
            if (amount <= 0n) { empty += 1; continue; }
            const creator = personas.find(p => p.wallet === market.creator);
            if (!creator?.keypairPath) { log(`skip ${account}: creator ${market.creator} is no configured persona`); continue; }
            total += amount;
            if (mode === 'dry-run') { log(`would reclaim ${usdc(amount)} USDC · ${creator.name} · ${account}`); continue; }
            const result = await reclaimAgreementMarketSeed({ connection, creatorKeypair: loadKeypair(creator.keypairPath), subject: account, sendAndConfirm: sendAndConfirmPolling });
            taken += BigInt(result.amount);
            done += 1;
            log(`reclaimed ${usdc(result.amount)} USDC · ${creator.name} · ${account} · ${result.signature ?? 'nothing left'}`);
        } catch (err) {
            failed += 1;
            log(`FAIL ${account} (${personaName}): ${err.message}`);
        }
    }
    log(`markets: ${mode === 'apply' ? `${done} reclaimed, ${usdc(taken)} USDC` : `${usdc(total)} USDC reclaimable`} · ${open} still open · ${empty} with nothing left or no market · ${failed} failed`);
    return failed;
}

async function sweepPersonas(connection) {
    const source = byName.get(SOURCE_PERSONA);
    const sourceAta = getAssociatedTokenAddressSync(BOT_USDC_MINT, new PublicKey(source.wallet));
    let total = 0n, failed = 0;
    for (const persona of personas) {
        if (persona.name === SOURCE_PERSONA || !persona.wallet || !persona.keypairPath) continue;
        try {
            const balance = await usdcBalance(connection, persona.wallet);
            const excess = balance - KEEP_ATOMIC;
            if (excess <= 0n) continue;
            total += excess;
            if (mode === 'dry-run') { log(`would sweep ${usdc(excess)} USDC · ${persona.name} (holds ${usdc(balance)})`); continue; }
            const signer = loadKeypair(persona.keypairPath);
            const tx = new Transaction()
                .add(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, sourceAta, new PublicKey(source.wallet), BOT_USDC_MINT))
                .add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(BOT_USDC_MINT, signer.publicKey), BOT_USDC_MINT, sourceAta, signer.publicKey, excess, 6));
            tx.feePayer = signer.publicKey;
            const signature = await sendAndConfirmPolling(connection, tx, [signer], { commitment: 'confirmed' });
            log(`swept ${usdc(excess)} USDC · ${persona.name} → ${SOURCE_PERSONA} · ${signature}`);
        } catch (err) {
            failed += 1;
            log(`FAIL sweep ${persona.name}: ${err.message}`);
        }
    }
    log(`personas: ${usdc(total)} USDC ${mode === 'apply' ? 'swept' : 'sweepable'} to ${SOURCE_PERSONA} · ${failed} failed`);
    return failed;
}

const connection = createRpcConnection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const pool = createPool();
try {
    const source = byName.get(SOURCE_PERSONA).wallet;
    log(`START ${mode} · ${SOURCE_PERSONA} ${source} holds ${usdc(await usdcBalance(connection, source))} USDC`);
    const failed = (await reclaimMarkets(connection, pool)) + (await sweepPersonas(connection));
    log(`${failed ? 'PARTIAL' : 'OK'} · ${SOURCE_PERSONA} now holds ${usdc(await usdcBalance(connection, source))} USDC`);
    process.exitCode = failed ? 1 : 0;
} finally {
    await pool.end();
}
