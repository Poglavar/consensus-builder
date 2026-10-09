// GET /markets?city=<id>: every contest (proposals on the same land) in a city with the on-chain
// prediction market beside each minted proposal — what the Bets sheet lists and what an agent
// reads before staking. Proposals come from the database, market accounts from one batched RPC
// read; the payload is cached briefly per city because every sheet open would otherwise be an RPC.

import { createRequire } from 'node:module';
import { Connection } from '@solana/web3.js';
import { buildContests, proposalAccountOf } from '../markets/contests.js';
import { decodeProposalState } from '../agents/lifecycle-actions.js';
import { EFFECTIVE_STATUS_SQL, normalizeCityCode } from './proposals.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The same codec the browser and the agent bettor use (frontend/js/solana/market-client.js).
const marketClient = require('../../frontend/js/solana/market-client.js');
marketClient.configure({ web3 });

export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PROPOSAL_STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
const CACHE_TTL_MS = 20_000;
const ACCOUNTS_PER_RPC = 100;
const MAX_PROPOSALS = 2000;

// The columns rowToProposal reads; the bet link route (bets-share.js) selects one row by account.
export const PROPOSAL_COLUMNS_SQL = `
        id, proposal_id, city,
        COALESCE(title, name, proposal_data->>'title', proposal_data->>'name') AS title,
        COALESCE(proposal_data->>'goal', type) AS goal,
        ${EFFECTIVE_STATUS_SQL} AS lifecycle_status,
        created_at, expires_at, cadastre_parcel_ids, onchain_data,
        COALESCE(author, proposal_data->>'author') AS author,
        (agent_payment_id IS NOT NULL) AS agent,
        proposal_data->>'proposalRole' AS proposal_role,
        COALESCE(screenshot_url, onchain_data->>'imageUrl') AS screenshot_url,
        COALESCE(building_proposal->>'blockName', structure_proposal->>'blockName', proposal_data->'buildingProposal'->>'blockName') AS site_name`;

const PROPOSALS_SQL = `
    SELECT ${PROPOSAL_COLUMNS_SQL}
    FROM proposal
    WHERE city = $1 AND LOWER(COALESCE(lifecycle_status, '')) <> 'draft'
    ORDER BY created_at DESC
    LIMIT $2`;

export function rowToProposal(row) {
    return {
        id: row.id,
        city: row.city || null,
        proposalId: row.proposal_id,
        title: row.title,
        goal: row.goal,
        lifecycleStatus: row.lifecycle_status,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        author: row.author,
        agent: Boolean(row.agent),
        proposalRole: row.proposal_role,
        screenshotUrl: row.screenshot_url,
        parcelIds: Array.isArray(row.cadastre_parcel_ids) ? row.cadastre_parcel_ids : [],
        siteName: typeof row.site_name === 'string' && row.site_name.trim() ? row.site_name.trim() : null,
        proposalAccount: proposalAccountOf(row.onchain_data)
    };
}

// Market accounts for a list of proposal accounts, read in batches through SOLANA_RPC_URL.
// Returns Map(proposalAccount → { address, market|null }).
export function defaultMarketReader(env = process.env) {
    let connection = null;
    return async (proposalAccounts) => {
        connection ??= new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        const pdas = proposalAccounts.map(account => ({ account, pda: marketClient.getMarketPda(account)[0] }));
        const result = new Map();
        for (let offset = 0; offset < pdas.length; offset += ACCOUNTS_PER_RPC) {
            const slice = pdas.slice(offset, offset + ACCOUNTS_PER_RPC);
            const infos = await connection.getMultipleAccountsInfo(slice.map(entry => entry.pda), 'confirmed');
            slice.forEach((entry, index) => {
                const info = infos[index];
                result.set(entry.account, {
                    address: entry.pda.toBase58(),
                    market: info && info.data ? marketClient.decodeMarket(info.data) : null
                });
            });
        }
        return result;
    };
}

// On-chain status of each proposal account (the status the market program resolves from).
// Returns Map(proposalAccount → 'Active' | 'Executed' | 'Cancelled' | 'Expired'); unreadable
// accounts are left out, so the database word stands in for them.
export function defaultProposalStatusReader(env = process.env) {
    let connection = null;
    return async (proposalAccounts) => {
        connection ??= new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        const result = new Map();
        for (let offset = 0; offset < proposalAccounts.length; offset += ACCOUNTS_PER_RPC) {
            const slice = proposalAccounts.slice(offset, offset + ACCOUNTS_PER_RPC);
            const infos = await connection.getMultipleAccountsInfo(slice.map(account => new web3.PublicKey(account)), 'confirmed');
            slice.forEach((account, index) => {
                const info = infos[index];
                if (!info || !info.data) return;
                try {
                    const name = PROPOSAL_STATUS_NAMES[decodeProposalState(info.data).status];
                    if (name) result.set(account, name);
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] GET /markets: proposal ${account} did not decode: ${error.message}`);
                }
            });
        }
        return result;
    };
}

export function setupMarketsRoute(app, pool, options = {}) {
    const env = options.env || process.env;
    const readMarkets = options.readMarkets || defaultMarketReader(env);
    const readProposalStatuses = options.readProposalStatuses || defaultProposalStatusReader(env);
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
            const { rows } = await pool.query(PROPOSALS_SQL, [city, MAX_PROPOSALS]);
            const proposals = rows.map(rowToProposal);
            const accounts = Array.from(new Set(proposals.map(proposal => proposal.proposalAccount).filter(Boolean)));
            const [markets, statuses] = accounts.length
                ? await Promise.all([readMarkets(accounts), readProposalStatuses(accounts)])
                : [new Map(), new Map()];
            const payload = {
                ...buildContests({ city, proposals, markets, statuses, now: now() }),
                cluster: 'devnet',
                marketProgram: marketClient.constants.PROGRAM_ID,
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
}
