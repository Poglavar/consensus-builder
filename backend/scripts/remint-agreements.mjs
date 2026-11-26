#!/usr/bin/env node
// Re-mints indexed agreements on the current agreement program (a redeploy at a new address, such as the
// plan-CID one, leaves rows minted on the previous program reading as unminted) with each sponsor's own
// agent key, and optionally
// reopens a yes/no market on each. Dry run by default: it reads the index (GET only) and devnet and prints
// the plan. --run signs: per agreement it pins the content (POST /agreements/:cid/pin), mints, records the
// account (POST /agreements/:cid/onchain) through the agent tools' mintAgreement, then opens the market.
// Idempotent and resumable: every step reads the chain or the index first, so a rerun signs nothing twice;
// a state file records what each run did. One agreement's failure is reported and the rest carry on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OLD_AGREEMENT_PROGRAM_ID } from '../agents/agreement-minter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const ts = () => new Date().toISOString();
const log = message => console.log(`[${ts()}] [remint] ${message}`);

export { OLD_AGREEMENT_PROGRAM_ID };
const DEFAULT_API = 'https://api.urbangametheory.xyz';
const DEFAULT_ORIGIN = 'https://urbangametheory.xyz';
const DEFAULT_STATE = path.join(REPO, 'tmp/remint-agreements/state.json');
// The previous program's agreement account (OLD_AGREEMENT_PROGRAM_ID; every layout so far shares this
// header): discriminator 8 | authority, lens, payout 32 each | deadline, created_at i64 |
// required_lamports, escrow_lamports u64 | status u8.
const OLD_REQUIRED_LAMPORTS_OFFSET = 8 + 96 + 16;
const OLD_STATUS_OFFSET = 8 + 96 + 32;

function usage(code = 0) {
    console.log([
        'Usage: node scripts/remint-agreements.mjs --cids <cid,cid,...> (--dry-run | --run) [options]',
        '',
        '  --cids <list>                 Agreement CIDs to re-mint (comma-separated).',
        '  --dry-run                     Read the index and devnet, print the plan; signs and writes nothing.',
        '  --run                         Pin, mint, record (and open markets): signs devnet transactions and',
        '                                writes the index through the API.',
        '  --markets                     Also open one yes/no market per agreement (opener pays the seed).',
        '  --market-liquidity-usdc <n>   LMSR liquidity b in devnet USDC (default 2; seed = b·ln2 ≈ 0.69·b).',
        '  --market-opener <persona>     Persona whose wallet opens the markets (default densifier-01; a',
        '                                sponsor cannot trade its own market, opening is open to anyone).',
        '  --lamports <n>                Execution escrow when the old account cannot be read (default 0); an',
        '                                old-program account\'s required_lamports wins.',
        `  --api-base <url>              Index API (default ${DEFAULT_API}).`,
        `  --app-origin <url>            Origin header for index writes (default ${DEFAULT_ORIGIN}).`,
        `  --state <file>                Run log/checkpoint (default tmp/remint-agreements/state.json).`,
        '',
        'Keys: each sponsor\'s keypair comes from backend/agents/personas.json (wallet → keypairPath).',
        'Env: SOLANA_RPC_URL (optional; public devnet otherwise).'
    ].join('\n'));
    process.exit(code);
}

const expandHome = file => (file?.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

/** wallet → { persona, keypairPath, present } from personas.json (the file is only read, never written). */
export function personaKeys(personasJson, exists = fs.existsSync) {
    const list = Array.isArray(personasJson) ? personasJson : Object.values(personasJson?.personas ?? personasJson ?? {});
    const keys = new Map();
    for (const persona of list) {
        if (!persona?.wallet || !persona.keypairPath) continue;
        const keypairPath = expandHome(persona.keypairPath);
        keys.set(persona.wallet, { persona: persona.name, keypairPath, present: exists(keypairPath) });
    }
    return keys;
}

/**
 * What one agreement needs, from what the index and the chain hold now (pure).
 * @param row        GET /agreements/:cid body, or null
 * @param chain      { current: decoded new-program account | null, old: { requiredLamports, status } | null }
 * @param key        personaKeys entry for the sponsor, or undefined
 * @param market     { wanted: boolean, exists: boolean }
 * @returns {{ action: 'skip'|'blocked'|'needs-sponsor'|'remint', reason?, steps: string[], lamports?: string }}
 */
export function planRemint({ row, chain = {}, key, market = { wanted: false, exists: false }, nowMs, currentProgramId, defaultLamports = '0' }) {
    if (!row) return { action: 'skip', reason: 'not in the index', steps: [] };
    const rule = row.content?.rule || {};
    if (rule.binding !== true || !['owners', 'investors'].includes(rule.electorate)) return { action: 'skip', reason: 'a non-binding poll is never minted', steps: [] };
    const sponsor = row.content?.sponsor;
    if (!sponsor) return { action: 'skip', reason: 'names no sponsor wallet', steps: [] };
    const deadline = row.content?.deadline ?? row.deadline;
    if (deadline && !(Date.parse(deadline) > nowMs)) return { action: 'skip', reason: `expired (deadline ${deadline})`, steps: [] };
    const recordedHere = row.onchain?.programId === currentProgramId;
    if (row.onchain && !recordedHere && ['executed', 'cancelled', 'expired'].includes(row.onchain.status)) {
        return { action: 'skip', reason: `settled (${row.onchain.status}) on ${row.onchain.programId ?? 'another program'}`, steps: [] };
    }
    if (row.onchain && !recordedHere) {
        return { action: 'blocked', reason: `the index still records it on ${row.onchain.programId ?? 'another program'} (${row.onchain.status ?? 'no status'}); clear its onchain first`, steps: [] };
    }
    if (!chain.current && chain.old && chain.old.status !== 0) {
        // An old account that is no longer Active (executed/cancelled/expired) was settled; re-minting would reopen it.
        return { action: 'skip', reason: `already settled on the old program (status ${chain.old.status})`, steps: [] };
    }
    const steps = [];
    if (!chain.current) steps.push('pin', 'mint', 'record');
    else if (!recordedHere) steps.push('record');
    if (market.wanted && !market.exists) steps.push('open-market');
    if (!steps.length) return { action: 'skip', reason: 'already minted and recorded on the current program', steps };
    if (steps.includes('mint') && !key?.present) {
        return { action: 'needs-sponsor', reason: `only sponsor ${sponsor} can mint it${key ? ` (persona ${key.persona}: key file missing here)` : ' (not one of our personas)'}`, steps };
    }
    const lamports = chain.current ? String(chain.current.requiredLamports) : String(chain.old?.requiredLamports ?? defaultLamports);
    return { action: 'remint', steps, lamports };
}

function readState(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { agreements: {} }; throw error; }
}
function writeState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) usage(0);
    const { values } = parseArgs({ args: argv, options: {
        cids: { type: 'string' }, 'dry-run': { type: 'boolean' }, run: { type: 'boolean' }, markets: { type: 'boolean' },
        'market-liquidity-usdc': { type: 'string', default: '2' }, 'market-opener': { type: 'string', default: 'densifier-01' },
        lamports: { type: 'string', default: '0' }, 'api-base': { type: 'string', default: DEFAULT_API },
        'app-origin': { type: 'string', default: DEFAULT_ORIGIN }, state: { type: 'string', default: DEFAULT_STATE }, help: { type: 'boolean' }
    } });
    if (values.help) usage(0);
    if (values['dry-run'] === Boolean(values.run) || !values.cids) usage(2);
    const live = Boolean(values.run);
    const cids = [...new Set(values.cids.split(',').map(cid => cid.trim()).filter(Boolean))];
    const apiBase = values['api-base'].replace(/\/+$/, '');

    const web3 = require('@solana/web3.js');
    const agreementClient = require('../../frontend/js/solana/agreement-client.js');
    const lmsrClient = require('../../frontend/js/solana/lmsr-client.js');
    agreementClient.configure({ web3 });
    lmsrClient.configure({ web3 });
    const { usdcToAtomic } = await import('../agents/bettor.js');
    const { readAgreementAccount, AGREEMENT_PROGRAM_ID } = await import('../agents/agreement-minter.js');
    const { createRpcConnection } = await import('../solana/rpc.js');
    const { DEVNET_USDC_MINT } = await import('../solana/address-book.js');
    const connection = createRpcConnection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
    const pause = () => new Promise(resolve => setTimeout(resolve, 350)); // paced reads; public devnet answers bursts with 429
    const keys = personaKeys(JSON.parse(fs.readFileSync(path.join(HERE, '../agents/personas.json'), 'utf8')));
    const opener = [...keys.values()].find(entry => entry.persona === values['market-opener']);
    const openerWallet = [...keys.entries()].find(([, entry]) => entry === opener)?.[0];
    if (values.markets && !openerWallet) throw new Error(`market opener ${values['market-opener']} is not in personas.json`);
    const b = usdcToAtomic(values['market-liquidity-usdc']);
    const lmsr = require('../../frontend/js/bets/lmsr.js');
    const seedAtomic = values.markets ? lmsr.maxLoss(b) : 0n;
    const statePath = path.resolve(values.state);
    const state = readState(statePath);

    log(`${live ? 'RUN' : 'DRY RUN'}: ${cids.length} agreement(s), program ${AGREEMENT_PROGRAM_ID}, index ${apiBase}${values.markets ? `, markets b=${values['market-liquidity-usdc']} USDC (seed ${Number(seedAtomic) / 1e6} USDC each) opened by ${values['market-opener']}` : ''}`);
    const plans = [];
    for (const [i, cid] of cids.entries()) {
        const response = await fetch(`${apiBase}/agreements/${encodeURIComponent(cid)}`, { headers: { accept: 'application/json' } });
        if (!response.ok && response.status !== 404) throw new Error(`GET /agreements/${cid}: HTTP ${response.status}`);
        const row = response.ok ? await response.json() : null;
        const sponsor = row?.content?.sponsor ?? null;
        const chain = { current: null, old: null };
        let account = null;
        if (sponsor) {
            account = agreementClient.getAgreementPda(cid, sponsor, AGREEMENT_PROGRAM_ID)[0].toBase58();
            chain.current = await readAgreementAccount(connection, { account, programId: AGREEMENT_PROGRAM_ID });
            await pause();
            const oldAddress = agreementClient.getAgreementPda(cid, sponsor, OLD_AGREEMENT_PROGRAM_ID)[0];
            const old = await connection.getAccountInfo(oldAddress);
            await pause();
            if (old?.data?.length > OLD_STATUS_OFFSET) {
                const view = new DataView(old.data.buffer, old.data.byteOffset, old.data.length);
                chain.old = { address: oldAddress.toBase58(), requiredLamports: view.getBigUint64(OLD_REQUIRED_LAMPORTS_OFFSET, true), status: old.data[OLD_STATUS_OFFSET] };
            }
        }
        let market = { wanted: Boolean(values.markets), exists: false, address: null };
        if (values.markets && account && (row?.content?.deadline || row?.deadline)) {
            const closesAt = agreementClient.toDeadlineSeconds(row.content?.deadline ?? row.deadline);
            const [address] = lmsrClient.getMarketPda(account, openerWallet, { stakeMint: DEVNET_USDC_MINT, b, closesAt, graceSeconds: 0, maxPosition: 0n });
            market = { ...market, address: address.toBase58(), exists: Boolean(await connection.getAccountInfo(address)) };
            await pause();
        }
        const plan = planRemint({ row, chain, key: sponsor ? keys.get(sponsor) : undefined, market, nowMs: Date.now(), currentProgramId: AGREEMENT_PROGRAM_ID, defaultLamports: values.lamports });
        plans.push({ cid, row, account, plan, market, sponsor });
        log(`${i + 1}/${cids.length} ${cid} "${row?.title ?? '?'}" sponsor ${sponsor ?? '-'} (${keys.get(sponsor)?.persona ?? 'no persona key'}) → ${plan.action}${plan.reason ? `: ${plan.reason}` : ''}${plan.steps.length ? ` [${plan.steps.join(' → ')}]` : ''}${plan.lamports ? ` escrow ${plan.lamports} lamports` : ''}`);
        log(`    account ${account ?? '-'}${chain.current ? ` (exists, ${chain.current.status})` : ' (not on the current program)'}; old ${chain.old ? `${chain.old.address} status ${chain.old.status} required ${chain.old.requiredLamports}` : 'none'}${market.address ? `; market ${market.address} ${market.exists ? 'exists' : 'to open'}` : ''}`);
    }

    // Balances the signed steps need (one read per wallet).
    const rent = await connection.getMinimumBalanceForRentExemption(agreementClient.constants.AGREEMENT_ACCOUNT_SPACE);
    const needs = new Map();
    for (const { plan, sponsor } of plans) {
        if (plan.action !== 'remint' || !plan.steps.includes('mint')) continue;
        needs.set(sponsor, (needs.get(sponsor) ?? 0n) + BigInt(rent) + BigInt(plan.lamports) + 10_000n);
    }
    for (const [wallet, lamports] of needs) {
        const balance = await connection.getBalance(new web3.PublicKey(wallet));
        await pause();
        log(`sponsor ${wallet} (${keys.get(wallet)?.persona}): needs ≈${Number(lamports) / 1e9} SOL (rent ${rent / 1e9} + escrow + fee per mint), holds ${balance / 1e9} SOL${BigInt(balance) < lamports ? '  ← NOT ENOUGH' : ''}`);
    }
    const marketsToOpen = plans.filter(({ plan }) => plan.action === 'remint' && plan.steps.includes('open-market')).length;
    if (marketsToOpen) {
        const ata = lmsrClient.getAssociatedTokenAddress(openerWallet, DEVNET_USDC_MINT);
        // A missing token account holds nothing; any other read failure stops the dry run.
        const token = await connection.getTokenAccountBalance(ata).catch(error => {
            if (/could not find account|Invalid param/i.test(error.message)) return null;
            throw error;
        });
        const held = token ? BigInt(token.value.amount) : 0n;
        log(`market opener ${openerWallet} (${values['market-opener']}): needs ${Number(seedAtomic * BigInt(marketsToOpen)) / 1e6} USDC for ${marketsToOpen} seed(s), holds ${Number(held) / 1e6} USDC${held < seedAtomic * BigInt(marketsToOpen) ? '  ← NOT ENOUGH' : ''}`);
    }
    const counts = plans.reduce((acc, { plan }) => ({ ...acc, [plan.action]: (acc[plan.action] ?? 0) + 1 }), {});
    log(`plan: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    if (!live) { log('dry run: nothing signed, nothing written'); return 0; }

    const { createUrbanGameTheoryTools } = await import('../agents/ugt-agent-tools.js');
    const baseEnv = { ...process.env, UGT_API_BASE: apiBase, UGT_APP_ORIGIN: values['app-origin'], UGT_MCP_LIVE: '1',
        UGT_MCP_MAX_USDC_PER_ACTION: values['market-liquidity-usdc'] };
    let failed = 0;
    for (const [i, { cid, plan, sponsor, account }] of plans.entries()) {
        if (plan.action !== 'remint') continue;
        const entry = state.agreements[cid] ?? (state.agreements[cid] = {});
        try {
            if (plan.steps.includes('record')) {
                const tools = createUrbanGameTheoryTools({ env: { ...baseEnv, UGT_AGENT_KEYPAIR: keys.get(sponsor).keypairPath } });
                const minted = await tools.mintAgreement({ agreementCid: cid, lamports: plan.lamports, confirm: true });
                entry.minted = { account: minted.account, created: minted.created, signature: minted.createSignature, programId: minted.onchain?.programId ?? null, at: ts() };
                writeState(statePath, state);
                log(`${i + 1}/${plans.length} ${cid} ${minted.created ? 'minted' : 'already on chain'} ${minted.account}, recorded on ${minted.onchain?.programId ?? '(not recorded)'}`);
            }
            if (plan.steps.includes('open-market')) {
                const tools = createUrbanGameTheoryTools({ env: { ...baseEnv, UGT_AGENT_KEYPAIR: opener.keypairPath } });
                const opened = await tools.openMarket({ agreementAccount: account, liquidityUsdc: values['market-liquidity-usdc'], confirm: true });
                entry.market = { address: opened.address, replayed: opened.replayed, signature: opened.signature, seedAtomic: opened.seedAtomic, at: ts() };
                writeState(statePath, state);
                log(`${i + 1}/${plans.length} ${cid} market ${opened.address} ${opened.replayed ? 'already open' : `opened (seed ${Number(opened.seedAtomic) / 1e6} USDC, tx ${opened.signature})`}`);
            }
        } catch (error) {
            failed += 1;
            entry.error = { message: error.message, at: ts() };
            writeState(statePath, state);
            console.error(`[${ts()}] [remint] ${i + 1}/${plans.length} ${cid} FAILED: ${error.message}`);
        }
    }
    log(`done: ${failed} failed; state in ${statePath}`);
    return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(code => process.exit(code), error => { console.error(`[${ts()}] [remint] ${error.stack || error.message}`); process.exit(1); });
}
