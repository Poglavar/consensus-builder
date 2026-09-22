import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';

let client;
let server;

afterEach(async () => {
    await client?.close();
    await server?.close();
    client = null;
    server = null;
});
async function connect(tools) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createUrbanGameTheoryMcpServer({ tools });
    client = new Client({ name: 'ugt-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

function stubTools() {
    return {
        capabilities: vi.fn(async () => ({ x402: { enabled: true } })),
        listProposals: vi.fn(async args => ({ proposals: [], args })),
        getActivity: vi.fn(async () => ({ events: [] })),
        getSupport: vi.fn(async () => ({ donations: null, pledges: null })),
        getOracleEvents: vi.fn(async () => ({ events: [] })),
        inspectVerifiedFact: vi.fn(async () => ({ accepts: [] })),
        buyVerifiedFact: vi.fn(async () => ({ status: 200 })),
        submitProposal: vi.fn(async () => ({ status: 201 })),
        pledge: vi.fn(async () => ({ signature: 'pledge-tx' })),
        donate: vi.fn(async () => ({ signature: 'donate-tx' })),
        forecast: vi.fn(async () => ({ stakeSignature: 'stake-tx' })),
        accept: vi.fn(async () => ({ signature: 'accept-tx' })),
        cancel: vi.fn(async () => ({ signature: 'cancel-tx' })),
        refundDonation: vi.fn(async () => ({ signature: 'refund-tx' })),
        voidPledge: vi.fn(async () => ({ signature: 'void-tx' })),
        revokePledge: vi.fn(async () => ({ signature: 'revoke-tx' })),
        releaseDonations: vi.fn(async () => ({ signature: 'release-tx' })),
        fulfillPledge: vi.fn(async () => ({ signature: 'fulfill-tx' })),
        resolve: vi.fn(async () => ({ signature: 'resolve-tx' })),
        claim: vi.fn(async () => ({ signature: 'claim-tx' })),
        resolveExternal: vi.fn(async () => ({ signature: 'external-resolve-tx' })),
        claimExternal: vi.fn(async () => ({ signature: 'external-claim-tx' }))
    };
}

describe('Urban Game Theory MCP server', () => {
    it('publishes one tool surface for proposal, support, forecast, activity and oracle facts', async () => {
        await connect(stubTools());
        const response = await client.listTools();
        const names = response.tools.map(tool => tool.name);

        expect(names).toEqual([
            'ugt_capabilities', 'ugt_list_proposals', 'ugt_activity', 'ugt_support_status',
            'ugt_oracle_events', 'ugt_inspect_verified_fact', 'ugt_buy_verified_fact',
            'ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast',
            'ugt_cancel_proposal', 'ugt_accept_proposal', 'ugt_refund_donation', 'ugt_void_pledge',
            'ugt_revoke_pledge', 'ugt_release_donations', 'ugt_fulfill_pledge',
            'ugt_resolve_market', 'ugt_claim_market',
            'ugt_resolve_external_market', 'ugt_claim_external_market'
        ]);
        expect(response.tools.find(tool => tool.name === 'ugt_activity').annotations.readOnlyHint).toBe(true);
        expect(response.tools.find(tool => tool.name === 'ugt_donate').annotations.destructiveHint).toBe(true);
    });

    it('validates arguments and returns structured tool output', async () => {
        const tools = stubTools();
        await connect(tools);

        const result = await client.callTool({
            name: 'ugt_list_proposals',
            arguments: { city: 'zagreb', lifecycle: 'Active', limit: 5 }
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ proposals: [], args: { city: 'zagreb', lifecycle: 'Active', limit: 5 } });
        expect(tools.listProposals).toHaveBeenCalledWith({ city: 'zagreb', lifecycle: 'Active', limit: 5 });
    });

    it('requires explicit confirmation in every live tool schema', async () => {
        const tools = stubTools();
        await connect(tools);

        const result = await client.callTool({
            name: 'ugt_donate',
            arguments: { proposalAccount: '11111111111111111111111111111111', amountUsdc: '0.01', operationId: 'once' }
        });

        expect(result.isError).toBe(true);
        expect(tools.donate).not.toHaveBeenCalled();
    });
});
