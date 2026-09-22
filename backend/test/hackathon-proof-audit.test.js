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
                },
                prospectiveProof: {
                    status: 'market_open_awaiting_post_close_evidence', market: 'prospective-market',
                    closesAt: '2026-09-22T21:00:00.000Z',
                    transactions: { create: 'pc', yesStake: 'py', noStake: 'pn' }
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
        '/hackathon/proof.json': {
            hackathon: { branch: 'colosseum-worlds-fair' },
            releaseArtifacts: {
                backend: { commit: 'release-sha' },
                frontend: { manifest: 'https://urbangametheory.xyz/release.json' },
                programs: ['pledge', 'market'].map((name, index) => ({
                    name, programDataAddress: `program-data-${index}`,
                    lastDeployedSlot: 500000000 + index, binarySha256: `${index + 1}`.repeat(64)
                }))
            },
            publicProof: {
                prospectiveMarket: `${BASE}/oracle/markets/prospective/status`,
                operations: `${BASE}/hackathon/operations.json`,
                canonicalCase: `${BASE}/hackathon/cases/golden-case`
            }
        },
        '/hackathon/cases/golden-case': {
            id: 'golden-case', state: 'in_progress',
            proposal: { account: 'proposal-account' }, parcelSet: { parcelCount: 3 },
            branches: {
                support: { donations: { totalUsdc: '0.05' }, pledges: { activeUsdc: '0.10', pledgeCount: '1' } },
                forecast: { yesUsdc: '0.01', noUsdc: '0.01' }
            },
            activity: [
                { action: { type: 'create' }, transaction: 'create' },
                { action: { type: 'publish' }, transaction: 'publish' },
                { action: { type: 'donate' }, transaction: 'donate' },
                { action: { type: 'pledge' }, transaction: 'pledge' },
                { action: { type: 'stake', side: 'yes' }, transaction: 'yes' },
                { action: { type: 'stake', side: 'no' }, transaction: 'no' }
            ],
            stages: [
                { id: 'decision', state: 'pending' }, { id: 'evidence', state: 'pending' },
                { id: 'resolution', state: 'pending' }, { id: 'settlement', state: 'blocked' }
            ],
            progress: { complete: 3, total: 7 }, transactions: [{}, {}, {}, {}, {}, {}]
        },
        '/oracle/markets/prospective/status': {
            state: 'open', market: 'prospective-market', resolver: { lastRun: { endedAt: '2026-09-21T11:45:00Z' } }
        },
        '/hackathon/operations.json': {
            status: 'healthy', jobs: ['proposer', 'supporter', 'land-oracle', 'prospective-resolver'].map(role => ({
                role, status: 'completed', freshness: { state: 'fresh' }
            }))
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
        expect(result.summary).toEqual({ pass: 15, warn: 2, fail: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(11);
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
        expect(result.summary).toEqual({ pass: 14, warn: 3, fail: 0 });
    });

    it('requires a payout and strictly ordered public proof once the prospective market settles', async () => {
        const settlement = {
            outcome: 'YES',
            evidence: { address: 'evidence-account', hash: `sha256:${'b'.repeat(64)}` },
            transactions: { evidenceFirstSeen: 'first-seen-tx', resolution: 'resolve-tx', claim: 'claim-tx' },
            chronology: {
                classification: 'prospective', prospective: true, marketOrderValid: true,
                sourceTimeVerified: true, sourceAfterClose: true,
                timestamps: {
                    marketCreatedAt: '2026-09-22T19:00:00Z', yesStakeAt: '2026-09-22T19:01:00Z',
                    noStakeAt: '2026-09-22T19:02:00Z', marketClosesAt: '2026-09-22T21:00:00Z',
                    sourceObservedAt: '2026-09-22T21:10:00Z', evidenceCreatedAt: '2026-09-22T21:20:00Z',
                    resolvedAt: '2026-09-22T21:30:00Z', claimedAt: '2026-09-22T21:31:00Z'
                },
                transactionSlots: { evidenceFirstSeen: 100, resolution: 110, claim: 111 }
            }
        };
        const complete = fixtures({
            '/oracle/markets/prospective/status': {
                state: 'settled', market: 'prospective-market', closesAt: '2026-09-22T21:00:00Z',
                transactions: { create: 'create-tx', yesStake: 'yes-tx', noStake: 'no-tx' }, settlement
            }
        });
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(complete), now: Date.parse('2026-09-22T22:00:00Z') });
        expect(result.status).toBe('verified');
        expect(result.checks.find(item => item.id === 'prospective_settlement_proof')).toMatchObject({ status: 'pass' });

        const missingPayout = structuredClone(complete);
        missingPayout['/oracle/markets/prospective/status'].settlement.transactions.claim = null;
        const incomplete = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(missingPayout), now: Date.parse('2026-09-22T22:00:00Z') });
        expect(incomplete.status).toBe('incomplete');
        expect(incomplete.checks.find(item => item.id === 'prospective_settlement_proof')).toMatchObject({ status: 'fail' });

        const sameSecond = structuredClone(complete);
        sameSecond['/oracle/markets/prospective/status'].settlement.chronology.timestamps.claimedAt = '2026-09-22T21:30:00Z';
        const slotOrdered = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(sameSecond), now: Date.parse('2026-09-22T22:00:00Z') });
        expect(slotOrdered.checks.find(item => item.id === 'prospective_settlement_proof')).toMatchObject({ status: 'pass' });
    });

    it('requires an exact normalized resource URL', () => {
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/agent/proposals/` } }, `${BASE}/agent/proposals`)).toBe(true);
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/other` } }, `${BASE}/agent/proposals`)).toBe(false);
    });
});
