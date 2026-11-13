// Awards the city meme token for resolved agreement markets (docs/citymemetoken.md): points
// markets resolved before awards existed, and devnet-USDC markets from the transaction mirror.
// Then settles city-token boosts of agreements whose chain status is final (paid or refunded).
// Idempotent: a market with a consensus.city_token_market row is done; a settled boost is not active.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import database from '../db/connection.cjs';
import { transaction } from '../markets/points-ledger.js';
import { awardMarket, awardPointsMarket, settleBoosts } from '../markets/city-token-ledger.js';
import { createAgreementMarketSource } from '../markets/agreement-source.js';
import { netShares } from '../markets/city-token-rewards.js';
import { readAgreementMarkets } from '../agents/bettor.js';
import { createAgreementChain } from '../agreements/onchain.js';
import { loadIdls, lmsrFills } from '../solana/tx-decoder.js';

const BACKEND_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IDL_DIR = resolve(BACKEND_DIR, '..', 'blockchain', 'solana', 'idl');
const OUTCOMES = { 0: 'no', 1: 'yes', 2: 'void' };
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const USAGE = `Usage: node scripts/award-city-tokens.mjs (--dry-run | --apply) [--book points|devnet-usdc|all]

Awards the city meme token to correct bettors of resolved agreement markets, then settles
boosts of executed (paid out), cancelled or expired (refunded) agreements.
  --dry-run   compute and print awards, write nothing
  --apply     write awards (each market once; reruns skip awarded markets)
  --book      which book to award (default all)`;

function args(argv) {
    if (argv.includes('--help') || argv.includes('-h') || (!argv.includes('--apply') && !argv.includes('--dry-run'))) return null;
    const book = argv.includes('--book') ? argv[argv.indexOf('--book') + 1] : 'all';
    if (!['points', 'devnet-usdc', 'all'].includes(book)) throw new Error(`unknown --book ${book}`);
    return { apply: argv.includes('--apply'), book };
}

// Runs fn in a transaction that commits only with --apply.
async function inTransaction(pool, apply, fn) {
    if (apply) return transaction(pool, fn);
    const db = await pool.connect();
    try { await db.query('BEGIN'); return await fn(db); } finally { await db.query('ROLLBACK'); db.release(); }
}

function report(label, result) {
    if (!result.awarded) return log(`${label}: skipped (${result.reason})`);
    const lines = result.awards.map(a => `${a.holder.slice(0, 8)} ${a.token}=${a.amount}`).join(', ');
    log(`${label}: ${result.recipients} recipient(s)${lines ? `: ${lines}` : ''}`);
}

async function awardPoints(pool, apply) {
    const { rows } = await pool.query(`SELECT m.* FROM consensus.points_market m
        WHERE m.resolved AND NOT EXISTS (SELECT 1 FROM consensus.city_token_market c WHERE c.book = 'points' AND c.market = m.id::text)
        ORDER BY m.updated_at`);
    log(`points: ${rows.length} resolved market(s) without awards`);
    let done = 0;
    for (const market of rows) {
        const result = await inTransaction(pool, apply, db => awardPointsMarket(db, market));
        report(`points ${++done}/${rows.length} ${market.agreement_account.slice(0, 8)} (${market.city})`, result);
    }
}

async function awardUsdc(pool, apply) {
    const { rows: agreements } = await pool.query(`SELECT DISTINCT ON (onchain->>'account') onchain->>'account' AS account, city
        FROM consensus.agreement WHERE onchain->>'chain' = 'solana' AND onchain ? 'account' ORDER BY onchain->>'account', created_at DESC`);
    const { rows: awarded } = await pool.query(`SELECT agreement_account FROM consensus.city_token_market WHERE book = 'devnet-usdc'`);
    const skip = new Set(awarded.map(row => row.agreement_account));
    const pending = agreements.filter(row => !skip.has(row.account));
    log(`devnet-usdc: ${agreements.length} on-chain agreement(s), ${skip.size} already awarded, reading ${pending.length} market(s)`);
    if (!pending.length) return;
    const chain = createAgreementChain({ env: process.env });
    const connection = await chain.connection();
    const idls = loadIdls(IDL_DIR);
    const cityOf = new Map(pending.map(row => [row.account, row.city]));
    const markets = await readAgreementMarkets(connection, pending.map(row => row.account));
    const resolved = [...markets.values()].filter(entry => entry.market?.resolved);
    log(`devnet-usdc: ${resolved.length} resolved market(s) to award`);
    let done = 0, incomplete = 0;
    for (const entry of resolved) {
        const address = entry.address.toBase58();
        const label = `devnet-usdc ${++done}/${resolved.length} ${address.slice(0, 8)}`;
        const { rows } = await pool.query(`SELECT raw FROM consensus.solana_transaction
            WHERE touched_addresses @> ARRAY[$1]::text[] ORDER BY slot, signature`, [address]);
        const fills = rows.flatMap(row => lmsrFills(row.raw, { idls }))
            .filter(fill => fill.market === address)
            .map(fill => ({ ...fill, holder: fill.trader }));
        // The mirror must hold every trade: its net shares have to equal the market's on-chain q.
        const net = netShares(fills);
        if (net.yes !== BigInt(entry.market.qYes) || net.no !== BigInt(entry.market.qNo)) {
            incomplete++;
            log(`${label}: skipped, mirror incomplete (fills ${net.yes}/${net.no} vs chain ${entry.market.qYes}/${entry.market.qNo}); sync transactions and rerun`);
            continue;
        }
        const result = await inTransaction(pool, apply, db => awardMarket(db, {
            book: 'devnet-usdc', market: address, agreementAccount: entry.agreement.address,
            city: cityOf.get(entry.agreement.address), outcome: OUTCOMES[entry.market.outcome],
            fills, walletOf: holder => holder
        }));
        report(label, result);
    }
    if (incomplete) throw new Error(`${incomplete} devnet-usdc market(s) not awarded: transaction mirror incomplete`);
}

async function settle(pool, apply) {
    const { rows } = await pool.query(`SELECT agreement_account, agreement_cid, count(*)::int AS boosts
        FROM consensus.city_token_boost WHERE status = 'active' GROUP BY 1, 2 ORDER BY 1`);
    log(`boosts: ${rows.length} agreement(s) with active boosts`);
    if (!rows.length) return;
    const readAgreement = createAgreementMarketSource(pool, { env: process.env });
    const sources = await readAgreement.many(rows.map(row => row.agreement_account));
    let done = 0, failed = 0;
    for (const row of rows) {
        const label = `boosts ${++done}/${rows.length} ${row.agreement_account.slice(0, 8)}`;
        const source = sources.get(row.agreement_account);
        if (!source || source instanceof Error) { failed++; log(`${label}: chain evidence unavailable (${source?.message || 'missing'})`); continue; }
        if (source.chainStatus === 'active') { log(`${label}: still active, ${row.boosts} boost(s) held`); continue; }
        const { rows: [agreement] } = await pool.query('SELECT content FROM consensus.agreement WHERE cid = $1', [row.agreement_cid]);
        const rights = agreement?.content?.rule?.approvalConfig?.rights || null;
        const result = await inTransaction(pool, apply, db => settleBoosts(db, {
            agreementAccount: row.agreement_account, chainStatus: source.chainStatus, sponsor: source.sponsor, rights }));
        log(`${label}: ${source.chainStatus}, ${result.settled} boost(s) ${result.outcome}${rights ? '' : ' (no rights snapshot: owners\' share to the sponsor)'}`);
    }
    if (failed) throw new Error(`${failed} agreement(s) with boosts could not be read from the chain`);
}

async function main() {
    const options = args(process.argv.slice(2));
    if (!options) { console.log(USAGE); return; }
    dotenv.config({ path: resolve(BACKEND_DIR, '.env'), quiet: true });
    const pool = database.createPool({ max: 2 });
    log(`${options.apply ? 'APPLY' : 'DRY RUN'}: book ${options.book}, database ${database.describeDatabase().database}`);
    try {
        if (options.book !== 'devnet-usdc') await awardPoints(pool, options.apply);
        if (options.book !== 'points') await awardUsdc(pool, options.apply);
        await settle(pool, options.apply);
        log('done');
    } finally { await pool.end(); }
}

main().catch(error => { console.error(`[${new Date().toISOString()}] award-city-tokens failed:`, error); process.exit(1); });
