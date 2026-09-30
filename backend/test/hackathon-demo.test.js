import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const demo = require('../../frontend/js/hackathon-demo.js');

describe('hackathon demo evidence model', () => {
    const docs = {
        x402: {
            enabled: true, priceProposal: '$0.05', oracleFactsEnabled: true, priceOracleFact: '$0.01',
            network: 'solana:devnet', facilitatorUrl: 'https://facilitator'
        },
        endpoints: {
            submit: 'https://api.example/agent/proposals',
            oracleFact: 'https://api.example/agent/oracle/facts?subject={proposalAccount}',
            oracleFactDiscovery: 'https://api.example/agent/discovery?resource=oracle-facts'
        },
        market: { programId: 'market-program' }, proposalSupport: { programId: 'support-program' },
        mcp: {
            source: 'backend/agents/mcp-server.mjs',
            tools: ['ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast', 'ugt_buy_verified_fact']
        },
        oracle: {
            externalMarket: {
                status: 'live_devnet', proofMarket: 'external-market',
                proofResolution: 'resolution-transaction', proofClaim: 'claim-transaction',
                proof: {
                    recipeHash: 'aa'.repeat(32), yesStakeAtomic: '10000',
                    chronology: { classification: 'retrospective_integration', prospective: false }
                },
                prospectiveProof: {
                    status: 'market_open_awaiting_post_close_evidence',
                    market: 'prospective-market', closesAt: '2026-09-22T21:00:00.000Z'
                }
            }
        }
    };

    it('marks a recent completed deterministic proposer as fresh evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs,
            discovery: { state: 'listed', verifiedAt: '2026-09-21T11:59:00Z', listing: { resource: 'https://api.example/agent/proposals' } },
            runs: [{ id: 'r1', persona: 'densifier-01', role: 'proposer', controller: 'algorithm', status: 'done', stage: 'staked', updatedAt: '2026-09-21T02:05:00Z', modelCostUsd: 0 }],
            events: [{ recordedAt: '2026-09-21T02:05:00Z', action: { type: 'publish' }, entity: { type: 'proposal', id: 'p1' }, transaction: 'tx1' }]
        });
        expect(model.algorithm).toMatchObject({ tone: 'success', label: 'Fresh deterministic run completed' });
        expect(model.x402.tone).toBe('success');
        expect(model.evidence).toMatchObject({ latestProposalId: 'p1', latestTransaction: 'tx1' });
        expect(model.proofChecks).toContainEqual({ label: 'Proposal capability', status: 'success' });
    });

    it('does not call hosted-facilitator configuration a verified catalog listing', () => {
        const model = demo.buildDemoModel({ docs, discovery: { state: 'not-listed' } });
        expect(model.x402).toMatchObject({ tone: 'waiting', label: 'Hosted facilitator configured; listing unverified' });
        expect(model.oracleFacts).toMatchObject({ tone: 'waiting', label: 'Paid fact live; Bazaar indexing pending' });
    });

    it('tracks paid oracle-fact discovery separately from proposal discovery', () => {
        const model = demo.buildDemoModel({
            docs,
            discovery: { state: 'listed' },
            oracleDiscovery: {
                state: 'listed', verifiedAt: '2026-09-21T12:01:00Z',
                listing: { resource: 'https://api.example/agent/oracle/facts' }
            }
        });
        expect(model.oracleFacts).toMatchObject({
            tone: 'success',
            label: 'Paid verified facts listed in Bazaar',
            detail: expect.stringContaining('$0.01 per fact')
        });
    });

    it('surfaces the clean-room second-wallet x402 proof from the public manifest', () => {
        const model = demo.buildDemoModel({
            docs,
            oracleDiscovery: { state: 'listed', listing: { resource: 'https://api.example/agent/oracle/facts' } },
            proofManifest: { publicProof: { independentX402: {
                transaction: 'independent-payment', transactionUrl: 'https://explorer/independent-payment'
            } } }
        });
        expect(model.oracleFacts).toMatchObject({
            tone: 'success', label: 'Independent agent discovered, paid and verified a fact',
            independentProof: { transaction: 'independent-payment' }
        });
        expect(model.oracleFacts.detail).toContain('clean-room client');
    });

    it('reports the shared outside-agent tool surface from public metadata', () => {
        const model = demo.buildDemoModel({ docs });
        expect(model.agentTools).toMatchObject({
            tone: 'success', label: '5 MCP tools share one action layer',
            source: 'backend/agents/mcp-server.mjs'
        });
    });

    it('surfaces a terminal land event as source-backed oracle evidence', () => {
        const model = demo.buildDemoModel({ docs, oracleEvents: [{
            eventType: 'proposal_lifecycle', outcome: 'cancelled', observedAt: '2026-09-20T01:00:00Z',
            subject: { id: 'proposal-pda' }, source: { transactionUrl: 'https://explorer/tx' }
        }] });
        expect(model.oracle).toMatchObject({ tone: 'success', label: 'Cancelled proposal event attested' });
    });

    it('shows external public records separately from proposal-market resolution', () => {
        const model = demo.buildDemoModel({
            docs,
            publicRecords: {
                attestations: 62, decisions: 29, parcels: 60,
                v2: { status: 'live_devnet', attestations: 5 },
                schemaUrl: 'https://explorer.solana.com/address/schema?cluster=devnet'
            }
        });
        expect(model.publicRecords).toMatchObject({
            tone: 'success', label: '62 court attestations on Solana',
            detail: expect.stringContaining('5 source-timed V2')
        });
        expect(model.oracle).toMatchObject({ tone: 'waiting', event: null });
    });

    it('surfaces the live external market lifecycle from public agent metadata', () => {
        const model = demo.buildDemoModel({ docs });
        expect(model.externalMarket).toEqual({
            tone: 'success',
            label: 'Court evidence settled a two-sided integration proof',
            detail: expect.stringContaining('prospective V2 market open'),
            market: 'external-market',
            resolution: 'resolution-transaction',
            claim: 'claim-transaction',
            proof: {
                recipeHash: 'aa'.repeat(32), yesStakeAtomic: '10000',
                chronology: { classification: 'retrospective_integration', prospective: false }
            },
            prospective: false,
            chronology: { classification: 'retrospective_integration', prospective: false },
            evidence: null,
            nextProof: {
                status: 'market_open_awaiting_post_close_evidence',
                market: 'prospective-market', closesAt: '2026-09-22T21:00:00.000Z'
            }
        });
    });

    it('puts the redacted prospective resolver state into its own live model', () => {
        const model = demo.buildDemoModel({
            docs,
            prospectiveMarket: {
                state: 'awaiting_evidence', market: 'prospective-market', marketUrl: 'https://explorer/market',
                recipeHash: `sha256:${'b'.repeat(64)}`, closesAt: '2026-09-22T21:00:00.000Z',
                stakes: { yes: 0.01, no: 0.01, pool: 0.02 },
                resolver: { cadence: 'hourly at minute 45', lastRun: { endedAt: '2026-09-22T21:45:00Z' } }
            }
        });
        expect(model.prospectiveMarket).toMatchObject({
            tone: 'success', state: 'awaiting_evidence',
            label: 'Trading closed; waiting for matching later evidence', market: 'prospective-market'
        });
        expect(model.proofChecks).toContainEqual({ label: 'Two-sided market', status: 'success' });
    });

    it('promotes a settled prospective run to the main verified story automatically', () => {
        const settlement = {
            outcome: 'YES', evidence: { address: 'evidence-account', hash: `sha256:${'d'.repeat(64)}` },
            transactions: { evidenceFirstSeen: 'first-seen', resolution: 'resolution-v2', claim: 'claim-v2' },
            chronology: {
                classification: 'prospective', prospective: true,
                timestamps: {
                    marketCreatedAt: '2026-09-22T19:00:00Z', yesStakeAt: '2026-09-22T19:01:00Z',
                    noStakeAt: '2026-09-22T19:02:00Z', marketClosesAt: '2026-09-22T21:00:00Z',
                    sourceObservedAt: '2026-09-22T21:10:00Z', evidenceCreatedAt: '2026-09-22T21:20:00Z',
                    resolvedAt: '2026-09-22T21:30:00Z', claimedAt: '2026-09-22T21:31:00Z'
                }
            }
        };
        const model = demo.buildDemoModel({
            docs,
            prospectiveMarket: {
                state: 'settled', market: 'prospective-market', marketUrl: 'https://explorer/market',
                closesAt: '2026-09-22T21:00:00Z', stakes: { pool: 0.02 }, settlement
            }
        });
        expect(model.prospectiveMarket).toMatchObject({ state: 'settled', settlement });
        expect(model.externalMarket).toMatchObject({
            prospective: true, market: 'prospective-market', resolution: 'resolution-v2',
            claim: 'claim-v2', evidence: { address: 'evidence-account' }
        });
    });

    it('does not relabel an LLM run as algorithmic evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs,
            runs: [{ id: 'llm', persona: 'densifier-01', role: 'proposer', controller: 'llm', status: 'done', updatedAt: '2026-09-21T02:00:00Z' }]
        });
        expect(model.algorithm).toMatchObject({ tone: 'waiting', run: null });
        expect(model.latestLlm.id).toBe('llm');
    });

    it('reports supporter evidence independently of proposer evidence', () => {
        const model = demo.buildDemoModel({
            now: '2026-09-21T12:00:00Z', docs,
            runs: [{
                id: 'support', persona: 'supporter-01', role: 'supporter', controller: 'algorithm',
                status: 'done', updatedAt: '2026-09-21T02:15:00Z',
                support: { type: 'pledge', proposalId: 'p2', signature: 'support-tx' }
            }]
        });
        expect(model.algorithm.run).toBeNull();
        expect(model.supporter).toMatchObject({
            tone: 'success', detail: 'supporter-01 · pledge · proposal p2',
            transaction: 'support-tx', proposalId: 'p2'
        });
    });

    it('presents one aggregate case without treating partial branches as complete', () => {
        const model = demo.buildDemoModel({
            docs,
            canonicalCase: {
                id: 'golden-case', state: 'in_progress',
                proposal: { name: 'Three-parcel courtyard' },
                parcelSet: { parcelCount: 3 }, progress: { complete: 2, total: 7 },
                stages: [{ id: 'forecast', label: 'Forecast', state: 'partial', detail: 'YES only.' }],
                links: { map: 'https://site.example/proposals/golden-case', self: 'https://api.example/hackathon/cases/golden-case' }
            }
        });
        expect(model.canonicalCase).toMatchObject({
            tone: 'waiting', state: 'in_progress', label: 'Three-parcel courtyard',
            detail: '3 real cadastral parcels · 2/7 independently verified stages'
        });
    });
});

describe('hackathon demo executed case card', () => {
    const actor = id => ({ id });
    const executed = {
        id: 'executed-case', state: 'complete',
        proposal: { name: 'Two-parcel infill', lifecycleStatus: 'Executed' },
        parcelSet: { parcelCount: 2 }, progress: { complete: 7, total: 7 },
        branches: { forecast: { exists: true, resolved: true, outcome: 'YES' } },
        stages: [{ id: 'resolution', label: 'Permissionless resolution', state: 'complete', detail: 'Market resolved YES.' }],
        activity: [
            { actor: actor('densifier'), action: { type: 'create' }, transaction: 'tx-create' },
            { actor: actor('densifier'), action: { type: 'claim', side: 'yes' }, transaction: 'tx-claim' },
            { actor: actor('supporter'), action: { type: 'claim', side: 'no' }, transaction: 'tx-no-claim' },
            { actor: actor('supporter'), action: { type: 'certifyParcel', parcelId: 'P/1' }, transaction: 'tx-cert-1' },
            { actor: actor('supporter'), action: { type: 'accept', parcelId: 'P/1' }, transaction: 'tx-accept-1' },
            { actor: actor('supporter'), action: { type: 'accept', parcelId: 'P/2' } },
            { actor: actor('supporter'), action: { type: 'resolve' }, transaction: 'tx-resolve' },
            { actor: actor('supporter'), action: { type: 'releaseDonations' }, transaction: 'tx-release' },
            { actor: actor('supporter'), action: { type: 'fulfillPledge' }, transaction: 'tx-fulfil' }
        ]
    };

    it('lists only signed consent and settlement actions, in lifecycle order, as devnet Explorer links', () => {
        const txs = demo.caseTransactions(executed);
        expect(txs.map(tx => tx.signature)).toEqual(['tx-cert-1', 'tx-accept-1', 'tx-resolve', 'tx-release', 'tx-fulfil', 'tx-claim']);
        expect(txs[0]).toMatchObject({ label: 'Ownership certificate P/1', url: 'https://explorer.solana.com/tx/tx-cert-1?cluster=devnet' });
        expect(txs.at(-1).label).toBe('YES claim');
    });

    it('marks a complete executed case live with lifecycle, outcome and the self-certified owner caveat', () => {
        const model = demo.buildDemoModel({ docs: {}, executedCase: executed, proofManifest: { publicProof: { executedCase: 'https://api/x' } } });
        expect(model.executedCase).toMatchObject({
            tone: 'success', state: 'complete', label: 'Two-parcel infill', lifecycle: 'Executed', marketOutcome: 'YES',
            ownerCaveat: true, detail: '2 real cadastral parcels · 7/7 independently verified stages'
        });
    });

    it('keeps an incomplete executed case pending rather than successful', () => {
        const partial = { ...executed, state: 'in_progress', branches: { forecast: { exists: true, resolved: false } } };
        const model = demo.buildDemoModel({ docs: {}, executedCase: partial });
        expect(model.executedCase).toMatchObject({ tone: 'waiting', state: 'in_progress', marketOutcome: 'Unresolved' });
    });

    it('stays pending when the manifest declares no executed case, and errors when the fetch failed', () => {
        expect(demo.buildDemoModel({ docs: {}, proofManifest: { publicProof: {} } }).executedCase).toMatchObject({
            tone: 'waiting', state: 'pending', label: 'Executed case pending',
            detail: 'The proof manifest does not declare an executed case yet.', transactions: []
        });
        expect(demo.buildDemoModel({ docs: {}, errors: { executedCase: 'returned 500' } }).executedCase).toMatchObject({
            tone: 'error', state: 'unavailable', label: 'Executed case unavailable', detail: 'returned 500'
        });
    });

    it('does not fetch an executed case the manifest does not declare', async () => {
        const previous = globalThis.fetch;
        const requested = [];
        globalThis.fetch = async url => {
            requested.push(url);
            const body = url.endsWith('/hackathon/proof.json') ? { publicProof: { canonicalCase: 'https://api/cases/golden' } } : {};
            return { ok: true, json: async () => body };
        };
        try {
            const { values } = await demo.fetchEvidence('https://api');
            expect(requested).toContain('https://api/cases/golden');
            expect(requested.some(url => url.includes('executed'))).toBe(false);
            expect(values.executedCase).toBeUndefined();
        } finally { globalThis.fetch = previous; }
    });
});

describe('hackathon demo API base', () => {
    const withLocation = (location, fn) => {
        const previous = globalThis.location;
        globalThis.location = location;
        try { return fn(); } finally { globalThis.location = previous; }
    };

    it('follows dev.sh ?backend= on localhost, but never off localhost or to a foreign host', () => {
        expect(withLocation({ hostname: 'localhost', search: '?backend=http://localhost:4680' }, demo.backendBase)).toBe('http://localhost:4680');
        expect(withLocation({ hostname: 'localhost', search: '' }, demo.backendBase)).toBe('http://localhost:3000');
        expect(withLocation({ hostname: 'localhost', search: '?backend=https://evil.example' }, demo.backendBase)).toBe('http://localhost:3000');
        expect(withLocation({ hostname: 'urbangametheory.xyz', search: '?backend=http://localhost:4680' }, demo.backendBase)).toBe('https://api.urbangametheory.xyz');
    });
});
