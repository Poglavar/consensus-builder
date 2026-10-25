// Contract tests for the public hackathon manifest and privacy-preserving market status route.

import fs from 'node:fs';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupHackathonProofRoute } from '../routes/hackathon-proof.js';
import { buildProspectiveMarketStatus, PROSPECTIVE_MARKET } from '../oracle/prospective-market-public.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { cidOfObject } from '../cid.js';

describe('hackathon public proof routes', () => {
    const evidence = {
        state: 'verified', verifiedAt: '2026-10-25T10:00:00.000Z', method: 'fixture account observation',
        programs: [{ name: 'Agreement', address: 'fixture-program', lastDeployedSlot: 123,
            binarySha256: 'a'.repeat(64), programDataAddress: 'fixture-program-data' }]
    };
    const caseDefaults = JSON.parse(fs.readFileSync(new URL('../hackathon/proof-cases.json', import.meta.url), 'utf8'));

    it('publishes observed program evidence and configured proof cases without refreshing their timestamp', async () => {
        const app = createRouteApp(setupHackathonProofRoute, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', RELEASE_SHA: 'abc123' },
            programReader: async () => evidence
        });
        const res = await request(app).get('/hackathon/proof.json');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject({
            title: 'Hyperstition: Markets for Possible Cities',
            hackathon: { branch: 'colosseum-worlds-fair', baselineCommit: '3ee1855', releaseCommit: 'abc123' },
            releaseArtifacts: {
                backend: { commit: 'abc123' },
                frontend: { manifest: 'https://urbangametheory.xyz/release.json' },
                programs: evidence.programs, verifiedAt: evidence.verifiedAt,
                verification: { state: 'verified', method: evidence.method, error: null }
            }
        });
        for (const key of ['canonicalCase', 'executedCase']) {
            expect(res.body.publicProof[key]).toBe(caseDefaults[key]
                ? `https://api.example.test/hackathon/cases/${caseDefaults[key]}` : null);
        }
        expect(res.body.publicProof).not.toHaveProperty('attestedCase');
    });

    it('links explicit agreement CIDs and keeps invalid case configuration null', async () => {
        const canonical = cidOfObject({ schema: 'agreement/v1', title: 'Canonical case' });
        const executed = cidOfObject({ schema: 'agreement/v1', title: 'Executed case' });
        const appFor = env => createRouteApp(setupHackathonProofRoute, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', ...env }, programReader: async () => evidence
        });
        const { body } = await request(appFor({ HACKATHON_CASE_ID: canonical, HACKATHON_EXECUTED_CASE_ID: executed })).get('/hackathon/proof.json');
        expect(body.publicProof).toMatchObject({
            canonicalCase: `https://api.example.test/hackathon/cases/${canonical}`,
            executedCase: `https://api.example.test/hackathon/cases/${executed}`
        });
        const invalid = await request(appFor({ HACKATHON_CASE_ID: 'invalid-case', HACKATHON_EXECUTED_CASE_ID: `${executed} ` })).get('/hackathon/proof.json');
        expect(invalid.body.publicProof).toMatchObject({ canonicalCase: null, executedCase: null });
    });

    it('reports failed deployment observation without a verification time or provider details', async () => {
        const app = createRouteApp(setupHackathonProofRoute, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test' },
            programReader: async () => { throw new Error('private provider connection details'); }
        });
        const { body } = await request(app).get('/hackathon/proof.json');
        expect(body.releaseArtifacts).toMatchObject({
            programs: [], verifiedAt: null,
            verification: { state: 'unavailable', method: null, error: 'Current devnet deployments could not be verified.' }
        });
        expect(JSON.stringify(body)).not.toContain('private provider');
    });

    it('exposes live resolver health without private parcel or wallet state', async () => {
        const statusReader = vi.fn(() => buildProspectiveMarketStatus({
            now: Date.parse('2026-09-22T22:00:00Z'),
            runStats: {
                job: 'prospective-market-resolver', runStatus: 'completed', market: PROSPECTIVE_MARKET.market,
                phase: 'awaiting_evidence', readiness: 'no_matching_post_close_attestation',
                startedAt: '2026-09-22T21:45:00Z', endedAt: '2026-09-22T21:45:03Z'
            }
        }));
        const app = createRouteApp(setupHackathonProofRoute, { env: {}, statusReader });
        const res = await request(app).get('/oracle/markets/prospective/status');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            state: 'awaiting_evidence', market: PROSPECTIVE_MARKET.market,
            stakes: { yes: 0.01, no: 0.01, pool: 0.02 },
            resolver: { cadence: 'hourly at minute 45', lastRun: { status: 'completed' } }
        });
        const body = JSON.stringify(res.body);
        for (const privateField of ['parcelUid', 'yesOperation', 'noOperation', 'decisionUuid', 'wallets', 'rpcUrl']) {
            expect(body).not.toContain(`"${privateField}":`);
        }
    });

    it('publishes complete redacted settlement evidence when the prospective run succeeds', () => {
        const status = buildProspectiveMarketStatus({
            now: Date.parse('2026-09-22T22:00:00Z'),
            runStats: {
                job: 'prospective-market-resolver', runStatus: 'completed', market: PROSPECTIVE_MARKET.market,
                phase: 'settled', readiness: null, outcome: 'NO',
                evidence: { address: 'evidence-account', hash: `sha256:${'c'.repeat(64)}`, decisionUuid: 'private' },
                transactions: { evidenceFirstSeen: 'first-seen', resolve: 'resolution', claim: 'claim' },
                chronology: {
                    classification: 'prospective', prospective: true, marketOrderValid: true,
                    attestationAfterClose: true, sourceTimeVerified: true, sourceAfterClose: true,
                    timestamps: {
                        marketCreatedAt: '2026-09-22T19:00:00Z', yesStakeAt: '2026-09-22T19:01:00Z',
                        noStakeAt: '2026-09-22T19:02:00Z', lastStakeAt: '2026-09-22T19:02:00Z',
                        marketClosesAt: '2026-09-22T21:00:00Z', sourceObservedAt: '2026-09-22T21:10:00Z',
                        evidenceCreatedAt: '2026-09-22T21:20:00Z', resolvedAt: '2026-09-22T21:30:00Z',
                        claimedAt: '2026-09-22T21:31:00Z'
                    },
                    transactionSlots: { evidenceFirstSeen: 100, resolution: 110, claim: 111 },
                    reason: 'ordered proof'
                }
            }
        });
        expect(status).toMatchObject({
            state: 'settled', settlement: {
                outcome: 'NO', evidence: { address: 'evidence-account', hash: `sha256:${'c'.repeat(64)}` },
                transactions: { evidenceFirstSeen: 'first-seen', resolution: 'resolution', claim: 'claim' },
                chronology: {
                    classification: 'prospective', prospective: true,
                    transactionSlots: { evidenceFirstSeen: 100, resolution: 110, claim: 111 }
                }
            }
        });
        expect(JSON.stringify(status)).not.toContain('"decisionUuid":');
    });
});
