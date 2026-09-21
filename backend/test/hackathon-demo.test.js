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
    });

    it('does not call hosted-facilitator configuration a verified catalog listing', () => {
        const model = demo.buildDemoModel({ docs, discovery: { state: 'not-listed' } });
        expect(model.x402).toMatchObject({ tone: 'waiting', label: 'Hosted facilitator configured; listing unverified' });
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
            nextProof: {
                status: 'market_open_awaiting_post_close_evidence',
                market: 'prospective-market', closesAt: '2026-09-22T21:00:00.000Z'
            }
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
});
