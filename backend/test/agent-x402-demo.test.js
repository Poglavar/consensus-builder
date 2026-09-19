import { describe, expect, it, vi } from 'vitest';
import {
    assertIdempotentReplay,
    buildDemoProposal,
    fetchAgentManifest,
    findBazaarListing,
    inspectBazaarDeclaration,
    proposalAppUrl,
    proposalRecordUrl,
    runX402Demo,
    solanaExplorerUrl
} from '../agents/x402-demo.js';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TX = '5SettlementSignatureForDemo';
const WALLET = 'DemoWallet11111111111111111111111111111111';

function challenge() {
    return {
        accepts: [{ amount: '50000', asset: 'USDC', network: NETWORK, payTo: 'Treasury111' }],
        extensions: {
            bazaar: {
                info: {
                    input: { type: 'http', method: 'POST', bodyType: 'json', body: { cadastreParcelIds: ['HR-1'] } },
                    output: { type: 'json' }
                },
                schema: {
                    properties: {
                        input: { properties: { body: { properties: { cadastreParcelIds: { type: 'array' } } } } }
                    }
                }
            }
        }
    };
}

describe('deterministic x402 demo proposal', () => {
    it('derives the same proposal id from the same visible arguments', () => {
        const first = buildDemoProposal({ city: 'zagreb', parcels: 'HR-2, HR-1' });
        const second = buildDemoProposal({ city: 'zagreb', parcels: ['HR-2', 'HR-1'] });
        expect(first).toEqual(second);
        expect(first.proposalId).toMatch(/^agent-demo-[a-f0-9]{20}$/);
        expect(buildDemoProposal({ city: 'zagreb', parcels: ['HR-1'] }).proposalId).not.toBe(first.proposalId);
    });

    it('accepts an explicit stable id and rejects unusable inputs', () => {
        expect(buildDemoProposal({ parcels: ['HR-1'], proposalId: 'stage-demo' }).proposalId).toBe('stage-demo');
        expect(() => buildDemoProposal({ parcels: [] })).toThrow(/parcel/);
        expect(() => buildDemoProposal({ parcels: ['HR-1'], offer: 'nope' })).toThrow(/offer/);
    });
});

describe('x402 demo discovery', () => {
    it('reads the machine manifest from the bootstrap server', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            x402: { enabled: true },
            endpoints: { submit: 'https://api.test/agent/proposals', read: 'https://api.test/proposals/{id}' }
        }), { status: 200 }));
        const result = await fetchAgentManifest({ baseUrl: 'https://bootstrap.test/base/', fetchImpl });
        expect(fetchImpl).toHaveBeenCalledWith('https://bootstrap.test/docs/agents.json', expect.any(Object));
        expect(result.manifest.endpoints.submit).toContain('/agent/proposals');
    });

    it('requires and summarizes the Bazaar declaration on the 402', () => {
        expect(inspectBazaarDeclaration(challenge())).toMatchObject({ method: 'POST', bodyType: 'json', outputType: 'json' });
        expect(() => inspectBazaarDeclaration({ accepts: [] })).toThrow(/Bazaar/);
    });

    it('finds only the exact endpoint in a facilitator catalog page', async () => {
        const search = vi.fn().mockResolvedValue({
            resources: [{ resource: 'https://api.example.test/other' }, { resource: 'https://api.example.test/agent/proposals' }],
            partialResults: false
        });
        const result = await findBazaarListing({
            facilitatorUrl: 'https://facilitator.test',
            submitUrl: 'https://api.example.test/agent/proposals',
            payTo: 'Treasury111',
            network: NETWORK,
            bazaarClient: { extensions: { bazaar: { search } } }
        });
        expect(result.state).toBe('listed');
        expect(result.listing.resource).toContain('/agent/proposals');
        expect(search).toHaveBeenCalledWith(expect.objectContaining({
            query: 'https://api.example.test/agent/proposals',
            type: 'http',
            extensions: 'bazaar',
            limit: 20
        }));
    });

    it('falls back to listing for facilitators without Bazaar search', async () => {
        const listResources = vi.fn().mockResolvedValue({
            items: [{ resource: 'https://api.example.test/agent/proposals' }],
            pagination: { total: 1 }
        });
        const result = await findBazaarListing({
            facilitatorUrl: 'https://facilitator.test',
            submitUrl: 'https://api.example.test/agent/proposals',
            bazaarClient: { extensions: { bazaar: { listResources } } }
        });
        expect(result.state).toBe('listed');
        expect(listResources).toHaveBeenCalledOnce();
    });
});

describe('x402 demo evidence', () => {
    it('builds proposal and settlement links', () => {
        expect(proposalRecordUrl('https://api.test/proposals/{id}', 'agent one')).toBe('https://api.test/proposals/agent%20one');
        expect(proposalAppUrl('https://app.test/base', 'agent one')).toBe('https://app.test/proposals/agent%20one');
        expect(solanaExplorerUrl(TX, NETWORK)).toBe(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    });

    it('proves the retry has the same proposal and settlement', () => {
        const result = { status: 201, body: { id: 7, proposalId: 'demo', createdAt: 'now' }, receipt: { transaction: TX } };
        expect(assertIdempotentReplay(result, structuredClone(result))).toEqual({
            proposal: { id: 7, proposalId: 'demo', createdAt: 'now', screenshotUrl: null },
            transaction: TX
        });
        expect(() => assertIdempotentReplay(result, { ...result, receipt: { transaction: 'different' } })).toThrow(/settlement/);
    });

    it('runs discover, submit twice and read-back in a fixed order', async () => {
        const body = buildDemoProposal({ parcels: ['HR-1'], proposalId: 'agent-demo-test' });
        const manifest = {
            x402: { enabled: true, facilitatorUrl: 'https://facilitator.test' },
            endpoints: {
                submit: 'https://api.test/agent/proposals',
                read: 'https://api.test/proposals/{id}'
            }
        };
        const created = {
            status: 201,
            body: { id: 7, proposalId: body.proposalId, createdAt: '2026-09-19T00:00:00Z', screenshotUrl: null },
            receipt: { success: true, transaction: TX, network: NETWORK, payer: WALLET }
        };
        const post = vi.fn().mockResolvedValue(created);
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            proposalId: body.proposalId,
            agent: { wallet: WALLET, paid: { tx: TX } }
        }), { status: 200 }));
        const result = await runX402Demo({
            baseUrl: 'https://api.test',
            body,
            secretKey: new Uint8Array(64),
            appUrl: 'https://app.test',
            fetchImpl,
            deps: {
                fetchAgentManifest: vi.fn().mockResolvedValue({ manifestUrl: 'https://api.test/docs/agents.json', manifest }),
                fetchChallenge: vi.fn().mockResolvedValue(challenge()),
                createPaidClient: vi.fn().mockResolvedValue({ payerAddress: WALLET, paidFetch: vi.fn() }),
                postAgentProposal: post,
                findBazaarListing: vi.fn()
                    .mockResolvedValueOnce({ state: 'not-listed', listing: null })
                    .mockResolvedValueOnce({ state: 'listed', listing: { resource: manifest.endpoints.submit } })
            }
        });

        expect(post).toHaveBeenCalledTimes(2);
        expect(post).toHaveBeenNthCalledWith(1, expect.objectContaining({ baseUrl: 'https://api.test' }));
        expect(result.replayProof.transaction).toBe(TX);
        expect(result.links).toMatchObject({
            proposalApi: `https://api.test/proposals/${body.proposalId}`,
            proposalApp: `https://app.test/proposals/${body.proposalId}`,
            settlement: `https://explorer.solana.com/tx/${TX}?cluster=devnet`
        });
        expect(result.discovered.catalogAfter.state).toBe('listed');
    });

    it('stops after discovery in dry-run mode without creating a paying client', async () => {
        const body = buildDemoProposal({ parcels: ['HR-1'] });
        const makePaidClient = vi.fn();
        const result = await runX402Demo({
            baseUrl: 'https://api.test',
            body,
            dryRun: true,
            deps: {
                fetchAgentManifest: vi.fn().mockResolvedValue({
                    manifestUrl: 'https://api.test/docs/agents.json',
                    manifest: {
                        x402: { enabled: true, facilitatorUrl: 'https://facilitator.test' },
                        endpoints: { submit: 'https://api.test/agent/proposals', read: 'https://api.test/proposals/{id}' }
                    }
                }),
                fetchChallenge: vi.fn().mockResolvedValue(challenge()),
                createPaidClient: makePaidClient,
                findBazaarListing: vi.fn().mockResolvedValue({ state: 'not-listed', listing: null })
            }
        });
        expect(result.dryRun).toBe(true);
        expect(makePaidClient).not.toHaveBeenCalled();
    });
});
