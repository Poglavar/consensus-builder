import { describe, expect, it, vi } from 'vitest';
import { auditHackathonProof, exactResource } from '../agents/hackathon-proof-audit.js';

const BASE = 'https://api.example.test';

function fixtures(overrides = {}) {
    const proposerTx = 'proposer-transaction';
    const supporterTx = 'supporter-transaction';
    return {
        '/docs/agents.json': {
            oracle: { externalMarket: {
                status: 'live_devnet', proofMarket: 'market', proofResolution: 'resolution', proofClaim: 'claim',
                proof: {
                    create: 'create', yesStake: 'yes', noStake: 'no',
                    chronology: { classification: 'retrospective_integration' }
                }
            } }
        },
        '/agent/discovery': { state: 'listed', listing: { resource: `${BASE}/agent/proposals` } },
        '/agent/discovery?resource=oracle-facts': { state: 'listed', listing: { resource: `${BASE}/agent/oracle/facts` } },
        '/agent/runs?limit=50': { runs: [
            { id: 'proposer', controller: 'algorithm', role: 'proposer', status: 'done', updatedAt: '2026-09-21T10:00:00Z' },
            { id: 'supporter', controller: 'algorithm', role: 'supporter', status: 'done', updatedAt: '2026-09-21T11:00:00Z', support: { type: 'pledge', proposalId: 'p1', signature: supporterTx } }
        ] },
        '/agent/activity?limit=200': { events: [
            { runId: 'proposer', transaction: proposerTx, recordedAt: '2026-09-21T10:00:00Z', action: { type: 'stake' } },
            { runId: 'supporter', transaction: supporterTx, recordedAt: '2026-09-21T11:00:00Z', action: { type: 'pledge' } }
        ] },
        '/oracle/events?limit=25': { events: [{
            id: 'event-1', eventType: 'proposal_lifecycle', outcome: 'cancelled', recordedAt: '2026-09-21T11:30:00Z',
            source: { hash: `sha256:${'a'.repeat(64)}`, transaction: 'oracle-transaction' }
        }] },
        '/oracle/public-records/summary': {
            attestations: 62, decisions: 29, schemaId: 'schema',
            v2: { status: 'live_devnet', attestations: 5 }
        },
        ...overrides
    };
}

function fetchFor(data) {
    return vi.fn(async url => {
        const parsed = new URL(url);
        const key = `${parsed.pathname}${parsed.search}`;
        if (!(key in data)) return new Response(JSON.stringify({ error: 'missing fixture' }), { status: 404 });
        return new Response(JSON.stringify(data[key]), { status: 200 });
    });
}

describe('public hackathon proof audit', () => {
    it('verifies the complete public proof without private state', async () => {
        const fetchImpl = fetchFor(fixtures());
        const result = await auditHackathonProof({
            baseUrl: BASE, fetchImpl, now: Date.parse('2026-09-21T12:00:00Z')
        });
        expect(result.status).toBe('verified');
        expect(result.summary).toEqual({ pass: 8, warn: 0, fail: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(7);
        expect(result.checks.find(item => item.id === 'deterministic_supporter')).toMatchObject({
            status: 'pass', evidence: { proposalId: 'p1', transaction: 'supporter-transaction' }
        });
    });

    it('does not accept the proposal listing as proof of oracle-fact discovery', async () => {
        const data = fixtures({
            '/agent/discovery?resource=oracle-facts': { state: 'listed', listing: { resource: `${BASE}/agent/proposals` } }
        });
        const result = await auditHackathonProof({
            baseUrl: BASE, fetchImpl: fetchFor(data), now: Date.parse('2026-09-21T12:00:00Z')
        });
        expect(result.status).toBe('incomplete');
        expect(result.checks.find(item => item.id === 'oracle_fact_bazaar').status).toBe('fail');
    });

    it('reports chronology metadata as advisory while preserving the proven lifecycle', async () => {
        const data = fixtures();
        delete data['/docs/agents.json'].oracle.externalMarket.proof.chronology;
        const result = await auditHackathonProof({
            baseUrl: BASE, fetchImpl: fetchFor(data), now: Date.parse('2026-09-21T12:00:00Z')
        });
        expect(result.status).toBe('verified');
        expect(result.summary).toEqual({ pass: 7, warn: 1, fail: 0 });
    });

    it('requires an exact normalized resource URL', () => {
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/agent/proposals/` } }, `${BASE}/agent/proposals`)).toBe(true);
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/other` } }, `${BASE}/agent/proposals`)).toBe(false);
    });
});
