// Public judge manifest and redacted live status for the Colosseum hackathon build. These routes
// intentionally contain no private state, credentials, parcel identifiers or privileged actions.

import fs from 'node:fs';
import { isCid } from '../cid.js';
import { createProgramEvidenceReader } from '../hackathon/program-evidence.js';
import { readProspectiveMarketStatus } from '../oracle/prospective-market-public.js';

const ADDRESSES = JSON.parse(fs.readFileSync(
    new URL('../../frontend/contracts/addresses.json', import.meta.url), 'utf8'
))['solana-devnet'];

const CASES = JSON.parse(fs.readFileSync(new URL('../hackathon/proof-cases.json', import.meta.url), 'utf8'));

function baseUrl(req, env) {
    return (env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Each headline case names a current agreement CID; invalid configuration remains explicitly missing.
function caseLink(base, cid) {
    return isCid(cid) ? `${base}/hackathon/cases/${cid}` : null;
}

export function buildHackathonProofManifest({ apiBase, env = process.env, deploymentEvidence = null } = {}) {
    const base = String(apiBase || '').replace(/\/$/, '');
    const repository = 'https://github.com/Poglavar/consensus-builder';
    const canonicalCase = caseLink(base, env.HACKATHON_CASE_ID ?? CASES.canonicalCase);
    const executedCase = caseLink(base, env.HACKATHON_EXECUTED_CASE_ID ?? CASES.executedCase);
    return {
        version: 2,
        title: 'Hyperstition: Markets for Possible Cities',
        product: 'Urban Game Theory by Consensus Builder',
        thesis: 'People and agents propose agreements over real parcels, fund them and forecast their execution. These markets settle from the agreement’s recorded chain status.',
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
        releaseArtifacts: {
            backend: {
                component: 'consensus-builder-api',
                commit: env.RELEASE_SHA || env.GIT_COMMIT || null
            },
            frontend: {
                component: 'urbangametheory-frontend',
                manifest: 'https://urbangametheory.xyz/release.json'
            },
            programs: deploymentEvidence?.programs || [],
            verifiedAt: deploymentEvidence?.verifiedAt || null,
            verification: {
                state: deploymentEvidence?.state || 'unavailable',
                method: deploymentEvidence?.method || null,
                error: deploymentEvidence?.error || null
            }
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
            oracleFactDiscovery: `${base}/agent/discovery?resource=oracle-facts`,
            independentX402: {
                kind: 'clean_room_verified_fact_purchase',
                payer: 'FoPmPhKE6bykLoumQSvygZCSJYLkxBfsqjE3ybMvSjYs',
                amountAtomic: '10000',
                transaction: '3T7mg2f5FRk6uFND6eyRKrS5VyHviizk4vmPqB1zxVJbmnz4f1nxaMjXxGi4XEh8JMMesPXNbaaCNzgFQxRxTGPn',
                transactionUrl: 'https://explorer.solana.com/tx/3T7mg2f5FRk6uFND6eyRKrS5VyHviizk4vmPqB1zxVJbmnz4f1nxaMjXxGi4XEh8JMMesPXNbaaCNzgFQxRxTGPn?cluster=devnet',
                clientSource: `${repository}/blob/colosseum-worlds-fair/backend/examples/independent-x402-client.mjs`,
                verifiedEvent: 'solana:devnet:proposal_lifecycle:B3C1ZtyigkffSnNAeZMjnmHc3M7CxK7bYeeC4JD7oSGg:cancelled',
                sourceHash: 'sha256:93555c3d2eee8b8d2a1939af11597bd0c50a18aac047fa9b142a3202bdadddda'
            },
            courtOracle: `${base}/oracle/public-records/summary`,
            prospectiveMarket: `${base}/oracle/markets/prospective/status`,
            canonicalCase,
            executedCase,
            lensMembers: `${base}/lenses/members`,
            operations: `${base}/hackathon/operations.json`,
            activity: `${base}/agent/activity?limit=200`,
            runs: `${base}/agent/runs?limit=50`
        },
        hackathonPrograms: [
            { name: 'ProposalMarket', address: ADDRESSES.ProposalMarket, role: 'recipe-bound YES/NO markets and permissionless resolution' },
            { name: 'ProposalPledge', address: ADDRESSES.ProposalPledge, role: 'wallet donations and revocable pledges' }
        ],
        builtForHackathon: [
            'an x402-paid verified-fact endpoint with hosted facilitator discovery',
            'one actor/action model for humans, deterministic agents and future LLM agents',
            'wallet donation, pledge and forecast flows over two new Solana programs',
            'source-hashed land-event recipes and a reusable Lens evaluator',
            'Croatian court records bridged into source-timestamped Solana attestations',
            'a scheduled two-sided prospective market that can settle only from later public evidence',
            'public judge surfaces, machine-readable proof and a read-only audit command'
        ],
        trustBoundary: {
            live: ['agreement account state', 'Croatian court SAS attestations', 'declared recipe hashes', 'permissionless Solana verification'],
            notClaimed: ['court evidence for all land changes', 'independent imagery corroboration', 'permit ingestion', 'LLM authority over outcomes'],
            network: 'Solana devnet; assets have no monetary value'
        }
    };
}

export function setupHackathonProofRoute(app, {
    env = process.env, statusReader = readProspectiveMarketStatus,
    programReader = createProgramEvidenceReader({ env })
} = {}) {
    app.get('/hackathon/proof.json', async (req, res) => {
        let deploymentEvidence;
        try { deploymentEvidence = await programReader(); } catch {
            // Do not expose a provider URL or recycle an old timestamp after a failed observation.
            deploymentEvidence = { state: 'unavailable', error: 'Current devnet deployments could not be verified.' };
        }
        res.set('Cache-Control', 'no-store');
        res.json(buildHackathonProofManifest({ apiBase: baseUrl(req, env), env, deploymentEvidence }));
    });
    app.get('/oracle/markets/prospective/status', (_req, res) => {
        res.json(statusReader({ env }));
    });
}
