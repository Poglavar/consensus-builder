#!/usr/bin/env node
// One-off, resumable recovery of the devnet USDC (and escrowed SOL) our bots left in the RETIRED agreement,
// proposal_pledge and proposal_market programs (generations ESJ1/5RvX/9S7j and Gtdge/1jES/GDYn), the ugt
// program (95sje) and proposal_nft (3WsVS). It reads every account of the eight programs, plans cancel/expire → resolve → claim/reclaim/refund steps that pay
// one of our wallets (lib/clawback-plan.mjs), prints the plan (--dry-run) or executes it (--run): serial,
// paced, each transaction simulated first, confirmed, and logged to a state file. A rerun re-plans from the
// chain, so finished steps drop out by their on-chain effect; one step's failure never stops the rest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import web3 from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
    PROGRAMS, USDC_MINT, buildPlan, decodeAccount, fmtSol, fmtUsdc, iso, loadIdls, selectSteps, stepDone, summarize,
} from './lib/clawback-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = path.resolve(HERE, '../logs/clawback-retired-programs.state.json');
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_KEYS_DIR = path.join(os.homedir(), '.config/solana');
const PACE_MS = 1250;
const FEE_LAMPORTS_PER_SIGNATURE = 5000;
const ATA_RENT_LAMPORTS = 2_039_280;
const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] [clawback] ${message}`);

function usage(code = 0) {
    console.log([
        'Usage: node scripts/clawback-retired-programs.mjs (--dry-run | --run) [options]',
        '',
        'Recovers devnet USDC and escrowed SOL our bot wallets left in the retired agreement, proposal_pledge,',
        'proposal_market, proposal_nft and ugt programs. Only steps that pay one of our wallets are planned; a foreign sponsor\'s agreement',
        'is expired (permissionless) only when that unblocks one of our claims or refunds.',
        '',
        '  --dry-run            Read devnet and print the plan (per program: steps, USDC/SOL now and later, losses).',
        '  --run                Execute the "now" steps: serial, paced, each simulated before it is sent.',
        '  --simulate           With --dry-run: also simulate every "now" step, bundled with its prerequisites',
        '                       into one transaction (simulateTransaction only; nothing is signed or sent).',
        '  --only <list>        Comma-separated filter: a role (agreement, pledge, market), a generation (lens-set,',
        '                       single-lens), a program label (market_GDYn) or a program id prefix (GDYn). The',
        '                       steps a selected step depends on are always included.',
        '  --max <n>            Execute at most n steps (dependencies first), for a small first batch.',
        `  --rpc <url>          RPC endpoint (default SOLANA_RPC_URL, else ${DEFAULT_RPC}).`,
        '  --payer <name>       Key that pays every fee and any missing token account (default id = id.json).',
        `  --keys-dir <dir>     Our keypairs: ugt-*.json and id.json in this folder (default ~/.config/solana).`,
        '  --state <file>       Run log/checkpoint (default backend/logs/clawback-retired-programs.state.json).',
        '  --plan-json <file>   Also write the full plan as JSON (amounts as strings).',
        '  --verbose            List every step.',
        '',
        `RPC calls are serial and at least ${PACE_MS} ms apart. Keypair files are read for their public keys and`,
        'for signing; their contents are never printed.',
    ].join('\n'));
    process.exit(code);
}

/** Every HTTP RPC call goes through here: serial and at least PACE_MS apart. */
function pacedFetch() {
    let last = 0; let chain = Promise.resolve();
    return (input, init) => {
        const turn = chain.then(async () => {
            const wait = last + PACE_MS - Date.now();
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            last = Date.now();
        });
        chain = turn.catch(() => {});
        return turn.then(() => fetch(input, init));
    };
}

function loadKeys(dir) {
    const keys = new Map();
    const files = fs.readdirSync(dir).filter(f => /^ugt-.*\.json$/.test(f) || f === 'id.json');
    for (const file of files) {
        try {
            const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))));
            keys.set(keypair.publicKey.toBase58(), { name: file.replace(/\.json$/, ''), keypair });
        } catch (error) {
            log(`skipping key file ${file}: not a keypair (${error.constructor.name})`);
        }
    }
    return keys;
}

function readState(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { runs: [], steps: {} }; throw error; }
}
function writeState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    fs.renameSync(`${file}.tmp`, file);
}

const tokenAmount = info => (info && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : null);

async function getMany(connection, keys) {
    const out = new Map();
    const list = [...new Set(keys)];
    for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk.map(k => new web3.PublicKey(k)));
        chunk.forEach((key, j) => out.set(key, infos[j]));
    }
    return out;
}

/** Read the eight programs and everything the plan needs from devnet. */
async function snapshot(connection, idls, ours) {
    const accounts = new Map();
    const rent = {};
    for (const [programId, info] of Object.entries(PROGRAMS)) {
        const list = await connection.getProgramAccounts(new web3.PublicKey(programId));
        let lamports = 0n; const types = {};
        for (const { pubkey, account } of list) {
            const decoded = decodeAccount(idls.get(programId), account.data);
            accounts.set(pubkey.toBase58(), { program: programId, lamports: BigInt(account.lamports), ...decoded });
            lamports += BigInt(account.lamports);
            const label = decoded.error ? `${decoded.type ?? 'unknown'} (undecodable)` : decoded.type;
            types[label] = (types[label] ?? 0) + 1;
        }
        rent[info.label] = { accounts: list.length, lamports, types };
        log(`${info.label}: ${list.length} accounts, ${fmtSol(lamports)} SOL held (${Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')})`);
    }
    const vaults = []; const subjects = [];
    for (const account of accounts.values()) {
        if (!account.data) continue;
        if (['Market', 'ExternalMarket', 'LmsrMarket', 'DonationEscrow'].includes(account.type)) vaults.push(account.data.vault);
        if (['Market', 'LmsrMarket', 'DonationEscrow'].includes(account.type) && account.data.proposal !== web3.SystemProgram.programId.toBase58()) subjects.push(account.data.proposal);
    }
    log(`reading ${new Set(vaults).size} vault token accounts`);
    const balances = new Map();
    for (const [key, info] of await getMany(connection, vaults)) { const amount = tokenAmount(info); if (amount != null) balances.set(key, amount); }
    const counted = new Set();
    for (const account of accounts.values()) {
        const vault = account.data?.vault;
        if (!vault || counted.has(vault) || !balances.has(vault)) continue;
        counted.add(vault);
        const r = rent[PROGRAMS[account.program].label];
        r.usdcHeld = (r.usdcHeld ?? 0n) + balances.get(vault);
    }
    const outside = subjects.filter(k => !accounts.has(k));
    const owners = new Map();
    if (outside.length) {
        log(`reading ${new Set(outside).size} referenced agreement accounts outside the scanned programs`);
        for (const [key, info] of await getMany(connection, outside)) owners.set(key, info ? info.owner.toBase58() : null);
    }
    const slot = await connection.getSlot('confirmed');
    const now = await connection.getBlockTime(slot);
    log(`chain time ${iso(now)} (slot ${slot})`);
    return { now, ours, accounts, balances, owners, rent };
}

function tokenAccountsOf(step) {
    const a = step.accounts;
    return [a.claimer_token_account, a.creator_token_account, a.donor_token_account].filter(Boolean);
}

function buildInstruction(idls, step, payer) {
    const idl = idls.get(step.program);
    const def = idl.instructions.find(i => i.name === step.action);
    const keys = def.accounts.map(account => {
        let key = step.accounts[account.name] ?? account.address;
        if (key === 'PAYER') key = payer.toBase58();
        if (!key) throw new Error(`${step.action}: no account for ${account.name}`);
        return { pubkey: new web3.PublicKey(key), isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
    });
    for (const extra of step.remaining ?? []) keys.push({ pubkey: new web3.PublicKey(extra.pubkey), isSigner: false, isWritable: Boolean(extra.isWritable) });
    return new web3.TransactionInstruction({ programId: new web3.PublicKey(step.program), keys, data: Buffer.from(def.discriminator) });
}

/** One transaction for `steps` in order (--run sends one step per transaction; --simulate bundles a chain). */
function buildTransaction(idls, steps, payer, blockhash, missingAtas, mintOf) {
    const instructions = [];
    const created = new Set();
    for (const step of steps) {
        for (const tokenAccount of tokenAccountsOf(step)) {
            if (!missingAtas.has(tokenAccount) || created.has(tokenAccount)) continue;
            created.add(tokenAccount);
            const owner = step.accounts.claimer ?? step.accounts.creator ?? step.accounts.donor;
            instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, new web3.PublicKey(tokenAccount), new web3.PublicKey(owner), new web3.PublicKey(mintOf(step))));
        }
        instructions.push(buildInstruction(idls, step, payer));
    }
    const message = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
    return new web3.VersionedTransaction(message);
}

const stepMint = step => step.returns.find(r => r.mint)?.mint ?? USDC_MINT;
const sum = (steps, field) => steps.reduce((s, step) => s + step.returns.filter(r => !r.mint || r.mint === USDC_MINT).reduce((t, r) => t + r[field], 0n), 0n);
const signatures = step => 1 + (step.signer ? 1 : 0);

function printPlan(plan, summary, snap, ours, { verbose, missingAtas, payer, payerLamports }) {
    const nameOf = key => ours.get(key) ?? key;
    console.log('\n=== Plan by program (USDC and SOL that reach OUR wallets) ===');
    for (const [label, p] of Object.entries(summary.programs).sort()) {
        const fmtSteps = steps => Object.entries(steps).map(([a, n]) => `${n} ${a}`).join(', ') || 'none';
        const held = snap.rent[label]?.usdcHeld;
        console.log(`\n${label}${held != null ? ` (vaults hold ${fmtUsdc(held)} USDC)` : ''}`);
        console.log(`  now:   ${fmtSteps(p.now.steps)} → ${fmtUsdc(p.now.usdc)} USDC, ${fmtSol(p.now.lamports)} SOL`);
        if (Object.keys(p.later.steps).length) console.log(`  later: ${fmtSteps(p.later.steps)} → ${fmtUsdc(p.later.usdc)} USDC, ${fmtSol(p.later.lamports)} SOL (from ${iso(p.later.earliest)} to ${iso(p.later.latest)})`);
        if (p.never.count) {
            console.log(`  not recoverable: ${p.never.count} items, ${fmtUsdc(p.never.usdc)} USDC staked/donated, ${fmtSol(p.never.lamports)} SOL`);
            for (const [reason, n] of Object.entries(p.never.reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${n}× ${reason}`);
        }
        if (held != null) console.log(`  stays in the vaults after now+later: ${fmtUsdc(held - p.now.usdc - p.later.usdc)} USDC (foreign positions and donations, unreadable markets, rounding dust)`);
        if (p.foreign.accounts) console.log(`  not ours (left alone): ${p.foreign.accounts} accounts holding ${fmtUsdc(p.foreign.usdc)} USDC, ${fmtSol(p.foreign.lamports)} SOL escrow`);
    }
    console.log('\n=== Rent (not recoverable: none of the eight programs has a close instruction or close constraint) ===');
    for (const [label, r] of Object.entries(snap.rent)) console.log(`  ${label}: ${r.accounts} accounts, ${fmtSol(r.lamports)} SOL in account balances (rent plus any escrow listed above)`);

    const later = plan.steps.filter(s => s.when === 'later');
    // Closing a program (solana program close) leaves its accounts readable but no instruction can run
    // against them again: whatever a later step or a foreign holder still needs from it is stranded.
    console.log('\n=== If a program were closed after the "now" steps ran ===');
    const byId = new Map(plan.steps.map(s => [s.id, s]));
    const chainPrograms = step => new Set([step.program, ...step.dependsOn.flatMap(id => [...chainPrograms(byId.get(id))])]);
    for (const [programId, info] of Object.entries(PROGRAMS)) {
        const needs = later.filter(s => chainPrograms(s).has(programId));
        const own = summary.programs[info.label];
        const held = snap.rent[info.label]?.usdcHeld;
        const left = held != null && own ? held - own.now.usdc - own.later.usdc : held;
        const parts = [];
        if (needs.length) parts.push(`${needs.length} later steps (${[...new Set(needs.map(s => PROGRAMS[s.program].label))].join(', ')}) → ${fmtUsdc(sum(needs, 'usdc'))} USDC, ${fmtSol(sum(needs, 'lamports'))} SOL, due ${iso(Math.min(...needs.map(s => s.at))).slice(0, 10)}…${iso(Math.max(...needs.map(s => s.at))).slice(0, 10)}`);
        if (own?.foreign.accounts) parts.push(`foreign wallets' ${own.foreign.accounts} accounts: ${fmtUsdc(own.foreign.usdc)} USDC, ${fmtSol(own.foreign.lamports)} SOL escrow`);
        if (left) parts.push(`${fmtUsdc(left)} USDC left in its vaults`);
        console.log(`  ${info.label}: ${parts.length ? `strands ${parts.join('; ')}` : 'nothing recoverable stranded'}; rent in its ${snap.rent[info.label]?.accounts ?? 0} accounts is lost either way`);
    }
    if (later.length) {
        console.log('\n=== Recoverable later ===');
        const byDate = new Map();
        for (const s of later) { const day = iso(s.at).slice(0, 10); const e = byDate.get(day) ?? { n: 0, usdc: 0n, lamports: 0n, actions: {} }; e.n++; e.usdc += sum([s], 'usdc'); e.lamports += sum([s], 'lamports'); e.actions[s.action] = (e.actions[s.action] ?? 0) + 1; byDate.set(day, e); }
        for (const [day, e] of [...byDate].sort()) console.log(`  from ${day}: ${Object.entries(e.actions).map(([a, n]) => `${n} ${a}`).join(', ')} → ${fmtUsdc(e.usdc)} USDC, ${fmtSol(e.lamports)} SOL`);
    }
    console.log('\n=== Per wallet ===');
    for (const [wallet, w] of Object.entries(summary.wallets).sort()) console.log(`  ${wallet.padEnd(24)} now ${fmtUsdc(w.now.usdc).padStart(8)} USDC ${fmtSol(w.now.lamports)} SOL   later ${fmtUsdc(w.later.usdc).padStart(8)} USDC ${fmtSol(w.later.lamports)} SOL`);

    const now = plan.steps.filter(s => s.when === 'now');
    const fee = now.reduce((s, step) => s + signatures(step) * FEE_LAMPORTS_PER_SIGNATURE, 0);
    const atas = new Set(now.flatMap(tokenAccountsOf).filter(k => missingAtas.has(k)));
    const foreignExpires = now.filter(s => s.note?.startsWith('permissionless expire'));
    console.log('\n=== Totals ===');
    console.log(`  now:   ${now.length} transactions → ${fmtUsdc(sum(now, 'usdc'))} USDC, ${fmtSol(sum(now, 'lamports'))} SOL`);
    console.log(`  later: ${later.length} transactions → ${fmtUsdc(sum(later, 'usdc'))} USDC, ${fmtSol(sum(later, 'lamports'))} SOL`);
    console.log(`  fees for "now": ≈${fmtSol(fee)} SOL (${FEE_LAMPORTS_PER_SIGNATURE} lamports per signature)${atas.size ? ` + ${atas.size} missing token accounts ≈${fmtSol(BigInt(atas.size * ATA_RENT_LAMPORTS))} SOL rent` : ''}, paid by ${nameOf(payer)} (balance ${fmtSol(BigInt(payerLamports))} SOL)`);
    if (foreignExpires.length) console.log(`  includes ${foreignExpires.length} permissionless expire(s) of foreign sponsors' agreements past their deadline (escrow goes to that sponsor), only where they unblock our claims`);
    if (verbose) {
        console.log('\n=== Steps ===');
        for (const s of plan.steps) {
            const ret = s.returns.map(r => `${nameOf(r.wallet)} +${fmtUsdc(r.usdc)} USDC +${fmtSol(r.lamports)} SOL`).join('; ') || '—';
            console.log(`  [${s.when}${s.at ? ` ${iso(s.at)}` : ''}] ${PROGRAMS[s.program].label} ${s.action} ${s.target} signer=${s.signer ? nameOf(s.signer) : 'payer'} ${ret}${s.dependsOn.length ? ` after ${s.dependsOn.join(',')}` : ''}${s.reason ? ` (${s.reason})` : ''}${s.note ? ` [${s.note}]` : ''}`);
        }
        for (const u of plan.unrecoverable) console.log(`  [never] ${PROGRAMS[u.program].label} ${u.action} ${u.account} ${nameOf(u.wallet)} ${fmtUsdc(u.usdc)} USDC: ${u.reason}`);
    }
}

async function simulate(connection, tx) {
    const result = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    return result.value;
}

async function confirm(connection, signature, lastValidBlockHeight) {
    for (let poll = 1; poll <= 90; poll++) {
        const { value: [status] } = await connection.getSignatureStatuses([signature]);
        if (status?.err) return { ok: false, error: JSON.stringify(status.err) };
        if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return { ok: true };
        if (poll % 6 === 0 && (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
            const { value: [late] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
            if (late && !late.err) return { ok: true };
            return { ok: false, error: 'blockhash expired before confirmation' };
        }
    }
    return { ok: false, error: 'not confirmed after 90 polls (check the signature before rerunning)' };
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    const { values } = parseArgs({ args: argv, options: {
        'dry-run': { type: 'boolean' }, run: { type: 'boolean' }, simulate: { type: 'boolean' }, only: { type: 'string' }, max: { type: 'string' },
        rpc: { type: 'string' }, payer: { type: 'string', default: 'id' }, 'keys-dir': { type: 'string', default: DEFAULT_KEYS_DIR },
        state: { type: 'string', default: DEFAULT_STATE }, 'plan-json': { type: 'string' }, verbose: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) usage(0);
    if (Boolean(values['dry-run']) === Boolean(values.run)) usage(2);
    const live = Boolean(values.run);
    const max = values.max ? Number(values.max) : Infinity;
    if (!(max > 0)) throw new Error('--max must be a positive number');
    const only = values.only ? values.only.split(',').map(s => s.trim()).filter(Boolean) : null;
    const rpcUrl = values.rpc || process.env.SOLANA_RPC_URL || DEFAULT_RPC;

    const idls = loadIdls();
    const keys = loadKeys(values['keys-dir']);
    const ours = new Map([...keys].map(([pubkey, k]) => [pubkey, k.name]));
    const payerEntry = [...keys.values()].find(k => k.name === values.payer);
    if (!payerEntry) throw new Error(`--payer ${values.payer}: no such key in ${values['keys-dir']}`);
    const payer = payerEntry.keypair.publicKey;
    log(`${live ? 'RUN' : 'DRY RUN'} · RPC ${new URL(rpcUrl).host} · ${keys.size} of our keys (${[...ours.values()].sort().join(', ')}) · payer ${values.payer}`);

    const connection = new web3.Connection(rpcUrl, { commitment: 'confirmed', fetch: pacedFetch() });
    const snap = await snapshot(connection, idls, ours);
    const plan = buildPlan(snap);
    const summary = summarize(plan, ours);

    const tokenAccounts = [...new Set(plan.steps.flatMap(tokenAccountsOf))];
    const infos = await getMany(connection, [...tokenAccounts, payer.toBase58()]);
    const missingAtas = new Set(tokenAccounts.filter(k => !infos.get(k)));
    const payerLamports = infos.get(payer.toBase58())?.lamports ?? 0;
    printPlan(plan, summary, snap, ours, { verbose: values.verbose, missingAtas, payer: payer.toBase58(), payerLamports });
    if (values['plan-json']) {
        fs.writeFileSync(values['plan-json'], JSON.stringify({ now: snap.now, plan, summary }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
        log(`plan written to ${values['plan-json']}`);
    }

    const selected = selectSteps(plan.steps, { only, max });
    if (!live) {
        if (values.simulate) {
            // Each step is simulated together with the steps it depends on, as one read-only transaction.
            const ready = selectSteps(plan.steps, { only });
            log(`simulating ${ready.length} steps, each bundled with its prerequisites (read-only, ~${Math.ceil(ready.length * PACE_MS / 1000)} s)`);
            const { blockhash } = await connection.getLatestBlockhash();
            const failures = {};
            let passed = 0;
            for (const step of ready) {
                const chain = selectSteps(plan.steps, { ids: [step.id] });
                let result;
                try { result = await simulate(connection, buildTransaction(idls, chain, payer, blockhash, missingAtas, stepMint)); } catch (error) {
                    (failures[`${step.action}: not simulated (${error.message.slice(0, 80)})`] ??= []).push(step.target);
                    continue;
                }
                if (result.err) {
                    const why = (result.logs ?? []).filter(l => /Error|failed/.test(l)).slice(-1)[0] ?? JSON.stringify(result.err);
                    const key = `${step.action}: ${why.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, '…')}`;
                    (failures[key] ??= []).push(step.target);
                } else passed++;
            }
            console.log(`\n=== Simulation: ${passed}/${ready.length} pass ===`);
            for (const [why, targets] of Object.entries(failures)) console.log(`  ${targets.length}× ${why} (e.g. ${targets[0]})`);
        }
        console.log(`\nDry run only. --run${only ? ` --only ${only.join(',')}` : ''}${Number.isFinite(max) ? ` --max ${max}` : ''} would execute ${selected.length} steps → ${fmtUsdc(sum(selected, 'usdc'))} USDC, ${fmtSol(sum(selected, 'lamports'))} SOL.`);
        return;
    }

    // --run
    const state = readState(values.state);
    const run = { startedAt: ts(), args: argv, rpcHost: new URL(rpcUrl).host, planned: selected.length };
    state.runs.push(run);
    writeState(values.state, state);
    const ourUsdcAtas = [...new Set(selected.flatMap(s => [...tokenAccountsOf(s), s.accounts.beneficiary_token_account].filter(Boolean)))];
    const before = await getMany(connection, ourUsdcAtas);
    const outcome = new Map();
    let usdc = 0n; let lamports = 0n; let done = 0;
    const started = Date.now();
    for (const [index, step] of selected.entries()) {
        const record = result => {
            outcome.set(step.id, result.status);
            state.steps[step.id] = { ...state.steps[step.id], action: step.action, program: PROGRAMS[step.program].label, target: step.target, at: ts(), ...result };
            writeState(values.state, state);
        };
        const blockedBy = step.dependsOn.find(id => outcome.get(id) && !['done', 'already-done'].includes(outcome.get(id)));
        if (blockedBy) { record({ status: 'blocked', error: `prerequisite ${blockedBy} ${outcome.get(blockedBy)}` }); log(`skip ${step.action} ${step.target}: prerequisite ${blockedBy} did not succeed`); continue; }
        try {
            const fresh = await getMany(connection, [step.target, ...(step.action === 'reclaim_seed' ? [step.accounts.vault] : [])]);
            const target = fresh.get(step.target);
            const decoded = target ? decodeAccount(idls.get(step.program), target.data) : null;
            if (stepDone(step, decoded, tokenAmount(fresh.get(step.accounts.vault)))) {
                record({ status: 'already-done' }); log(`${step.action} ${step.target}: already done on chain, skipped`);
            } else {
                const signers = [payerEntry.keypair, ...(step.signer && step.signer !== payer.toBase58() ? [keys.get(step.signer).keypair] : [])];
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
                const tx = buildTransaction(idls, [step], payer, blockhash, missingAtas, stepMint);
                tx.sign(signers);
                const sim = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
                if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
                const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
                const confirmation = await confirm(connection, signature, lastValidBlockHeight);
                if (!confirmation.ok) throw Object.assign(new Error(confirmation.error), { signature });
                for (const k of tokenAccountsOf(step)) missingAtas.delete(k);
                usdc += sum([step], 'usdc'); lamports += sum([step], 'lamports'); done++;
                record({ status: 'done', signature, usdc: sum([step], 'usdc'), lamports: sum([step], 'lamports') });
            }
        } catch (error) {
            record({ status: 'failed', error: error.message, signature: error.signature });
            log(`FAILED ${step.action} ${step.target}: ${error.message}`);
        }
        const elapsed = (Date.now() - started) / 1000;
        const eta = Math.round(elapsed / (index + 1) * (selected.length - index - 1));
        log(`${index + 1}/${selected.length} · ${fmtUsdc(usdc)} USDC · ${fmtSol(lamports)} SOL recovered · ETA ${new Date(eta * 1000).toISOString().slice(11, 19)}`);
    }

    const after = await getMany(connection, ourUsdcAtas);
    let observed = 0n;
    for (const key of ourUsdcAtas) observed += (tokenAmount(after.get(key)) ?? 0n) - (tokenAmount(before.get(key)) ?? 0n);
    const counts = {};
    for (const status of outcome.values()) counts[status] = (counts[status] ?? 0) + 1;
    run.finishedAt = ts();
    run.verdict = { ...counts, usdcPlanned: fmtUsdc(usdc), usdcObserved: fmtUsdc(observed), solPlanned: fmtSol(lamports) };
    writeState(values.state, state);
    const failed = (counts.failed ?? 0) + (counts.blocked ?? 0);
    log(`${failed ? 'PARTIAL' : 'OK'}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to do'} · ${fmtUsdc(usdc)} USDC by plan, ${fmtUsdc(observed)} USDC observed in our token accounts · ${fmtSol(lamports)} SOL escrow returned · state ${values.state}`);
    if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(`[${ts()}] [clawback] fatal: ${error.stack || error.message}`); process.exit(1); });
