// GET /markets?city=<id>: every contest (published agreements whose designs take overlapping ground) in
// a city, with the on-chain prediction market beside each minted agreement — what the Bets sheet lists
// and what an agent reads before staking. Agreements come from the index (consensus.agreement: its
// `onchain` pointer is recorded when an agreement is minted, its status as the lifecycle oracle
// observes the account), the sites of the designs of agreements sharing a parcel from consensus.design,
// market accounts from one batched RPC read; the payload is cached briefly per city because
// every sheet open would otherwise be an RPC. The dated LMSR recipe is registered separately in
// routes/lmsr-recipes.js; the old agreement-execution-v1 endpoint serves historical parimutuel proof.
// GET /markets?city=<id>&scope=other: the same for every other city, each contest naming its city.

import { createRequire } from 'node:module';
import { createRpcConnection } from '../solana/rpc.js';
import { buildContests, buildOtherCityContests, designCidsToCompare, landOverlap, subjectAccountOf } from '../markets/contests.js';
import { AGREEMENT_PROGRAM_ID, AgreementClient, DEVNET_GENESIS_HASH, ONCHAIN_STATUSES } from '../agreements/onchain.js';
import { AGREEMENT_EXECUTION_RECIPE_ID, buildAgreementExecutionRecipe, chainStatusOf } from '../oracle/market-recipe.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { currentPlanAgreementSelect, CURRENT_AGREEMENTS_BY_ACCOUNT_SQL } from '../agreements/current-plan-sql.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';
import { discoverAgreementMarkets } from '../markets/market-discovery.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The same codec the browser and the agent bettor use (frontend/js/solana/market-client.js).
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3 });
const lmsr = require('../../frontend/js/bets/lmsr.js');
const MARKET_PROGRAM_ID = marketClient.constants.PROGRAM_ID;

export { DEVNET_USDC_MINT };
const CACHE_TTL_MS = 20_000;
const MAX_AGREEMENTS = 2000;
const WORLD_KEY = 'world';

async function assertMarketNetwork(connection) {
    if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) {
        throw new Error('Agreement markets require Solana devnet.');
    }
}

export const AGREEMENTS_SQL = currentPlanAgreementSelect({ predicate: 'a.city = $1', orderBy: 'a.created_at DESC', limit: '$2' });
// Every city's agreements, read once for all World bets tabs; each answer leaves out the asking city.
export const ALL_CITY_AGREEMENTS_SQL = currentPlanAgreementSelect({ predicate: 'a.city IS NOT NULL', orderBy: 'a.created_at DESC', limit: '$1' });

// The agreements whose index pointer names an account; rowToAgreement keeps the account only when it
// is the one that row's CID and sponsor derive, so at most one row is it.
export const AGREEMENTS_BY_ACCOUNT_SQL = CURRENT_AGREEMENTS_BY_ACCOUNT_SQL;

// The ground of the listed designs ($1 text[]): the site each binding was computed on and its
// tolerance, which decide whether two agreements stand in one contest (markets/contests.js landOverlap).
export const DESIGN_LAND_SQL = `
    SELECT cid, ST_AsGeoJSON(site) AS site, binding->'toleranceM' AS tolerance_m
    FROM consensus.design
    WHERE cid = ANY($1::text[]) AND site IS NOT NULL`;

/** Design CID → { site, toleranceM } for the designs whose ground decides a contest. */
export async function readDesignLand(db, designCids) {
    if (!designCids.length) return new Map();
    const { rows } = await db.query(DESIGN_LAND_SQL, [designCids]);
    return new Map(rows.map(row => [row.cid, {
        site: typeof row.site === 'string' ? JSON.parse(row.site) : row.site,
        toleranceM: row.tolerance_m ?? null
    }]));
}

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
        sponsor: text(row.sponsor),
        designCids: Array.isArray(row.design_cids) ? row.design_cids : [],
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

/** The codec authenticates the address and vault. These checks bind the funded USDC book to its agreement. */
export function hasAgreementMarketTerms(market, account, subject) {
    return !!market && market.proposal === account && market.stakeMint === DEVNET_USDC_MINT
        && (market.kind === 0 || (market.kind === 1 && subject.lenses.includes(market.trustedAttester)))
        && Number.isFinite(new Date(Number(market.closesAt) * 1000).getTime())
        && typeof market.b === 'bigint' && market.b > 0n && market.seed === lmsr.maxLoss(market.b);
}

export function defaultMarketReader(env = process.env) {
    let connection;
    return async (accounts, agreements = []) => {
        connection ??= createRpcConnection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed',
            { programAccountsEndpoint: env.SOLANA_PROGRAM_ACCOUNTS_RPC_URL || null });
        await assertMarketNetwork(connection);
        const indexed = new Map(agreements.map(row => [row.account, row]));
        if (accounts.some(account => !indexed.get(account)?.sponsor)) throw new Error('An indexed agreement sponsor is required.');
        const [found, subjects] = await Promise.all([
            discoverAgreementMarkets(connection, accounts),
            getMultipleAccountsBatched(connection, accounts.map(address => new web3.PublicKey(address)), { batchSize: accountsPerRequest(env) })
        ]);
        return new Map(accounts.map((account, i) => {
            const info = subjects[i];
            if (info?.owner?.toBase58() !== AGREEMENT_PROGRAM_ID) throw new Error('Agreement account is unavailable.');
            const subject = AgreementClient.readAgreement(info.data, account);
            const row = indexed.get(account);
            if (!subject || subject.cid !== row?.cid || subject.authority !== row.sponsor || !ONCHAIN_STATUSES[subject.statusCode]) {
                throw new Error('Agreement account identity or status differs.');
            }
            return [account, { sponsor: subject.authority, lenses: subject.lenses, chainStatus: ONCHAIN_STATUSES[subject.statusCode],
                deadline: subject.deadline > 0 ? new Date(subject.deadline * 1000).toISOString() : null,
                markets: found.get(account).filter(item => hasAgreementMarketTerms(item.market, account, subject)) }];
        }));
    };
}

export function setupMarketsRoute(app, pool, options = {}) {
    const env = options.env || process.env;
    const readMarkets = options.readMarkets || defaultMarketReader(env);
    const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : CACHE_TTL_MS;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    // Last good read (agreements + market accounts) per key, and the read in flight. A cached read is
    // served at once even after its TTL (stale-while-revalidate): the chain read for every city takes
    // tens of seconds on a throttled devnet RPC, and a failed refresh must not blank a sheet that had an
    // answer. Key `city:<id>` per city; one key `world` holds every city for all World bets tabs.
    const cache = new Map();
    const building = new Map();

    async function readData(key, city) {
        const world = key === WORLD_KEY;
        const { rows } = await pool.query(world ? ALL_CITY_AGREEMENTS_SQL : AGREEMENTS_SQL, world ? [MAX_AGREEMENTS] : [city, MAX_AGREEMENTS]);
        const agreements = rows.map(rowToAgreement);
        const accounts = Array.from(new Set(agreements.map(item => item.account).filter(Boolean)));
        const [markets, designLand] = await Promise.all([
            accounts.length ? readMarkets(accounts, agreements) : new Map(),
            readDesignLand(pool, designCidsToCompare(agreements))
        ]);
        // Judged once per read: every request served from this read reuses the same answers.
        return { agreements, markets, overlaps: landOverlap(designLand) };
    }

    // Statuses are judged at the current time; generatedAt stays the time the chain was read.
    function payloadFor(city, other, { at, data: { agreements, markets, overlaps } }) {
        return {
            ...(other ? buildOtherCityContests : buildContests)({ city, agreements, markets, overlaps, now: now() }),
            generatedAt: new Date(at).toISOString(),
            cluster: 'devnet',
            agreementProgram: AGREEMENT_PROGRAM_ID,
            marketProgram: MARKET_PROGRAM_ID,
            stakeMint: DEVNET_USDC_MINT,
            stakeDecimals: 6
        };
    }

    // One build per key at a time, unless `force` (fresh=1 must read after the caller's transaction).
    function refresh(key, city, { force = false } = {}) {
        if (!force && building.has(key)) return building.get(key);
        const job = readData(key, city).then(data => {
            const entry = { at: now().getTime(), data };
            cache.set(key, entry);
            return entry;
        }).finally(() => { if (building.get(key) === job) building.delete(key); });
        building.set(key, job);
        return job;
    }

    const logFailure = (city, other, error) =>
        console.error(`[${new Date().toISOString()}] GET /markets?city=${city}${other ? '&scope=other' : ''} failed:`, error);

    app.get('/markets', async (req, res) => {
        const city = normalizeCityCode(req.query.city);
        if (!city) return res.status(400).json({ error: 'city query parameter is required' });
        // ?fresh=1 skips the cache: the sheet asks for it right after a confirmed transaction, when a
        // 20-second-old answer would show the pool it just opened as missing.
        const fresh = String(req.query.fresh || '') === '1';
        const other = req.query.scope === 'other';
        const key = other ? WORLD_KEY : `city:${city}`;
        const cached = cache.get(key);
        if (cached && !fresh) {
            if (now().getTime() - cached.at >= cacheTtlMs) refresh(key, city).catch(error => logFailure(city, other, error));
            res.set('Cache-Control', 'public, max-age=10');
            return res.json(payloadFor(city, other, cached));
        }
        try {
            const entry = await refresh(key, city, { force: fresh });
            res.set('Cache-Control', 'public, max-age=10');
            res.json(payloadFor(city, other, entry));
        } catch (error) {
            logFailure(city, other, error);
            if (cached) {
                // The last good answer beats none; the header says it is older than asked for.
                res.set('Cache-Control', 'no-store');
                res.set('X-Markets-Stale', 'true');
                return res.json(payloadFor(city, other, cached));
            }
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

    // warmWorld(): read the World list now, so the first visitor after a deploy does not wait for it.
    // The server calls it once it listens; tests and route setup alone read nothing.
    return { warmWorld: () => refresh(WORLD_KEY, null).catch(error => logFailure('*', true, error)) };
}
