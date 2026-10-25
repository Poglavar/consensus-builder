// The read-only public hackathon proof audit (agents/hackathon-proof-audit.js) over the HTTP contracts a
// judge sees, served here by a fetch double: oracle-fact discovery, scheduled runs and their on-chain
// actions, the agreement lifecycle oracle, the court and prospective markets, the release manifest, the
// declared agreement cases (GET /hackathon/cases/:cid) and attester diversity.
import { describe, expect, it, vi } from 'vitest';
import { auditHackathonProof, exactResource, validateProspectiveSettlement } from '../agents/hackathon-proof-audit.js';
import { cidOfObject } from '../cid.js';

const BASE = 'https://api.example.test';
const NOW = Date.parse('2026-09-21T12:00:00Z');
const CANONICAL = cidOfObject({ schema: 'agreement/v1', title: 'Canonical case' });
const EXECUTED = cidOfObject({ schema: 'agreement/v1', title: 'Executed case' });
const stagesAll = state => ['agreement', 'support', 'forecast', 'decision', 'evidence', 'resolution', 'settlement'].map(id => ({ id, state }));

function fixtures(overrides = {}) {
    const data = {
        '/docs/agents.json': {
            oracle: { externalMarket: {
                status: 'live_devnet', proofMarket: 'market', proofResolution: 'resolution', proofClaim: 'claim',
                proof: { create: 'create', yesStake: 'yes', noStake: 'no', chronology: { classification: 'retrospective_integration' } },
                prospectiveProof: {
                    status: 'market_open_awaiting_post_close_evidence', market: 'prospective-market',
                    closesAt: '2026-09-22T21:00:00.000Z', transactions: { create: 'pc', yesStake: 'py', noStake: 'pn' }
                }
            } }
        },
        '/agent/discovery?resource=oracle-facts': { state: 'listed', listing: { resource: `${BASE}/agent/oracle/facts` } },
        '/agent/runs?limit=50': { runs: [
            { id: 'proposer', controller: 'algorithm', role: 'proposer', status: 'done', updatedAt: '2026-09-21T10:00:00Z' },
            { id: 'supporter', controller: 'algorithm', role: 'supporter', status: 'done', updatedAt: '2026-09-21T11:00:00Z',
                support: { type: 'pledge', agreementCid: CANONICAL, account: 'canonical-account', signature: 'supporter-transaction' } }
        ] },
        '/agent/activity?limit=200': { events: [
            { runId: 'proposer', transaction: 'proposer-transaction', recordedAt: '2026-09-21T10:00:00Z', action: { type: 'mint' },
                actor: { controller: 'algorithm' } },
            { runId: 'supporter', transaction: 'supporter-transaction', recordedAt: '2026-09-21T11:00:00Z', action: { type: 'pledge' } },
            { actor: { kind: 'human' }, action: { type: 'donate' }, transaction: 'human-donation' },
            { actor: { kind: 'human' }, action: { type: 'stake', side: 'YES' }, transaction: 'human-stake' },
            { actor: { controller: 'llm' }, action: { type: 'stake', side: 'no' }, transaction: 'llm-stake' },
            { action: { type: 'resolve' }, transaction: 'resolve-tx' }
        ] },
        '/oracle/events?type=agreement_lifecycle&limit=25': { events: [{
            id: 'event-1', eventType: 'agreement_lifecycle', outcome: 'executed', recordedAt: '2026-09-21T11:30:00Z',
            source: { hash: `sha256:${'a'.repeat(64)}`, transaction: 'oracle-transaction' }
        }] },
        '/oracle/public-records/summary': { attestations: 62, decisions: 29, schemaId: 'schema', v2: { status: 'live_devnet', attestations: 5 } },
        '/hackathon/proof.json': {
            hackathon: { branch: 'colosseum-worlds-fair' },
            releaseArtifacts: {
                backend: { commit: 'release-sha' },
                frontend: { manifest: 'https://urbangametheory.xyz/release.json' },
                verification: { state: 'verified' }, verifiedAt: new Date(NOW).toISOString(),
                programs: ['Agreement', 'ProposalMarket', 'ProposalPledge'].map((name, index) => ({
                    name, programDataAddress: `program-data-${index}`, lastDeployedSlot: 500000000 + index, binarySha256: `${index + 1}`.repeat(64)
                }))
            },
            publicProof: {
                prospectiveMarket: `${BASE}/oracle/markets/prospective/status`,
                operations: `${BASE}/hackathon/operations.json`,
                canonicalCase: `${BASE}/hackathon/cases/${CANONICAL}`,
                executedCase: `${BASE}/hackathon/cases/${EXECUTED}`
            }
        },
        [`/hackathon/cases/${CANONICAL}`]: {
            id: CANONICAL, state: 'complete',
            agreement: { cid: CANONICAL, account: 'canonical-account', status: 'cancelled' }, parcelSet: { parcelCount: 3 },
            branches: {
                support: { donations: { totalUsdc: '0.05' }, pledges: { activeUsdc: '0.10', pledgeCount: '1' } },
                forecast: { yesUsdc: '0.01', noUsdc: '0.01' }
            },
            activity: [
                { action: { type: 'propose' }, transaction: null },
                { action: { type: 'mint' }, transaction: 'mint' },
                { action: { type: 'donate' }, transaction: 'donate' },
                { action: { type: 'pledge' }, transaction: 'pledge' },
                { action: { type: 'stake', side: 'yes' }, transaction: 'yes' },
                { action: { type: 'stake', side: 'no' }, transaction: 'no' }
            ],
            stages: stagesAll('complete'), progress: { complete: 7, total: 7 }, transactions: [{}, {}, {}, {}, {}]
        },
        [`/hackathon/cases/${EXECUTED}`]: {
            id: EXECUTED, state: 'complete',
            agreement: { cid: EXECUTED, account: 'executed-account', status: 'executed' }, parcelSet: { parcelCount: 2 },
            branches: {
                support: { donations: { totalUsdc: '0.05' }, pledges: { fulfilledUsdc: '0.10', pledgeCount: '1' } },
                forecast: { yesUsdc: '0.01', noUsdc: '0.01', resolved: true, outcome: 'YES' }
            },
            activity: [
                { action: { type: 'mint' }, transaction: 'mint' },
                { action: { type: 'attest' }, transaction: 'attest' },
                { action: { type: 'execute' }, transaction: 'execute' },
                { action: { type: 'resolve' }, transaction: 'resolve' },
                { action: { type: 'releaseDonations' }, transaction: 'release' },
                { action: { type: 'fulfillPledge' }, transaction: 'fulfil' },
                { action: { type: 'claim', side: 'yes' }, transaction: 'claim' }
            ],
            stages: stagesAll('complete'), progress: { complete: 7, total: 7 }
        },
        '/oracle/markets/prospective/status': {
            state: 'open', market: 'prospective-market', resolver: { lastRun: { endedAt: '2026-09-21T11:45:00Z' } }
        },
        '/hackathon/operations.json': {
            status: 'healthy', jobs: ['proposer', 'supporter', 'land-oracle', 'prospective-resolver'].map(role => ({
                role, status: 'completed', freshness: { state: 'fresh' }
            }))
        },
        '/lenses/members': { members: [
            { key: 'notary-key', kind: 'owner-consent', name: 'notary-01', coverage: { ownership: 3, parcels: 2, executed: 1 } },
            { key: 'cadastre-key', kind: 'lifecycle', name: 'lifecycle-01', coverage: { ownership: 1, parcels: 1, executed: 0 } },
            { key: 'idle-key', kind: 'court', name: 'idle', coverage: { ownership: 0, parcels: 0, executed: 0 } }
        ] },
    };
    for (const cid of [CANONICAL, EXECUTED]) {
        const item = data[`/hackathon/cases/${cid}`];
        const cancelled = cid === CANONICAL;
        item.branches.forecast = { ...item.branches.forecast, resolved: true, outcome: cancelled ? 'NO' : 'YES' };
        item.branches.evidence = [{ eventType: 'agreement_lifecycle', subject: { type: 'agreement', id: item.agreement.account },
            outcome: item.agreement.status, source: { hash: 'sha256:' + 'a'.repeat(64), transaction: 'terminal-proof' } }];
        const required = cancelled ? ['cancel', 'resolve', 'claim'] : ['stake'];
        item.activity.push(...required.map(type => ({ action: { type }, transaction: `confirmed-${type}` })));
        item.activity = item.activity.map(event => ({ ...event, ok: true, provenance: { source: 'solana_transaction', confirmation: 'confirmed' } }));
    }
    return { ...data, ...overrides };
}

function fetchFor(data) {
    return vi.fn(async url => {
        const parsed = new URL(url);
        const key = `${parsed.pathname}${parsed.search}`;
        if (!(key in data)) return new Response(JSON.stringify({ error: 'missing fixture' }), { status: 404 });
        return new Response(JSON.stringify(data[key]), { status: 200 });
    });
}
const audit = (data = fixtures(), now = NOW) => auditHackathonProof({ baseUrl: BASE, fetchImpl: fetchFor(data), now });
const checkOf = (result, id) => result.checks.find(item => item.id === id);

describe('public hackathon proof audit', () => {
    it('verifies the complete public proof over the agreement cases the manifest declares', async () => {
        const fetchImpl = fetchFor(fixtures());
        const result = await auditHackathonProof({ baseUrl: `${BASE}/`, fetchImpl, now: NOW });
        expect(result).toMatchObject({ status: 'verified', baseUrl: BASE, auditedAt: '2026-09-21T12:00:00.000Z', sourceErrors: {} });
        expect(result.summary).toEqual({ pass: 19, warn: 0, fail: 0 });
        // Ten public documents, then the two declared cases.
        expect(fetchImpl).toHaveBeenCalledTimes(12);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
            `${BASE}/oracle/events?type=agreement_lifecycle&limit=25`, `${BASE}/hackathon/cases/${CANONICAL}`, `${BASE}/hackathon/cases/${EXECUTED}`
        ]));
        expect(result.checks.map(item => item.id)).toEqual([
            'oracle_fact_bazaar', 'deterministic_proposer', 'deterministic_supporter', 'agreement_lifecycle_oracle',
            'court_attestations', 'external_market_lifecycle', 'prospective_market_open', 'public_proof_manifest',
            'release_artifact_identity', 'release_artifact_freshness', 'case_evidence_pointers', 'canonical_case_no', 'executed_case_yes',
            'human_agent_activity_matrix', 'prospective_resolver_status', 'scheduled_operations_freshness',
            'prospective_settlement_proof', 'chronology_label', 'attester_diversity'
        ]);
        expect(checkOf(result, 'deterministic_supporter')).toMatchObject({
            status: 'pass', evidence: { runId: 'supporter', agreementCid: CANONICAL, account: 'canonical-account', transaction: 'supporter-transaction' }
        });
        expect(checkOf(result, 'agreement_lifecycle_oracle')).toMatchObject({
            status: 'pass', evidence: { eventId: 'event-1', outcome: 'executed', transaction: 'oracle-transaction' }
        });
        expect(checkOf(result, 'executed_case_yes')).toMatchObject({ status: 'pass', evidence: { id: EXECUTED, outcome: 'YES' } });
        expect(checkOf(result, 'canonical_case_no')).toMatchObject({ status: 'pass', evidence: { id: CANONICAL, outcome: 'NO' } });
        expect(checkOf(result, 'attester_diversity').evidence.attesters.map(a => a.key)).toEqual(['notary-key', 'cadastre-key']);
    });

    it('does not accept another resource\'s listing as proof of oracle-fact discovery', async () => {
        const result = await audit(fixtures({
            '/agent/discovery?resource=oracle-facts': { state: 'listed', listing: { resource: `${BASE}/agent/proposals` } }
        }));
        expect(result.status).toBe('incomplete');
        expect(checkOf(result, 'oracle_fact_bazaar').status).toBe('fail');
    });

    it('fails the proof when a deployed release, terminal case or scheduled job regresses', async () => {
        const staleJobs = fixtures()['/hackathon/operations.json'].jobs.map((job, index) => index === 2 ? { ...job, freshness: { state: 'stale' } } : job);
        const closed = fixtures()[`/hackathon/cases/${CANONICAL}`];
        const openCase = { ...closed, agreement: { ...closed.agreement, status: 'active' } };
        const cases = [
            ['scheduled_operations_freshness', { '/hackathon/operations.json': { status: 'degraded', jobs: staleJobs } }],
            ['canonical_case_no', { [`/hackathon/cases/${CANONICAL}`]: openCase }],
            ['release_artifact_identity', { '/hackathon/proof.json': { ...fixtures()['/hackathon/proof.json'], releaseArtifacts: null } }]
        ];
        for (const [id, override] of cases) {
            const result = await audit(fixtures(override));
            expect(result.status, id).toBe('incomplete');
            expect(checkOf(result, id).status, id).toBe('fail');
        }
    });

    it('requires confirmed cancellation, forecast, resolution, claim and source-hashed terminal evidence', async () => {
        const canonical = fixtures()[`/hackathon/cases/${CANONICAL}`];
        const variants = [
            { ...canonical, parcelSet: { parcelCount: 0 } },
            { ...canonical, agreement: { ...canonical.agreement, account: null } },
            { ...canonical, branches: { ...canonical.branches, evidence: [] } },
            ...['mint', 'stake', 'cancel', 'resolve', 'claim'].map(type => ({ ...canonical,
                activity: canonical.activity.filter(event => event.action.type !== type) })),
            { ...canonical, activity: canonical.activity.map(event => ({ ...event, provenance: { source: 'simulation' } })) },
            { ...canonical, activity: canonical.activity.map(event => ({ ...event, ok: false })) }
        ];
        for (const variant of variants) {
            const result = await audit(fixtures({ [`/hackathon/cases/${CANONICAL}`]: variant }));
            expect(checkOf(result, 'canonical_case_no').status).toBe('fail');
        }
        const optionalSupport = { ...canonical, parcelSet: { parcelCount: 1 },
            activity: canonical.activity.filter(event => !['donate', 'pledge'].includes(event.action.type)) };
        expect(checkOf(await audit(fixtures({ [`/hackathon/cases/${CANONICAL}`]: optionalSupport })), 'canonical_case_no').status).toBe('pass');
        const noAssemblyClaim = { ...canonical, parcelSet: undefined,
            activity: canonical.activity.filter(event => !['donate', 'pledge', 'assemble'].includes(event.action.type)) };
        expect(checkOf(await audit(fixtures({ [`/hackathon/cases/${CANONICAL}`]: noAssemblyClaim })), 'canonical_case_no').status).toBe('pass');
    });

    it('requires valid distinct canonical and executed URLs whose linked cases prove their declared outcomes', async () => {
        const manifest = structuredClone(fixtures()['/hackathon/proof.json']);
        const baseCase = fixtures()[`/hackathon/cases/${CANONICAL}`];
        const executedCase = fixtures()[`/hackathon/cases/${EXECUTED}`];
        const variants = [
            ['invalid canonical URL', { manifest: { ...manifest, publicProof: { ...manifest.publicProof, canonicalCase: `${BASE}/hackathon/cases/not-a-cid` } } }],
            ['duplicate pointers', { manifest: { ...manifest, publicProof: { ...manifest.publicProof, executedCase: manifest.publicProof.canonicalCase } } }],
            ['case CID differs from link', { case: { ...baseCase, id: EXECUTED } }],
            ['agreement CID differs from link', { case: { ...baseCase, agreement: { ...baseCase.agreement, cid: EXECUTED } } }],
            ['canonical resolves YES', { case: { ...baseCase, branches: { ...baseCase.branches, forecast: { ...baseCase.branches.forecast, outcome: 'YES' } } }],
            ['executed resolves NO', { executed: { ...executedCase, branches: { ...executedCase.branches, forecast: { ...executedCase.branches.forecast, outcome: 'NO' } } }]
        ];
        for (const [label, change] of variants) {
            const overrides = {};
            if (change.manifest) overrides['/hackathon/proof.json'] = change.manifest;
            if (change.case) overrides[`/hackathon/cases/${CANONICAL}`] = change.case;
            if (change.executed) overrides[`/hackathon/cases/${EXECUTED}`] = change.executed;
            const result = await audit(fixtures(overrides));
            if (change.manifest) expect(checkOf(result, 'case_evidence_pointers').status, label).toBe('fail');
            else expect(checkOf(result, label.includes('executed') ? 'executed_case_yes' : 'canonical_case_no').status, label).toBe('fail');
        }
    });

    it('rejects nonmatching lifecycle provenance and failed or unconfirmed chain actions', async () => {
        const canonical = fixtures()[`/hackathon/cases/${CANONICAL}`];
        const variants = [
            { ...canonical, branches: { ...canonical.branches, evidence: canonical.branches.evidence.map(event => ({ ...event, source: { ...event.source, hash: 'sha256:bad' } })) } },
            { ...canonical, branches: { ...canonical.branches, evidence: canonical.branches.evidence.map(event => ({ ...event, outcome: 'executed' })) } },
            { ...canonical, activity: canonical.activity.map(event => event.action.type === 'cancel' ? { ...event, ok: false } : event) },
            { ...canonical, activity: canonical.activity.map(event => event.action.type === 'resolve' ? { ...event, provenance: { source: 'simulation' } } : event) },
            { ...canonical, activity: canonical.activity.map(event => event.action.type === 'claim' ? { ...event, provenance: { ...event.provenance, confirmation: 'processed' } } : event) }
        ];
        for (const variant of variants) {
            expect(checkOf(await audit(fixtures({ [`/hackathon/cases/${CANONICAL}`]: variant })), 'canonical_case_no').status).toBe('fail');
        }
    });

    it('requires release program identities and a fresh verified observation', async () => {
        const manifest = structuredClone(fixtures()['/hackathon/proof.json']);
        const cases = [
            { ...manifest, releaseArtifacts: { ...manifest.releaseArtifacts, programs: manifest.releaseArtifacts.programs.filter(program => program.name !== 'ProposalPledge') } },
            { ...manifest, releaseArtifacts: { ...manifest.releaseArtifacts, verification: { state: 'unverified' } } },
            { ...manifest, releaseArtifacts: { ...manifest.releaseArtifacts, verifiedAt: new Date(NOW - 3_600_001).toISOString() } },
            { ...manifest, releaseArtifacts: { ...manifest.releaseArtifacts, verifiedAt: new Date(NOW + 1).toISOString() } }
        ];
        for (const candidate of cases) {
            const result = await audit(fixtures({ '/hackathon/proof.json': candidate }));
            expect(checkOf(result, 'release_artifact_freshness').status).toBe('fail');
        }
    });

    it('requires the executed case to be executed on its lens attestation, resolved YES and paid out', async () => {
        const executed = fixtures()[`/hackathon/cases/${EXECUTED}`];
        const without = predicate => ({ ...executed, activity: executed.activity.filter(event => !predicate(event)) });
        const cases = [
            ['resolved NO', { ...executed, branches: { ...executed.branches, forecast: { ...executed.branches.forecast, outcome: 'NO' } } }],
            ['still active', { ...executed, agreement: { ...executed.agreement, status: 'active' } }],
            ['decision never recorded', without(event => event.action.type === 'attest')],
            ['never executed', without(event => event.action.type === 'execute')],
            ['YES never claimed', without(event => event.action.type === 'claim')],
            ['evidence pending', { ...executed, branches: { ...executed.branches, evidence: [] } }]
        ];
        for (const [label, override] of cases) {
            const result = await audit(fixtures({ [`/hackathon/cases/${EXECUTED}`]: override }));
            expect(result.status, label).toBe('incomplete');
            expect(checkOf(result, 'executed_case_yes').status, label).toBe('fail');
        }
    });

    it('requires both declared outcomes and reports a case it cannot read', async () => {
        const undeclared = fixtures();
        delete undeclared['/hackathon/proof.json'].publicProof.executedCase;
        const fetchImpl = fetchFor(undeclared);
        const result = await auditHackathonProof({ baseUrl: BASE, fetchImpl, now: NOW });
        expect(checkOf(result, 'executed_case_yes').status).toBe('fail');
        expect(checkOf(result, 'case_evidence_pointers').status).toBe('fail');
        expect(fetchImpl.mock.calls.some(([url]) => url.includes(EXECUTED))).toBe(false);
        expect(result.status).toBe('incomplete');

        const missing = fixtures();
        delete missing[`/hackathon/cases/${CANONICAL}`];
        const unreadable = await audit(missing);
        expect(checkOf(unreadable, 'canonical_case_no')).toMatchObject({ status: 'fail', evidence: `${BASE}/hackathon/cases/${CANONICAL} returned 404` });
        expect(unreadable.sourceErrors.canonicalCase).toMatch(/404/);
    });

    it('ignores a newer supporter no-op and requires the last signed support to be recent', async () => {
        const runs = fixtures()['/agent/runs?limit=50'].runs;
        const noop = {
            id: 'supporter-noop', controller: 'algorithm', role: 'supporter', status: 'done', updatedAt: '2026-09-21T11:30:00Z',
            support: { type: 'pledge', agreementCid: CANONICAL, replayed: true, signature: null }
        };
        const withNoop = await audit(fixtures({ '/agent/runs?limit=50': { runs: [...runs, noop] } }));
        expect(checkOf(withNoop, 'deterministic_supporter')).toMatchObject({ status: 'pass', evidence: { runId: 'supporter', transaction: 'supporter-transaction' } });
        const stale = await audit(fixtures(), Date.parse('2026-09-24T12:00:00Z'));
        expect(checkOf(stale, 'deterministic_supporter').status).toBe('fail');
        expect(checkOf(stale, 'deterministic_proposer').status).toBe('fail');
    });

    it('treats the agreement lifecycle oracle, chronology, activity matrix and attester diversity as advisory', async () => {
        const data = fixtures({
            '/oracle/events?type=agreement_lifecycle&limit=25': { events: [{ id: 'unhashed', eventType: 'agreement_lifecycle', source: { hash: 'md5:x', transaction: 't' } }] },
            '/agent/activity?limit=200': { events: fixtures()['/agent/activity?limit=200'].events.filter(event => event.actor?.controller !== 'llm') }
        });
        delete data['/docs/agents.json'].oracle.externalMarket.proof.chronology;
        data['/lenses/members'] = { members: data['/lenses/members'].members.slice(0, 1) };
        const result = await audit(data);
        expect(result.status).toBe('verified');
        expect(result.summary).toEqual({ pass: 15, warn: 4, fail: 0 });
        for (const id of ['agreement_lifecycle_oracle', 'chronology_label', 'human_agent_activity_matrix', 'attester_diversity']) {
            expect(checkOf(result, id).status, id).toBe('warn');
        }
        expect(checkOf(result, 'human_agent_activity_matrix').evidence).toMatchObject({ humanSupport: true, humanForecast: true, llm: false });
    });

    it('requires a payout and strictly ordered public proof once the prospective market settles', async () => {
        const settlement = {
            outcome: 'YES',
            evidence: { address: 'evidence-account', hash: `sha256:${'b'.repeat(64)}` },
            transactions: { evidenceFirstSeen: 'first-seen-tx', resolution: 'resolve-tx', claim: 'claim-tx' },
            chronology: {
                classification: 'prospective', prospective: true, marketOrderValid: true, sourceTimeVerified: true, sourceAfterClose: true,
                timestamps: {
                    marketCreatedAt: '2026-09-22T19:00:00Z', yesStakeAt: '2026-09-22T19:01:00Z', noStakeAt: '2026-09-22T19:02:00Z',
                    marketClosesAt: '2026-09-22T21:00:00Z', sourceObservedAt: '2026-09-22T21:10:00Z', evidenceCreatedAt: '2026-09-22T21:20:00Z',
                    resolvedAt: '2026-09-22T21:30:00Z', claimedAt: '2026-09-22T21:31:00Z'
                },
                transactionSlots: { evidenceFirstSeen: 100, resolution: 110, claim: 111 }
            }
        };
        const status = {
            state: 'settled', market: 'prospective-market', closesAt: '2026-09-22T21:00:00Z',
            transactions: { create: 'create-tx', yesStake: 'yes-tx', noStake: 'no-tx' }, settlement
        };
        const later = Date.parse('2026-09-22T22:00:00Z');
        const complete = await audit(fixtures({ '/oracle/markets/prospective/status': status }), later);
        expect(checkOf(complete, 'prospective_settlement_proof')).toMatchObject({ status: 'pass' });

        const missingPayout = structuredClone(status);
        missingPayout.settlement.transactions.claim = null;
        expect(checkOf(await audit(fixtures({ '/oracle/markets/prospective/status': missingPayout }), later), 'prospective_settlement_proof').status).toBe('fail');

        const sameSecond = structuredClone(status);
        sameSecond.settlement.chronology.timestamps.claimedAt = '2026-09-22T21:30:00Z';
        expect(validateProspectiveSettlement(sameSecond).valid).toBe(true);
        sameSecond.settlement.chronology.transactionSlots.claim = 105;
        expect(validateProspectiveSettlement(sameSecond).valid).toBe(false);
        expect(validateProspectiveSettlement({ state: 'open' })).toEqual({ valid: true, pending: true });
    });

    it('reports a missing member directory without failing the proof', async () => {
        const absent = fixtures();
        delete absent['/lenses/members'];
        const result = await audit(absent);
        expect(checkOf(result, 'attester_diversity')).toMatchObject({ status: 'warn' });
        expect(checkOf(result, 'attester_diversity').evidence).toMatch(/404/);
        expect(result.status).toBe('verified');
    });

    it('requires an exact normalized resource URL', () => {
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/agent/oracle/facts/` } }, `${BASE}/agent/oracle/facts`)).toBe(true);
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/agent/oracle/facts?x=1` } }, `${BASE}/agent/oracle/facts`)).toBe(true);
        expect(exactResource({ state: 'listed', listing: { resource: `${BASE}/other` } }, `${BASE}/agent/oracle/facts`)).toBe(false);
        expect(exactResource({ state: 'not-listed', listing: { resource: `${BASE}/agent/oracle/facts` } }, `${BASE}/agent/oracle/facts`)).toBe(false);
    });
});
