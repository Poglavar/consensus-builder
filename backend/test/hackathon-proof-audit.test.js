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
            { runId: 'supporter', transaction: supporterTx, recordedAt: '2026-09-21T11:00:00Z', action: { type: 'pledge' } },
            { runId: 'proposer-mint', transaction: 'mint-tx', recordedAt: '2026-09-20T10:00:00Z',
                actor: { wallet: 'proposer-wallet' }, action: { type: 'create', proposalId: 'p2' } }
        ] },
        '/proposals/p2': { proposalId: 'p2', lens: [{ address: 'notary-key', name: 'notary-01' }], onchain: {} },
        '/lenses/members': { members: [
            { key: 'notary-key', kind: 'notary', name: 'notary-01', coverage: { ownership: 3, parcels: 2, executed: 1 } },
            { key: 'cadastre-key', kind: 'cadastre', name: 'cadastre', coverage: { ownership: 1, parcels: 1, executed: 0 } },
            { key: 'idle-key', kind: 'court', name: 'idle', coverage: { ownership: 0, parcels: 0, executed: 0 } }
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
                canonicalCase: `${BASE}/hackathon/cases/golden-case`,
                executedCase: `${BASE}/hackathon/cases/executed-case`,
                attestedCase: `${BASE}/hackathon/cases/attested-case`
            }
        },
        '/hackathon/cases/golden-case': {
            id: 'golden-case', state: 'complete',
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
            stages: ['proposal', 'support', 'forecast', 'decision', 'evidence', 'resolution', 'settlement']
                .map(id => ({ id, state: 'complete' })),
            progress: { complete: 7, total: 7 }, transactions: [{}, {}, {}, {}, {}, {}]
        },
        '/hackathon/cases/executed-case': {
            id: 'executed-case', state: 'complete',
            proposal: { account: 'executed-account', lifecycleStatus: 'Executed' }, parcelSet: { parcelCount: 2 },
            branches: {
                support: { donations: { totalUsdc: '0.05' }, pledges: { fulfilledUsdc: '0.10', pledgeCount: '1' } },
                forecast: { yesUsdc: '0.01', noUsdc: '0.01', resolved: true, outcome: 'YES' }
            },
            activity: [
                { action: { type: 'create' }, transaction: 'create' },
                { action: { type: 'publish' }, transaction: 'publish' },
                { action: { type: 'donate' }, transaction: 'donate' },
                { action: { type: 'pledge' }, transaction: 'pledge' },
                { action: { type: 'stake', side: 'yes' }, transaction: 'yes' },
                { action: { type: 'stake', side: 'no' }, transaction: 'no' },
                { action: { type: 'certifyParcel', parcelId: 'a' }, transaction: 'cert-a' },
                { action: { type: 'certifyParcel', parcelId: 'b' }, transaction: 'cert-b' },
                { action: { type: 'accept', parcelId: 'a' }, transaction: 'accept-a' },
                { action: { type: 'accept', parcelId: 'b' }, transaction: 'accept-b' },
                { action: { type: 'resolve' }, transaction: 'resolve' },
                { action: { type: 'releaseDonations' }, transaction: 'release' },
                { action: { type: 'fulfillPledge' }, transaction: 'fulfil' },
                { action: { type: 'claim', side: 'yes' }, transaction: 'claim' }
            ],
            stages: ['proposal', 'support', 'forecast', 'decision', 'evidence', 'resolution', 'settlement']
                .map(id => ({ id, state: 'complete' })),
            progress: { complete: 7, total: 7 }
        },
        '/hackathon/cases/attested-case': {
            id: 'attested-case', state: 'complete',
            proposal: { account: 'attested-account', lifecycleStatus: 'Executed' }, parcelSet: { parcelCount: 2 },
            branches: { forecast: { yesUsdc: '0.01', noUsdc: '0.01', resolved: true, outcome: 'YES' } },
            activity: [
                { action: { type: 'create' }, transaction: 'create' },
                // Parcel a is co-owned (ownerCount 2), parcel b has one owner: three signatures in all.
                { action: { type: 'attestOwnership', parcelId: 'a', owner: 'w1', ownerCount: 2 }, transaction: 'att-a1' },
                { action: { type: 'attestOwnership', parcelId: 'a', owner: 'w2', ownerCount: 2 }, transaction: 'att-a2' },
                { action: { type: 'attestOwnership', parcelId: 'b', owner: 'w3', ownerCount: 1 }, transaction: 'att-b' },
                { action: { type: 'acceptance', parcelId: 'a', owner: 'w1' }, transaction: 'acc-a1' },
                { action: { type: 'acceptance', parcelId: 'a', owner: 'w2' }, transaction: 'acc-a2' },
                { action: { type: 'acceptance', parcelId: 'b', owner: 'w3' }, transaction: 'acc-b' },
                { action: { type: 'resolve' }, transaction: 'resolve' },
                { action: { type: 'claim', side: 'yes' }, transaction: 'claim' }
            ],
            stages: ['proposal', 'support', 'forecast', 'decision', 'evidence', 'resolution', 'settlement']
                .map(id => ({ id, state: 'complete' }))
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
        expect(result.summary).toEqual({ pass: 20, warn: 1, fail: 0 });
        expect(fetchImpl).toHaveBeenCalledTimes(15);
        expect(result.checks.find(item => item.id === 'attested_execution')).toMatchObject({
            status: 'pass', evidence: { acceptances: 3, requiredAcceptances: 3, requiredFrom: 'ownerCount', parcelsAttested: 2 }
        });
        expect(result.checks.find(item => item.id === 'no_self_lens')).toMatchObject({
            status: 'pass', evidence: { creates: 1, decided: 1, selfLens: [] }
        });
        expect(result.checks.find(item => item.id === 'attester_diversity').evidence.attesters.map(a => a.key))
            .toEqual(['notary-key', 'cadastre-key']);
        expect(result.checks.find(item => item.id === 'executed_case_yes')).toMatchObject({
            status: 'pass', evidence: { id: 'executed-case', outcome: 'YES', acceptances: 2, parcelCount: 2 }
        });
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

    it('fails the proof when a deployed release, terminal case or scheduled job regresses', async () => {
        const staleJobs = fixtures()['/hackathon/operations.json'].jobs.map((job, index) => index === 2
            ? { ...job, freshness: { state: 'stale' } } : job);
        const openCase = { ...fixtures()['/hackathon/cases/golden-case'], stages: [{ id: 'decision', state: 'pending' }] };
        const cases = [
            ['scheduled_operations_freshness', { '/hackathon/operations.json': { status: 'degraded', jobs: staleJobs } }],
            ['canonical_case_terminal', { '/hackathon/cases/golden-case': openCase }],
            ['release_artifact_identity', { '/hackathon/proof.json': { ...fixtures()['/hackathon/proof.json'], releaseArtifacts: null } }]
        ];
        for (const [id, override] of cases) {
            const result = await auditHackathonProof({
                baseUrl: BASE, fetchImpl: fetchFor(fixtures(override)), now: Date.parse('2026-09-21T12:00:00Z')
            });
            expect(result.status, id).toBe('incomplete');
            expect(result.checks.find(item => item.id === id).status, id).toBe('fail');
        }
    });

    it('requires the executed case to prove acceptance of every parcel, YES resolution and payout', async () => {
        const executed = fixtures()['/hackathon/cases/executed-case'];
        const cases = [
            ['resolved NO', { ...executed, branches: { ...executed.branches, forecast: { ...executed.branches.forecast, outcome: 'NO' } } }],
            ['one parcel never accepted', { ...executed, activity: executed.activity.filter(event => event.transaction !== 'accept-b') }],
            ['lifecycle still active', { ...executed, proposal: { ...executed.proposal, lifecycleStatus: 'Active' } }],
            ['YES never claimed', { ...executed, activity: executed.activity.filter(event => event.action.type !== 'claim') }],
            ['evidence pending', { ...executed, stages: executed.stages.map(item => item.id === 'evidence' ? { ...item, state: 'pending' } : item) }]
        ];
        for (const [label, override] of cases) {
            const result = await auditHackathonProof({
                baseUrl: BASE, fetchImpl: fetchFor(fixtures({ '/hackathon/cases/executed-case': override })),
                now: Date.parse('2026-09-21T12:00:00Z')
            });
            expect(result.status, label).toBe('incomplete');
            expect(result.checks.find(item => item.id === 'executed_case_yes').status, label).toBe('fail');
        }
        const undeclared = fixtures();
        delete undeclared['/hackathon/proof.json'].publicProof.executedCase;
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(undeclared), now: Date.parse('2026-09-21T12:00:00Z') });
        expect(result.checks.find(item => item.id === 'executed_case_yes')).toMatchObject({
            status: 'fail', evidence: 'proof manifest does not declare publicProof.executedCase'
        });
    });

    it('ignores a newer supporter no-op and requires the last signed support to be recent', async () => {
        const runs = fixtures()['/agent/runs?limit=50'].runs;
        const noop = {
            id: 'supporter-noop', controller: 'algorithm', role: 'supporter', status: 'done', updatedAt: '2026-09-21T11:30:00Z',
            support: { type: 'pledge', proposalId: 'p1', replayed: true, signature: null }
        };
        const withNoop = await auditHackathonProof({
            baseUrl: BASE, fetchImpl: fetchFor(fixtures({ '/agent/runs?limit=50': { runs: [...runs, noop] } })),
            now: Date.parse('2026-09-21T12:00:00Z')
        });
        expect(withNoop.checks.find(item => item.id === 'deterministic_supporter')).toMatchObject({
            status: 'pass', evidence: { runId: 'supporter', transaction: 'supporter-transaction' }
        });
        const stale = await auditHackathonProof({
            baseUrl: BASE, fetchImpl: fetchFor(fixtures()), now: Date.parse('2026-09-24T12:00:00Z')
        });
        expect(stale.checks.find(item => item.id === 'deterministic_supporter').status).toBe('fail');
    });

    it('reports chronology metadata as advisory while preserving the proven lifecycle', async () => {
        const data = fixtures();
        delete data['/docs/agents.json'].oracle.externalMarket.proof.chronology;
        const result = await auditHackathonProof({
            baseUrl: BASE, fetchImpl: fetchFor(data), now: Date.parse('2026-09-21T12:00:00Z')
        });
        expect(result.status).toBe('verified');
        expect(result.summary).toEqual({ pass: 19, warn: 2, fail: 0 });
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

    const NOW = Date.parse('2026-09-21T12:00:00Z');
    const lensCheck = async (overrides, id) => {
        const fetchImpl = fetchFor(fixtures(overrides));
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl, now: NOW });
        return { result, fetchImpl, item: result.checks.find(entry => entry.id === id) };
    };

    it('requires the attested case to carry an attestation per parcel and a signature per attested owner (advisory)', async () => {
        const attested = fixtures()['/hackathon/cases/attested-case'];
        const without = predicate => ({ ...attested, activity: attested.activity.filter(event => !predicate(event)) });
        const cases = [
            ['one co-owner never signed', without(event => event.transaction === 'acc-a2')],
            ['parcel b never attested', without(event => event.transaction === 'att-b')],
            ['lifecycle still active', { ...attested, proposal: { ...attested.proposal, lifecycleStatus: 'Active' } }],
            ['never resolved', without(event => event.action.type === 'resolve')],
            ['YES never claimed', without(event => event.action.type === 'claim')],
            ['executed through the v1 certificate path', { ...attested, activity: [...attested.activity,
                { action: { type: 'accept', parcelId: 'a' }, transaction: 'v1-accept' }] }],
            ['settlement pending', { ...attested, stages: attested.stages.map(item => item.id === 'settlement' ? { ...item, state: 'pending' } : item) }]
        ];
        for (const [label, override] of cases) {
            const { result, item } = await lensCheck({ '/hackathon/cases/attested-case': override }, 'attested_execution');
            expect(item.status, label).toBe('warn');
            expect(result.status, label).toBe('verified');
        }
        const undeclared = fixtures();
        delete undeclared['/hackathon/proof.json'].publicProof.attestedCase;
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(undeclared), now: NOW });
        expect(result.checks.find(item => item.id === 'attested_execution')).toMatchObject({
            status: 'warn', evidence: 'proof manifest does not declare publicProof.attestedCase'
        });
    });

    it('falls back to one acceptance per parcel when owner counts are not exposed', async () => {
        const attested = fixtures()['/hackathon/cases/attested-case'];
        const bare = { ...attested, activity: attested.activity
            .filter(event => !['att-a2', 'acc-a2'].includes(event.transaction))
            .map(event => ({ ...event, action: { type: event.action.type, side: event.action.side, parcelId: event.action.parcelId } })) };
        const { item } = await lensCheck({ '/hackathon/cases/attested-case': bare }, 'attested_execution');
        expect(item).toMatchObject({ status: 'pass', evidence: { requiredFrom: 'parcelCount', requiredAcceptances: 2, acceptances: 2 } });
    });

    it('flags an agent proposal whose lens is only its creator, from the record or the event', async () => {
        const events = fixtures()['/agent/activity?limit=200'].events;
        const fromRecord = await lensCheck({ '/proposals/p2': { proposalId: 'p2', lens: ['proposer-wallet'] } }, 'no_self_lens');
        expect(fromRecord.item).toMatchObject({ status: 'warn', evidence: { selfLens: [{ proposalId: 'p2', creator: 'proposer-wallet' }] } });
        expect(fromRecord.result.status).toBe('verified');

        const onChainCopy = await lensCheck({ '/proposals/p2': { proposalId: 'p2', lens: null, onchain: { lens: ['proposer-wallet'] } } }, 'no_self_lens');
        expect(onChainCopy.item.status).toBe('warn');
        expect(onChainCopy.item.evidence.selfLens).toHaveLength(1);

        const carried = events.map(event => event.action.type === 'create'
            ? { ...event, action: { ...event.action, lens: ['proposer-wallet'] } } : event);
        const fromEvent = await lensCheck({ '/agent/activity?limit=200': { events: carried } }, 'no_self_lens');
        expect(fromEvent.item.status).toBe('warn');
        expect(fromEvent.fetchImpl.mock.calls.some(([url]) => url.includes('/proposals/'))).toBe(false);

        const mixed = await lensCheck({ '/proposals/p2': { proposalId: 'p2', lens: ['proposer-wallet', 'notary-key'] } }, 'no_self_lens');
        expect(mixed.item.status).toBe('pass');
    });

    it('reports insufficient data instead of passing when no lens is exposed or nothing was created', async () => {
        const missing = await lensCheck({ '/proposals/p2': { proposalId: 'p2', lens: null, onchain: {} } }, 'no_self_lens');
        expect(missing.item).toMatchObject({
            status: 'warn',
            evidence: { creates: 1, decided: 0, undecided: [{ proposalId: 'p2', missing: ['lens'] }] }
        });
        expect(missing.item.evidence.insufficientData).toMatch(/neither a lens nor a creator/);

        const events = fixtures()['/agent/activity?limit=200'].events.map(event => event.action.type === 'create'
            ? { ...event, recordedAt: '2026-08-01T10:00:00Z' } : event);
        const stale = await lensCheck({ '/agent/activity?limit=200': { events } }, 'no_self_lens');
        expect(stale.item.status).toBe('warn');
        expect(stale.item.evidence.insufficientData).toBe('no create events in the last 30 days');
    });

    it('requires ownership attestations from at least two distinct lens members', async () => {
        const members = fixtures()['/lenses/members'].members.map(member => member.key === 'cadastre-key'
            ? { ...member, coverage: { ...member.coverage, ownership: 0 } } : member);
        const one = await lensCheck({ '/lenses/members': { members } }, 'attester_diversity');
        expect(one.item.status).toBe('warn');
        expect(one.item.evidence.attesters).toHaveLength(1);
        expect(one.result.status).toBe('verified');

        const absent = fixtures();
        delete absent['/lenses/members'];
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(absent), now: NOW });
        expect(result.checks.find(item => item.id === 'attester_diversity')).toMatchObject({ status: 'warn' });
        expect(result.checks.find(item => item.id === 'attester_diversity').evidence).toMatch(/404/);
    });

    it('requires an exact normalized resource URL', () => {
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/agent/proposals/` } }, `${BASE}/agent/proposals`)).toBe(true);
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/other` } }, `${BASE}/agent/proposals`)).toBe(false);
    });
});
