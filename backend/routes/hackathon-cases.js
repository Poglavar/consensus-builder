// One read-only graph for a judge to inspect an agreement across parcel identity, activity, support,
// forecasting, public evidence and settlement. A case is an agreement by its CID; its chain account
// (the recorded onchain account, else PDA(sponsor, CID)) is the subject of its market, pledges and
// lifecycle events. GET never manufactures a completed stage.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildHackathonCase } from '../hackathon/case-model.js';
import { eventFromRow } from './land-events.js';
import { agreementAccountIndex, agreementEvents, chainEvents, mergeEvents, runEvents } from './agent-activity.js';
import { loadIdls } from '../solana/tx-decoder.js';
import { buildAddressBook } from '../solana/address-book.js';
import { loadAgreement } from './agreements.js';
import { agreementAccountOf } from '../agreements/onchain.js';
import { isCid } from '../cid.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
pledgeClient.configure({ web3 });
marketClient.configure({ web3 });

const USDC_DECIMALS = 6;

function baseUrl(req, env) {
    return (env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function siteUrl(env) {
    return String(env.PUBLIC_SITE_BASE_URL || 'https://urbangametheory.xyz').replace(/\/$/, '');
}

// The case's agreement from the index, with its chain account, or null.
async function loadCaseAgreement(pool, cid) {
    const row = await loadAgreement(pool, cid);
    if (!row) return null;
    const sponsor = row.content?.sponsor ?? null;
    return {
        cid: row.cid,
        city: row.city,
        title: row.title,
        author: row.author,
        sponsor,
        status: row.status,
        createdAt: row.createdAt,
        deadline: row.deadline,
        inputParcelIds: Array.isArray(row.inputParcelIds) ? row.inputParcelIds : [],
        onchain: row.onchain ?? null,
        account: row.onchain?.account ?? (sponsor ? agreementAccountOf(row.cid, sponsor) : null)
    };
}

let caseIdls;
const caseBook = buildAddressBook({ personas: JSON.parse(fs.readFileSync(new URL('../agents/personas.json', import.meta.url), 'utf8')) });
async function loadActivity(pool, cid, { decode, book = caseBook } = {}) {
    const [runs, agreements] = await Promise.all([
        pool.query(`
            SELECT run_id, persona, mode, status, stage, summary, started_at, updated_at
              FROM consensus.agent_run
             WHERE EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(summary->'activities', '[]'::jsonb)) activity
                  WHERE activity->'entity'->>'id' = $1 OR activity->'action'->>'agreementCid' = $1
             )
             ORDER BY updated_at DESC
             LIMIT 250
        `, [cid]),
        pool.query("SELECT cid, title, created_at, onchain, content->>'sponsor' AS sponsor FROM consensus.agreement WHERE cid = $1", [cid])
    ]);
    const agreementsByAccount = agreementAccountIndex(agreements.rows);
    // Scope before limiting: unrelated new activity must never age a headline case out of its proof.
    const transactions = agreementsByAccount.size ? await pool.query(`
        SELECT signature, slot, block_time, raw, created_at FROM consensus.solana_transaction
         WHERE cluster = 'devnet' AND touched_addresses && $1::text[]
         ORDER BY block_time DESC NULLS LAST, slot DESC LIMIT 1000
    `, [[...agreementsByAccount.keys()]]) : { rows: [] };
    caseIdls ??= loadIdls(fileURLToPath(new URL('../../blockchain/solana/idl', import.meta.url)));
    const confirmed = chainEvents(transactions.rows, { book, idls: caseIdls, agreementsByAccount, ...(decode ? { decode } : {}) })
        .filter(event => event.ok === true);
    return mergeEvents(
        agreementEvents(agreements.rows),
        runs.rows.flatMap(row => runEvents(row, book)),
        confirmed
    ).filter(event => event.ok !== false && String(event.entity?.id || event.action?.agreementCid || '') === cid);
}

// The agreement's land events: its terminal lifecycle event (subject its account) and the per-parcel
// executed events, which name the agreement in their evidence.
async function loadOracleEvents(pool, { account, cid }) {
    const { rows } = await pool.query(`
        SELECT event_id, event_type, subject_type, subject_id, outcome, source_url,
               source_hash, source_observed_at, attester, transaction_signature,
               evidence, created_at
          FROM consensus.land_event
         WHERE ($1::text IS NOT NULL AND subject_id = $1) OR evidence->>'agreementCid' = $2
         ORDER BY source_observed_at DESC
         LIMIT 25
    `, [account, cid]);
    return rows.map(eventFromRow);
}

async function readSupport(connection, agreementAccount) {
    const subject = new web3.PublicKey(agreementAccount);
    const [donations, pledges] = await Promise.all([
        pledgeClient.readDonationEscrow(connection, subject),
        pledgeClient.readPledgeBook(connection, subject)
    ]);
    return {
        state: 'available',
        donations: donations ? {
            escrow: pledgeClient.getDonationEscrowPda(subject)[0].toBase58(),
            totalUsdc: pledgeClient.formatUsdc(donations.totalDonated),
            releasedUsdc: pledgeClient.formatUsdc(donations.totalReleased),
            refundedUsdc: pledgeClient.formatUsdc(donations.totalRefunded),
            donationCount: donations.donationCount.toString(),
            donorCount: donations.donorCount.toString(),
            released: donations.released
        } : null,
        pledges: pledges ? {
            book: pledgeClient.getPledgeBookPda(subject)[0].toBase58(),
            activeUsdc: pledgeClient.formatUsdc(pledges.activePledged),
            fulfilledUsdc: pledgeClient.formatUsdc(pledges.totalFulfilled),
            revokedUsdc: pledgeClient.formatUsdc(pledges.totalRevoked),
            pledgeCount: pledges.pledgeCount.toString(),
            activeCount: pledges.activeCount.toString(),
            fulfilledCount: pledges.fulfilledCount.toString()
        } : null
    };
}

async function readMarket(connection, agreementAccount) {
    const subject = new web3.PublicKey(agreementAccount);
    const [account] = marketClient.getMarketPda(subject);
    const market = await marketClient.readMarket(connection, subject);
    if (!market) return { state: 'available', exists: false, account: account.toBase58() };
    const probability = marketClient.impliedProbability(market.yesPool, market.noPool);
    return {
        state: 'available',
        exists: true,
        account: account.toBase58(),
        yesAtomic: market.yesPool.toString(),
        noAtomic: market.noPool.toString(),
        yesUsdc: marketClient.formatAtomic(market.yesPool, USDC_DECIMALS),
        noUsdc: marketClient.formatAtomic(market.noPool, USDC_DECIMALS),
        impliedProbability: probability,
        resolved: market.resolved,
        outcome: market.resolved ? (market.outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO') : null
    };
}

function unavailable(error) {
    return { state: 'unavailable', error: error?.message || String(error) };
}

export function setupHackathonCasesRoute(app, pool, {
    env = process.env,
    agreementReader = loadCaseAgreement,
    activityReader = loadActivity,
    oracleReader = loadOracleEvents,
    supportReader = readSupport,
    marketReader = readMarket,
    connection = null
} = {}) {
    let rpcConnection = connection;
    const getConnection = () => {
        if (!rpcConnection) rpcConnection = new web3.Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        return rpcConnection;
    };
    app.get('/hackathon/cases/:cid', async (req, res) => {
        try {
            const cid = String(req.params.cid || '').trim();
            if (!isCid(cid)) return res.status(400).json({ error: 'a case is an agreement CID' });
            const agreement = await agreementReader(pool, cid);
            if (!agreement) return res.status(404).json({ error: 'Hackathon case agreement not found' });
            const account = agreement.account;
            const [activityResult, oracleResult, supportResult, marketResult] = await Promise.allSettled([
                activityReader(pool, agreement.cid),
                oracleReader(pool, { account, cid: agreement.cid }),
                account ? supportReader(getConnection(), account) : Promise.resolve(null),
                account ? marketReader(getConnection(), account) : Promise.resolve(null)
            ]);
            const activity = activityResult.status === 'fulfilled' ? activityResult.value : [];
            const oracleEvents = oracleResult.status === 'fulfilled' ? oracleResult.value : null;
            const support = supportResult.status === 'fulfilled' ? supportResult.value : unavailable(supportResult.reason);
            const market = marketResult.status === 'fulfilled' ? marketResult.value : unavailable(marketResult.reason);
            const api = baseUrl(req, env);
            const site = siteUrl(env);
            const city = agreement.city ? `?city=${encodeURIComponent(agreement.city)}` : '';
            return res.json(buildHackathonCase({
                agreement, activity, support, market, oracleEvents,
                activityError: activityResult.status === 'rejected' ? 'Confirmed activity could not be read.' : null,
                links: {
                    self: `${api}/hackathon/cases/${encodeURIComponent(agreement.cid)}`,
                    agreement: `${api}/agreements/${encodeURIComponent(agreement.cid)}`,
                    map: `${site}/agreements/${encodeURIComponent(agreement.cid)}${city}`,
                    market: account ? `${site}/bets/${encodeURIComponent(account)}${city}` : null,
                    activity: `${api}/agent/activity?agreement=${encodeURIComponent(agreement.cid)}&limit=200`,
                    support: account ? `${api}/agent/pledges/${encodeURIComponent(account)}` : null,
                    events: `${api}/oracle/events?agreement=${encodeURIComponent(agreement.cid)}`
                }
            }));
        } catch (error) {
            console.error('GET /hackathon/cases/:cid failed', error);
            return res.status(500).json({ error: 'Failed to build hackathon case' });
        }
    });
}

export { loadActivity, loadCaseAgreement, loadOracleEvents, readMarket, readSupport };
