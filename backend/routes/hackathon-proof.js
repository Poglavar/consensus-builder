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
    const canonicalCaseId = env.HACKATHON_CASE_ID || 'hackathon-golden-borovje-2026';
    // The executed case is the YES counterpart of the cancelled golden case; the public audit requires it.
    const executedCaseId = env.HACKATHON_EXECUTED_CASE_ID || 'hackathon-executed-borovje-2026';
    // Canonical case v3: executed through lens-member attestations and owner signatures (lens model v2).
    const attestedCaseId = env.HACKATHON_ATTESTED_CASE_ID || 'hackathon-attested-borovje-2026';
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
        releaseArtifacts: {
            backend: {
                component: 'consensus-builder-api',
                commit: env.RELEASE_SHA || env.GIT_COMMIT || null
            },
            frontend: {
                component: 'urbangametheory-frontend',
                manifest: 'https://urbangametheory.xyz/release.json'
            },
            programs: [{
                name: 'ProposalPledge',
                network: 'solana:devnet',
                address: ADDRESSES.ProposalPledge,
                programDataAddress: 'EtV7ufG6U5SSPsdhQe1TByPJR8mqPpFgV15KQNbNSyZQ',
                lastDeployedSlot: 503098918,
                binarySha256: '649c6fda6c9cc2bd5e224772ca562dfb6576a2f46ca46498ad271f5bf39d053c',
                // On-chain Anchor IDL account; its decoded JSON equals blockchain/solana/idl/proposal_pledge.json.
                idlAddress: '4PJBp5KWgY1S55dCLAHqzD2jSmFwZFWUTZBj9JYVZb7X',
                idlSha256: '5a76b112e55762a3dc7e555ea69caf880c7569e7c09b36deade36d72d0a891e9',
                upgradeAuthority: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ'
            }, {
                name: 'ProposalMarket',
                network: 'solana:devnet',
                address: ADDRESSES.ProposalMarket,
                programDataAddress: 'AGmZusPm3FuiPkgMBY5dG1ZMfXKptqDjG3aMrgTpqhx7',
                lastDeployedSlot: 506423834,
                binarySha256: '3b797f63e285bdd4df953e55b4a9217c65d0d7fe1c1aeaf34ce3ceaa37fee62c',
                // On-chain Anchor IDL account; its decoded JSON equals blockchain/solana/idl/proposal_market.json.
                idlAddress: '66R6QbYprREJcxd2saTTEWmMUPpyx6ixx2KtBCDYGMJZ',
                idlSha256: '952bc83dab15ecf55135be9eea87fda258ed440ca3a0aae873ce9739903145a5',
                upgradeAuthority: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ'
            }, {
                // Programs pinned from the 2026-10-01 devnet upgrade (`solana program show`, then
                // `solana program dump` + SHA-256; the two above re-read unchanged that day).
                name: 'ProposalNFT',
                network: 'solana:devnet',
                address: ADDRESSES.ProposalNFT,
                programDataAddress: 'GS6Tjof9kJCSUPLGJU2qDQH7VA1rTmJi6TdF1Fnn9RMP',
                lastDeployedSlot: 506424114,
                binarySha256: '14b0a11546bca4d0df55a0f903513eaed3e1e6578a0505f0e00960cc2033623d',
                // On-chain Anchor IDL account matches the checked-in v3 interface.
                idlAddress: 'EXYuUatUDNoa2TMXYGmnEWWJMxrhDxbetT3AR33Xw3zq',
                idlSha256: '6e2688cd8a07be8f91ac38cb99bd6390b1a27cc04735be15a7d2d8666bf14a2e',
                upgradeAuthority: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
                note: 'Deployed v3: site-first proposals, attested owner consent, open-ground verdict clearance and recorded payouts.'
            }, {
                name: 'ParcelNFT',
                network: 'solana:devnet',
                address: ADDRESSES.ParcelNFT,
                programDataAddress: '6FghjCzxbcwxeAFfDTQcUzk8RzJCQXS6d5fZMLxfJbTn',
                lastDeployedSlot: 506424160,
                binarySha256: '80e3bd056f96eeafc381aa1a13624cc08a27684f4b40516143bb622f197d1719',
                // On-chain Anchor IDL account; its decoded JSON equals blockchain/solana/idl/parcel_nft.json.
                idlAddress: 'EjG4tuNWepkUJZmpFkLT4jdPn7S6n4NZkqduF2RJRRSL',
                idlSha256: 'd648c176ad3469f4d9ed5af9c51c806d953331b13cc1313315fec763cc97c1c6',
                upgradeAuthority: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ'
            }],
            verifiedAt: '2026-10-01'
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
            canonicalCase: `${base}/hackathon/cases/${encodeURIComponent(canonicalCaseId)}`,
            executedCase: `${base}/hackathon/cases/${encodeURIComponent(executedCaseId)}`,
            attestedCase: `${base}/hackathon/cases/${encodeURIComponent(attestedCaseId)}`,
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
