// One read-only graph for a judge to inspect a proposal across parcel identity, activity, support,
// forecasting, public evidence and settlement. GET never manufactures a completed stage.
import { createRequire } from 'node:module';
import { buildHackathonCase } from '../hackathon/case-model.js';
import { eventFromRow } from './land-events.js';
import { mergeEvents, proposalEvents, runEvents } from './agent-activity.js';

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

async function loadProposal(pool, id) {
    const { rows } = await pool.query(`
        SELECT id, proposal_id, city,
               COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS name,
               COALESCE(title, name, proposal_data->>'title', proposal_data->>'name') AS title,
               COALESCE(author, proposal_data->>'author') AS author,
               CASE
                   WHEN LOWER(COALESCE(lifecycle_status, '')) NOT IN ('executed', 'cancelled', 'expired')
                        AND expires_at IS NOT NULL AND expires_at <= now() THEN 'Expired'
                   WHEN LOWER(COALESCE(lifecycle_status, '')) = 'executed' THEN 'Executed'
                   WHEN LOWER(COALESCE(lifecycle_status, '')) = 'cancelled' THEN 'Cancelled'
                   WHEN LOWER(COALESCE(lifecycle_status, '')) = 'expired' THEN 'Expired'
                   ELSE 'Active'
               END AS lifecycle_status,
               created_at, expires_at, cadastre_parcel_ids, onchain_data,
               proposal_data->'agent' AS agent
          FROM proposal
         WHERE proposal_id = $1 OR id::text = $1
         LIMIT 1
    `, [id]);
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        city: row.city,
        name: row.name,
        title: row.title,
        author: row.author,
        lifecycleStatus: row.lifecycle_status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        cadastreParcelIds: Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : [],
        onchain: row.onchain_data && typeof row.onchain_data === 'object' ? row.onchain_data : null,
        agent: row.agent && typeof row.agent === 'object' ? row.agent : null
    };
}

async function loadActivity(pool, proposalId) {
    const [runs, proposals] = await Promise.all([
        pool.query(`
            SELECT run_id, persona, mode, status, stage, summary, started_at, updated_at
              FROM consensus.agent_run
             ORDER BY updated_at DESC
             LIMIT 250
        `),
        pool.query(`
            SELECT proposal_id,
                   COALESCE(name, title, proposal_data->>'name', proposal_data->>'title') AS display_name,
                   proposal_data->'agent' AS agent, created_at, updated_at
              FROM proposal
             WHERE proposal_id = $1 AND proposal_data ? 'agent'
             LIMIT 1
        `, [proposalId])
    ]);
    return mergeEvents(
        runs.rows.flatMap(runEvents),
        proposals.rows.flatMap(proposalEvents)
    ).filter(event => String(event.entity?.id || event.action?.proposalId || '') === proposalId);
}

async function loadOracleEvents(pool, proposalAccount) {
    if (!proposalAccount) return [];
    const { rows } = await pool.query(`
        SELECT event_id, event_type, subject_type, subject_id, outcome, source_url,
               source_hash, source_observed_at, attester, transaction_signature,
               evidence, created_at
          FROM consensus.land_event
         WHERE subject_id = $1
         ORDER BY source_observed_at DESC
         LIMIT 25
    `, [proposalAccount]);
    return rows.map(eventFromRow);
}

async function readSupport(connection, proposalAccount) {
    const proposal = new web3.PublicKey(proposalAccount);
    const [donations, pledges] = await Promise.all([
        pledgeClient.readDonationEscrow(connection, proposal),
        pledgeClient.readPledgeBook(connection, proposal)
    ]);
    return {
        state: 'available',
        donations: donations ? {
            escrow: pledgeClient.getDonationEscrowPda(proposal)[0].toBase58(),
            totalUsdc: pledgeClient.formatUsdc(donations.totalDonated),
            releasedUsdc: pledgeClient.formatUsdc(donations.totalReleased),
            refundedUsdc: pledgeClient.formatUsdc(donations.totalRefunded),
            donationCount: donations.donationCount.toString(),
            donorCount: donations.donorCount.toString(),
            released: donations.released
        } : null,
        pledges: pledges ? {
            book: pledgeClient.getPledgeBookPda(proposal)[0].toBase58(),
            activeUsdc: pledgeClient.formatUsdc(pledges.activePledged),
            fulfilledUsdc: pledgeClient.formatUsdc(pledges.totalFulfilled),
            revokedUsdc: pledgeClient.formatUsdc(pledges.totalRevoked),
            pledgeCount: pledges.pledgeCount.toString(),
            activeCount: pledges.activeCount.toString(),
            fulfilledCount: pledges.fulfilledCount.toString()
        } : null
    };
}

async function readMarket(connection, proposalAccount) {
    const proposal = new web3.PublicKey(proposalAccount);
    const [account] = marketClient.getMarketPda(proposal);
    const market = await marketClient.readMarket(connection, proposal);
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
    proposalReader = loadProposal,
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
    app.get('/hackathon/cases/:id', async (req, res) => {
        try {
            const requestedId = String(req.params.id || '').trim();
            if (!requestedId) return res.status(400).json({ error: 'case id is required' });
            const proposal = await proposalReader(pool, requestedId);
            if (!proposal) return res.status(404).json({ error: 'Hackathon case proposal not found' });
            const proposalAccount = proposal.onchain?.proposalId || null;
            const [activityResult, oracleResult, supportResult, marketResult] = await Promise.allSettled([
                activityReader(pool, proposal.proposalId),
                oracleReader(pool, proposalAccount),
                proposalAccount ? supportReader(getConnection(), proposalAccount) : Promise.resolve(null),
                proposalAccount ? marketReader(getConnection(), proposalAccount) : Promise.resolve(null)
            ]);
            const activity = activityResult.status === 'fulfilled' ? activityResult.value : [];
            const oracleEvents = oracleResult.status === 'fulfilled' ? oracleResult.value : null;
            const support = supportResult.status === 'fulfilled' ? supportResult.value : unavailable(supportResult.reason);
            const market = marketResult.status === 'fulfilled' ? marketResult.value : unavailable(marketResult.reason);
            const api = baseUrl(req, env);
            const site = siteUrl(env);
            return res.json(buildHackathonCase({
                proposal, activity, support, market, oracleEvents,
                links: {
                    self: `${api}/hackathon/cases/${encodeURIComponent(proposal.proposalId)}`,
                    proposal: `${api}/proposals/${encodeURIComponent(proposal.proposalId)}`,
                    map: `${site}/proposals/${encodeURIComponent(proposal.proposalId)}`,
                    activity: `${api}/agent/activity?limit=200`,
                    support: proposalAccount ? `${api}/agent/pledges/${encodeURIComponent(proposalAccount)}` : null,
                    recipe: proposalAccount ? `${api}/oracle/recipes/proposal-lifecycle-v1?proposal=${encodeURIComponent(proposalAccount)}` : null
                }
            }));
        } catch (error) {
            console.error('GET /hackathon/cases/:id failed', error);
            return res.status(500).json({ error: 'Failed to build hackathon case' });
        }
    });
}

export { loadActivity, loadOracleEvents, loadProposal, readMarket, readSupport };
