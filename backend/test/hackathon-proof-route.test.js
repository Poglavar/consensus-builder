// Contract tests for the public hackathon manifest and privacy-preserving market status route.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { setupHackathonProofRoute } from '../routes/hackathon-proof.js';
import { buildProspectiveMarketStatus, PROSPECTIVE_MARKET } from '../oracle/prospective-market-public.js';
import { createRouteApp } from './helpers/create-route-app.js';

describe('hackathon public proof routes', () => {
    it('publishes scope, programs and stable public evidence links', async () => {
        const statusReader = vi.fn(() => buildProspectiveMarketStatus({ now: Date.parse('2026-09-22T20:00:00Z') }));
        const app = createRouteApp(setupHackathonProofRoute, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', RELEASE_SHA: 'abc123' }, statusReader
        });
        const res = await request(app).get('/hackathon/proof.json');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            title: 'Hyperstition: Markets for Possible Cities',
            hackathon: { branch: 'colosseum-worlds-fair', baselineCommit: '3ee1855', releaseCommit: 'abc123' },
            releaseArtifacts: {
                backend: { commit: 'abc123' },
                frontend: { manifest: 'https://urbangametheory.xyz/release.json' },
                programs: [
                    { name: 'ProposalPledge', lastDeployedSlot: 503098918, binarySha256: '649c6fda6c9cc2bd5e224772ca562dfb6576a2f46ca46498ad271f5bf39d053c' },
                    { name: 'ProposalMarket', lastDeployedSlot: 503099080, binarySha256: '3039d28d7ea30161d418f0ac02924e97085b902d0d420e6d3cd0197d8ba91c0e' },
                    {
                        name: 'ProposalNFT', address: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
                        programDataAddress: 'GS6Tjof9kJCSUPLGJU2qDQH7VA1rTmJi6TdF1Fnn9RMP', lastDeployedSlot: 501070500,
                        binarySha256: '977590f5a6255ff62b77eecaea065f2016304272ea0f1e18d0e0e2987ee9e1b3',
                        idlAddress: 'EXYuUatUDNoa2TMXYGmnEWWJMxrhDxbetT3AR33Xw3zq', idlSha256: null
                    },
                    {
                        name: 'ParcelNFT', address: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
                        programDataAddress: '6FghjCzxbcwxeAFfDTQcUzk8RzJCQXS6d5fZMLxfJbTn', lastDeployedSlot: 450670421,
                        binarySha256: '34a0d0bbb74383599144a3d87478873c97ab03f23e1145a00baff6344d824959',
                        idlAddress: 'EjG4tuNWepkUJZmpFkLT4jdPn7S6n4NZkqduF2RJRRSL'
                    }
                ],
                verifiedAt: '2026-09-30'
            },
            publicProof: {
                manifest: 'https://api.example.test/hackathon/proof.json',
                prospectiveMarket: 'https://api.example.test/oracle/markets/prospective/status',
                operations: 'https://api.example.test/hackathon/operations.json',
                canonicalCase: 'https://api.example.test/hackathon/cases/hackathon-golden-borovje-2026',
                executedCase: 'https://api.example.test/hackathon/cases/hackathon-executed-borovje-2026',
                independentX402: {
                    kind: 'clean_room_verified_fact_purchase', amountAtomic: '10000',
                    transaction: '3T7mg2f5FRk6uFND6eyRKrS5VyHviizk4vmPqB1zxVJbmnz4f1nxaMjXxGi4XEh8JMMesPXNbaaCNzgFQxRxTGPn'
                }
            }
        });
        expect(res.body.hackathonPrograms).toHaveLength(2);
        expect(res.body.builtForHackathon).toEqual(expect.arrayContaining([
            expect.stringContaining('x402'), expect.stringContaining('prospective market')
        ]));
    });

    it('pins each program IDL checksum to the checked-in IDL file', async () => {
        const app = createRouteApp(setupHackathonProofRoute, {
            env: { PUBLIC_API_BASE_URL: 'https://api.example.test', RELEASE_SHA: 'abc123' },
            statusReader: () => buildProspectiveMarketStatus({ now: Date.parse('2026-09-22T20:00:00Z') })
        });
        const { body } = await request(app).get('/hackathon/proof.json');
        const files = {
            ProposalPledge: 'proposal_pledge.json', ProposalMarket: 'proposal_market.json',
            ProposalNFT: 'proposal_nft.json', ParcelNFT: 'parcel_nft.json'
        };
        expect(body.releaseArtifacts.programs.map(program => program.name)).toEqual(Object.keys(files));
        for (const program of body.releaseArtifacts.programs) {
            const bytes = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'blockchain', 'solana', 'idl', files[program.name]));
            expect(program.idlAddress, program.name).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
            if (program.idlSha256 === null) {
                // An on-chain IDL that equals no checked-in file must say why rather than pin a hash.
                expect(program.note, program.name).toMatch(/on-chain IDL/);
                continue;
            }
            expect(program.idlSha256, program.name).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
        }
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
