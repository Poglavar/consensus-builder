// Public judge manifest and redacted live status for the Colosseum hackathon build. These routes
// intentionally contain no private state, credentials, parcel identifiers or privileged actions.

import fs from 'node:fs';
import { readProspectiveMarketStatus } from '../oracle/prospective-market-public.js';

const ADDRESSES = JSON.parse(fs.readFileSync(
    new URL('../../frontend/contracts/addresses.json', import.meta.url), 'utf8'
))['solana-devnet'];

function baseUrl(req, env) {
    return (env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

export function buildHackathonProofManifest({ apiBase, env = process.env } = {}) {
    const base = String(apiBase || '').replace(/\/$/, '');
    const repository = 'https://github.com/Poglavar/consensus-builder';
    return {
        version: 1,
        title: 'Hyperstition: Markets for Possible Cities',
        product: 'Urban Game Theory by Consensus Builder',
        thesis: 'Humans and agents propose, fund and forecast changes to real parcels, while public records resolve what actually happened.',
        social: {
            x: { handle: '@UrbanGameTheory', url: 'https://x.com/UrbanGameTheory' }
        },
        hackathon: {
            event: 'Colosseum World’s Fair 2026',
            branch: 'colosseum-worlds-fair',
            baselineCommit: '3ee1855',
            releaseCommit: env.RELEASE_SHA || env.GIT_COMMIT || null,
            repository: `${repository}/tree/colosseum-worlds-fair`,
            scopeDocument: `${repository}/blob/colosseum-worlds-fair/HACKATHON.md`
        },
        surfaces: {
            pitch: 'https://urbangametheory.xyz/deck.html',
            demo: 'https://urbangametheory.xyz/hackathon-demo.html',
            map: 'https://urbangametheory.xyz/',
            actors: 'https://urbangametheory.xyz/actor-explorer.html'
        },
        publicProof: {
            manifest: `${base}/hackathon/proof.json`,
            auditCommand: 'cd backend && npm run demo:judge',
            agentCapabilities: `${base}/docs/agents.json`,
            proposalDiscovery: `${base}/agent/discovery`,
            oracleFactDiscovery: `${base}/agent/discovery?resource=oracle-facts`,
            courtOracle: `${base}/oracle/public-records/summary`,
            prospectiveMarket: `${base}/oracle/markets/prospective/status`,
            activity: `${base}/agent/activity?limit=200`,
            runs: `${base}/agent/runs?limit=50`
        },
        hackathonPrograms: [
            { name: 'ProposalMarket', address: ADDRESSES.ProposalMarket, role: 'recipe-bound YES/NO markets and permissionless resolution' },
            { name: 'ProposalPledge', address: ADDRESSES.ProposalPledge, role: 'wallet donations and revocable pledges' }
        ],
        builtForHackathon: [
            'x402-paid proposal and verified-fact endpoints with hosted facilitator discovery',
            'one actor/action model for humans, deterministic agents and future LLM agents',
            'wallet donation, pledge and forecast flows over two new Solana programs',
            'source-hashed land-event recipes and a reusable Lens evaluator',
            'Croatian court records bridged into source-timestamped Solana attestations',
            'a scheduled two-sided prospective market that can settle only from later public evidence',
            'public judge surfaces, machine-readable proof and a read-only audit command'
        ],
        trustBoundary: {
            live: ['proposal account state', 'Croatian court SAS attestations', 'declared recipe hashes', 'permissionless Solana verification'],
            notClaimed: ['court evidence for all land changes', 'independent imagery corroboration', 'permit ingestion', 'LLM authority over outcomes'],
            network: 'Solana devnet; assets have no monetary value'
        }
    };
}

export function setupHackathonProofRoute(app, { env = process.env, statusReader = readProspectiveMarketStatus } = {}) {
    app.get('/hackathon/proof.json', (req, res) => {
        res.json(buildHackathonProofManifest({ apiBase: baseUrl(req, env), env }));
    });
    app.get('/oracle/markets/prospective/status', (_req, res) => {
        res.json(statusReader({ env }));
    });
}
