// GET /markets?city=<id>: every contest (published agreements over the same land) in a city, with the
// on-chain prediction market beside each minted agreement — what the Bets sheet lists and what an
// agent reads before staking. Agreements come from the index (consensus.agreement: its `onchain`
// pointer is recorded when an agreement is minted, its status as the lifecycle oracle observes the
// account), market accounts from one batched RPC read; the payload is cached briefly per city because
// every sheet open would otherwise be an RPC. GET /oracle/recipes/agreement-execution-v1 serves the
// recipe one agreement's pool settles by (oracle/market-recipe.js).

import { createRequire } from 'node:module';
import { Connection } from '@solana/web3.js';
import { buildContests, subjectAccountOf } from '../markets/contests.js';
import { AGREEMENT_PROGRAM_ID, DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { AGREEMENT_EXECUTION_RECIPE_ID, buildAgreementExecutionRecipe, chainStatusOf } from '../oracle/market-recipe.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { AGREEMENT_TABLE } from './agreements.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The same codec the browser and the agent bettor use (frontend/js/solana/market-client.js).
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3 });
const MARKET_PROGRAM_ID = marketClient.constants.PROGRAM_ID;

export { DEVNET_USDC_MINT };
const CACHE_TTL_MS = 20_000;
const MAX_AGREEMENTS = 2000;

async function assertMarketNetwork(connection) {
    if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
        throw new Error('Agreement markets require Solana devnet.');
    }
}

// The columns rowToAgreement reads.
export const AGREEMENT_COLUMNS_SQL = `
        cid, city, title, author, input_parcel_ids, parcel_source_id, deadline,
        content->>'sponsor' AS sponsor,
        ARRAY(SELECT design->>'title' FROM jsonb_array_elements(content->'designs') AS design) AS design_titles,
        onchain, screenshot_url, screenshot_before_url, screenshot_pair_url, created_at`;

const AGREEMENTS_SQL = `
    SELECT ${AGREEMENT_COLUMNS_SQL}
    FROM ${AGREEMENT_TABLE}
    WHERE city = $1
    ORDER BY created_at DESC
    LIMIT $2`;

// The agreements whose index pointer names an account; rowToAgreement keeps the account only when it
// is the one that row's CID and sponsor derive, so at most one row is it.
const AGREEMENTS_BY_ACCOUNT_SQL = `
    SELECT ${AGREEMENT_COLUMNS_SQL}
    FROM ${AGREEMENT_TABLE}
    WHERE onchain->>'account' = $1
    ORDER BY created_at DESC
    LIMIT 20`;

const iso = value => (value instanceof Date ? value.toISOString() : value || null);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

// A Solana account exactly as given: base58 that round-trips, or null.
function canonicalAccount(value) {
    if (typeof value !== 'string' || !value) return null;
    try { return new web3.PublicKey(value).toBase58() === value ? value : null; } catch { return null; }
}

/** An index row as buildContests reads it (markets/contests.js). */
export function rowToAgreement(row) {
    const account = subjectAccountOf({ cid: row.cid, sponsor: row.sponsor, onchain: row.onchain });
    return {
        cid: row.cid,
        city: row.city || null,
        title: text(row.title),
        author: text(row.author),
        designTitles: (Array.isArray(row.design_titles) ? row.design_titles : []).map(text).filter(Boolean),
        inputParcelIds: Array.isArray(row.input_parcel_ids) ? row.input_parcel_ids : [],
        parcelSourceId: row.parcel_source_id || null,
        deadline: iso(row.deadline),
        createdAt: iso(row.created_at),
        screenshotUrl: row.screenshot_url || null,
        screenshotBeforeUrl: row.screenshot_before_url || null,
        screenshotPairUrl: row.screenshot_pair_url || null,
        account,
        // What the lifecycle oracle last observed on the account; only a minted agreement has one.
        chainStatus: account ? chainStatusOf(row.onchain) : null
    };
}

/** The minted agreement whose chain account this is, as rowToAgreement reads it, or null. */
export async function agreementByAccount(db, account) {
    const { rows } = await db.query(AGREEMENTS_BY_ACCOUNT_SQL, [account]);
    return rows.map(rowToAgreement).find(agreement => agreement.account === account) || null;
}

// Market accounts for a list of agreement accounts (the markets' subjects), read in batches through
// SOLANA_RPC_URL. Returns Map(agreementAccount → { address, market|null }).
export function defaultMarketReader(env = process.env) {
    const batchSize = accountsPerRequest(env);
    let connection = null;
    return async (accounts) => {
        connection ??= new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        await assertMarketNetwork(connection);
        const pdas = accounts.map(account => ({ account, pda: marketClient.getMarketPda(account)[0] }));
        const result = new Map();
        const infos = await getMultipleAccountsBatched(connection, pdas.map(entry => entry.pda), { batchSize });
        pdas.forEach((entry, index) => {
            const info = infos[index];
            let market = null;
            if (info) {
                if (info.owner?.toBase58() !== MARKET_PROGRAM_ID) throw new Error('Unexpected market account program.');
                market = marketClient.decodeMarket(info.data);
                // The program names a market's subject account `proposal`.
                if (market.proposal !== entry.account || market.stakeMint !== DEVNET_USDC_MINT) {
                    throw new Error('Market account has a different subject or stake mint.');
                }
            }
            result.set(entry.account, { address: entry.pda.toBase58(), market });
        });
        return result;
    };
}

export function setupMarketsRoute(app, pool, options = {}) {
    const env = options.env || process.env;
    const readMarkets = options.readMarkets || defaultMarketReader(env);
    const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : CACHE_TTL_MS;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const cache = new Map();

    app.get('/markets', async (req, res) => {
        const city = normalizeCityCode(req.query.city);
        if (!city) return res.status(400).json({ error: 'city query parameter is required' });
        // ?fresh=1 skips the cache: the sheet asks for it right after a confirmed transaction, when a
        // 20-second-old answer would show the pool it just opened as missing.
        const fresh = String(req.query.fresh || '') === '1';
        const cached = fresh ? null : cache.get(city);
        if (cached && now().getTime() - cached.at < cacheTtlMs) {
            res.set('Cache-Control', 'public, max-age=10');
            return res.json(cached.payload);
        }
        try {
            const { rows } = await pool.query(AGREEMENTS_SQL, [city, MAX_AGREEMENTS]);
            const agreements = rows.map(rowToAgreement);
            const accounts = Array.from(new Set(agreements.map(item => item.account).filter(Boolean)));
            const markets = accounts.length ? await readMarkets(accounts) : new Map();
            const payload = {
                ...buildContests({ city, agreements, markets, now: now() }),
                cluster: 'devnet',
                agreementProgram: AGREEMENT_PROGRAM_ID,
                marketProgram: MARKET_PROGRAM_ID,
                stakeMint: DEVNET_USDC_MINT,
                stakeDecimals: 6
            };
            cache.set(city, { at: now().getTime(), payload });
            res.set('Cache-Control', 'public, max-age=10');
            res.json(payload);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /markets?city=${city} failed:`, error);
            res.status(502).json({ error: 'Markets are unavailable right now' });
        }
    });

    // GET /oracle/recipes/agreement-execution-v1?agreement=<account>[&market=<market account>]: the recipe
    // a minted agreement's pool settles by, with the agreement's CID from the index. `market`, when given,
    // must be that agreement's pool (PDA ["market", agreement]); the paid verified fact
    // (/agent/oracle/facts?subject=&market=, oracle/verified-fact.js) binds the same recipe.
    app.get(`/oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID}`, async (req, res) => {
        const agreementAccount = canonicalAccount(req.query.agreement);
        if (!agreementAccount) return res.status(400).json({ error: 'agreement must be a Solana address' });
        let marketAccount = null;
        if (req.query.market !== undefined) {
            const expected = marketClient.getMarketPda(agreementAccount)[0].toBase58();
            if (canonicalAccount(req.query.market) !== expected) {
                return res.status(400).json({ error: "market must be the agreement's market account", expected });
            }
            marketAccount = expected;
        }
        try {
            const agreement = await agreementByAccount(pool, agreementAccount);
            if (!agreement) return res.status(404).json({ error: 'No minted agreement has this account.' });
            return res.json({ recipe: buildAgreementExecutionRecipe({ agreementAccount, agreementCid: agreement.cid, marketAccount }) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /oracle/recipes/${AGREEMENT_EXECUTION_RECIPE_ID} failed:`, error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });
}
