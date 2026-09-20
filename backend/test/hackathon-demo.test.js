import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const demo = require('../../frontend/js/hackathon-demo.js');

describe('hackathon demo evidence model', () => {
    const docs = {
        x402: { enabled: true, priceProposal: '$0.05', network: 'solana:devnet', facilitatorUrl: 'https://facilitator' },
        endpoints: { submit: 'https://api.example/agent/proposals' },
        market: { programId: 'market-program' }, proposalSupport: { programId: 'support-program' }
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

    it('surfaces a terminal land event as source-backed oracle evidence', () => {
        const model = demo.buildDemoModel({ docs, oracleEvents: [{
            eventType: 'proposal_lifecycle', outcome: 'cancelled', observedAt: '2026-09-20T01:00:00Z',
            subject: { id: 'proposal-pda' }, source: { transactionUrl: 'https://explorer/tx' }
        }] });
        expect(model.oracle).toMatchObject({ tone: 'success', label: 'Cancelled proposal event attested' });
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
                support: { type: 'pledge', proposalId: 'p2' }
            }]
        });
        expect(model.algorithm.run).toBeNull();
        expect(model.supporter).toMatchObject({ tone: 'success', detail: 'supporter-01 · pledge · proposal p2' });
    });
});
