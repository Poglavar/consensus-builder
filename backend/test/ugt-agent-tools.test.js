import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function keypairFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ugt-mcp-test-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'agent.json');
    fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
    return file;
}

describe('shared Urban Game Theory agent tools', () => {
    it('uses the public API for the same proposal, activity and support views as the UI', async () => {
        const seen = [];
        const tools = createUrbanGameTheoryTools({
            env: { UGT_API_BASE: 'https://api.example.test/' },
            fetchImpl: async (url) => {
                seen.push(url);
                return jsonResponse({ ok: true, url });
            }
        });

        await tools.listProposals({ city: 'zagreb', lifecycle: 'Active', limit: 7 });
        await tools.getActivity({ limit: 12, source: 'live' });
        await tools.getSupport({ proposalAccount: 'proposal-account' });
        await tools.getOracleEvents({ proposalAccount: 'proposal-account', limit: 3 });

        expect(seen).toEqual([
            'https://api.example.test/proposals/summary?city=zagreb&lifecycle=Active&limit=7',
            'https://api.example.test/agent/activity?limit=12&source=live',
            'https://api.example.test/agent/pledges/proposal-account',
            'https://api.example.test/oracle/events?subject=proposal-account&limit=3'
        ]);
        expect(tools.config).toMatchObject({ cluster: 'solana-devnet', liveActionsEnabled: false });
    });

    it('keeps every paid or signed action disabled by default', async () => {
        const tools = createUrbanGameTheoryTools({ env: {}, fetchImpl: vi.fn() });

        await expect(tools.submitProposal({ proposal: {}, confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.buyVerifiedFact({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.pledge({ proposalAccount: 'abc', amountUsdc: '0.01', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.donate({ proposalAccount: 'abc', amountUsdc: '0.01', operationId: 'once', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.forecast({ proposalAccount: 'abc', side: 'yes', amountUsdc: '0.01', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.cancel({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.accept({ proposalAccount: 'abc', parcelId: 'HR-1', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.refundDonation({ proposalAccount: 'abc', operationId: 'once', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.voidPledge({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.revokePledge({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.releaseDonations({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.fulfillPledge({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.resolve({ proposalAccount: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.claim({ proposalAccount: 'abc', side: 'no', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.resolveExternal({ recipeHash: 'a'.repeat(64), attestation: 'abc', confirm: true })).rejects.toThrow('live actions are disabled');
        await expect(tools.claimExternal({ recipeHash: 'a'.repeat(64), side: 'yes', confirm: true })).rejects.toThrow('live actions are disabled');
    });

    it('routes pledge, donation and forecast through the existing signer adapters with a hard cap', async () => {
        const ensurePledgeBookAndSet = vi.fn(async options => ({ signature: 'pledge-tx', amount: options.amountAtomic }));
        const ensureDonationEscrowAndDonate = vi.fn(async options => ({ signature: 'donate-tx', amount: options.amountAtomic }));
        const ensureMarketAndStake = vi.fn(async options => ({ stakeSignature: 'stake-tx', side: options.side, amount: options.amountAtomic }));
        const tools = createUrbanGameTheoryTools({
            env: {
                UGT_MCP_LIVE: '1', UGT_AGENT_KEYPAIR: keypairFile(),
                UGT_MCP_MAX_USDC_PER_ACTION: '0.10'
            },
            fetchImpl: vi.fn(),
            createConnection: () => ({ getAccountInfo: vi.fn() }),
            dependencies: {
                ensurePledgeBookAndSet, ensureDonationEscrowAndDonate, ensureMarketAndStake,
                sendAndConfirmPolling: vi.fn()
            }
        });

        await expect(tools.pledge({ proposalAccount: 'proposal', amountUsdc: '0.11', confirm: true }))
            .rejects.toThrow('exceeds UGT_MCP_MAX_USDC_PER_ACTION');
        await tools.pledge({ proposalAccount: 'proposal', amountUsdc: '0.05', confirm: true });
        await tools.donate({ proposalAccount: 'proposal', amountUsdc: '0.06', operationId: 'agent:donate:1', confirm: true });
        await tools.forecast({ proposalAccount: 'proposal', side: 'no', amountUsdc: '0.07', confirm: true });

        expect(ensurePledgeBookAndSet.mock.calls[0][0].amountAtomic).toBe(50000n);
        expect(ensureDonationEscrowAndDonate.mock.calls[0][0]).toMatchObject({ amountAtomic: 60000n, operationId: 'agent:donate:1' });
        expect(ensureMarketAndStake.mock.calls[0][0]).toMatchObject({ amountAtomic: 70000n, side: 0 });
    });

    it('routes both terminal branches and external markets through shared signer adapters', async () => {
        const dependencies = Object.fromEntries([
            'acceptProposal', 'revokePledge', 'releaseDonations', 'fulfillPledge',
            'resolveExternalMarket', 'claimExternalMarket'
        ].map(name => [name, vi.fn(async () => ({ signature: `${name}-tx` }))]));
        const tools = createUrbanGameTheoryTools({
            env: { UGT_MCP_LIVE: '1', UGT_AGENT_KEYPAIR: keypairFile() },
            fetchImpl: vi.fn(), createConnection: () => ({ getAccountInfo: vi.fn() }),
            dependencies: { ...dependencies, sendAndConfirmPolling: vi.fn() }
        });

        await tools.accept({ proposalAccount: 'proposal', parcelId: 'HR-1', confirm: true });
        await tools.revokePledge({ proposalAccount: 'proposal', confirm: true });
        await tools.releaseDonations({ proposalAccount: 'proposal', confirm: true });
        await tools.fulfillPledge({ proposalAccount: 'proposal', confirm: true });
        await tools.resolveExternal({ recipeHash: 'a'.repeat(64), attestation: 'attestation', confirm: true });
        await tools.claimExternal({ recipeHash: 'a'.repeat(64), side: 'yes', confirm: true });

        expect(dependencies.acceptProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalAccount: 'proposal', parcelId: 'HR-1' }));
        expect(dependencies.revokePledge).toHaveBeenCalledWith(expect.objectContaining({ proposalAccount: 'proposal' }));
        expect(dependencies.releaseDonations).toHaveBeenCalledWith(expect.objectContaining({ proposalAccount: 'proposal' }));
        expect(dependencies.fulfillPledge).toHaveBeenCalledWith(expect.objectContaining({ proposalAccount: 'proposal' }));
        expect(dependencies.resolveExternalMarket).toHaveBeenCalledWith(expect.objectContaining({ recipeHash: 'a'.repeat(64), attestation: 'attestation' }));
        expect(dependencies.claimExternalMarket).toHaveBeenCalledWith(expect.objectContaining({ recipeHash: 'a'.repeat(64), side: 'yes' }));
    });

    it('uses proposal ids as stable x402 payment identifiers', async () => {
        const createPaidClient = vi.fn(async () => ({ payerAddress: 'payer', paidFetch: vi.fn() }));
        const postAgentProposal = vi.fn(async () => ({ status: 201, body: { proposalId: 'mcp-1' }, receipt: { transaction: 'x402-tx' } }));
        const tools = createUrbanGameTheoryTools({
            env: { UGT_MCP_LIVE: 'true', UGT_AGENT_KEYPAIR: keypairFile() },
            fetchImpl: vi.fn(),
            createConnection: () => ({}),
            dependencies: {
                createPaidClient, postAgentProposal,
                fetchChallenge: vi.fn(async () => ({ accepts: [{ amount: '50000' }] }))
            }
        });

        const result = await tools.submitProposal({
            proposal: { proposalId: 'mcp-1', cadastreParcelIds: ['HR-1'] }, confirm: true
        });

        expect(result).toMatchObject({ payerAddress: 'payer', status: 201 });
        expect(createPaidClient.mock.calls[0][0].paymentId).toMatch(/^proposal_[0-9a-f]{64}$/);
        expect(postAgentProposal.mock.calls[0][0].body.cadastreParcelIds).toEqual(['HR-1']);
    });

    it('refuses an x402 challenge above the action cap before loading a signer', async () => {
        const createPaidClient = vi.fn();
        const tools = createUrbanGameTheoryTools({
            env: { UGT_MCP_LIVE: '1', UGT_MCP_MAX_USDC_PER_ACTION: '0.25' },
            fetchImpl: vi.fn(),
            dependencies: {
                createPaidClient,
                fetchChallenge: vi.fn(async () => ({ accepts: [{ amount: '250001' }] }))
            }
        });

        await expect(tools.submitProposal({
            proposal: { proposalId: 'too-expensive', cadastreParcelIds: ['HR-1'] }, confirm: true
        })).rejects.toThrow('proposal x402 price exceeds');
        expect(createPaidClient).not.toHaveBeenCalled();
    });
});
