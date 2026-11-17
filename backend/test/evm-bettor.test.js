import { describe, it, expect, vi } from 'vitest';
import { createEvmBettor } from '../agents/evm-bettor.js';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
const key = `0x${'ab'.repeat(32)}`;
const identity = { chainId: '84532', agreementAccount: key };
describe('EVM bettor and MCP parity', () => {
    it('gates signing and caps buys and market seeds separately', async () => {
        const client = { quoteBudget: vi.fn(async () => ({ shares: 100n })), trade: vi.fn(), open: vi.fn() };
        const adapter = vi.fn(() => client);
        const disabled = createEvmBettor({ env: {}, adapter });
        await expect(disabled.buy({ ...identity, amountUsdc: '0.01', confirm: true })).rejects.toMatchObject({ code: 'live-disabled' });
        expect(adapter).not.toHaveBeenCalled();
        const tools = createEvmBettor({ env: { UGT_MCP_LIVE: '1' }, adapter });
        await expect(tools.buy({ ...identity, amountUsdc: '0.26', confirm: true })).rejects.toMatchObject({ code: 'spend-cap' });
        expect(client.trade).not.toHaveBeenCalled();
        await tools.buy({ ...identity, side: 'yes', amountUsdc: '0.25', confirm: true });
        expect(client.trade).toHaveBeenCalledWith({ key, side: 'yes', shares: 100n, limit: 250000n, action: 'buy' });
        expect(() => tools.open({ ...identity, liquidityUsdc: '5', maxFundingUsdc: '3.6', confirm: true })).toThrow(/cap/);
        await tools.open({ ...identity, liquidityUsdc: '5', maxFundingUsdc: '3.5', confirm: true });
        expect(client.open).toHaveBeenCalledWith({ key, liquidity: 5000000n, maxFunding: 3500000n });
    });
    it('uses the explicit minimum sell return and exposes read, resolve, claim and reclaim', async () => {
        const client = Object.fromEntries(['read', 'quote', 'trade', 'resolve', 'claim', 'reclaim'].map(n => [n, vi.fn(async () => ({ amountAtomic: 20n }))]));
        const tools = createEvmBettor({ env: { UGT_MCP_LIVE: '1' }, adapter: () => client });
        await tools.sell({ ...identity, side: 'no', shares: '1.25', minReturnUsdc: '0.5', confirm: true });
        expect(client.trade).toHaveBeenCalledWith({ key, side: 'no', action: 'sell', shares: 1250000n, limit: 500000n });
        for (const action of ['resolve', 'claim', 'reclaim']) await tools[action]({ ...identity, confirm: true });
        expect(client.resolve).toHaveBeenCalledWith({ key });
        expect(client.claim).toHaveBeenCalledWith({ key, side: undefined });
        expect(client.reclaim).toHaveBeenCalledWith({ key });
    });
    it('advertises exact local schemas and routes existing EVM trade tools through the live gate', async () => {
        const server = createUrbanGameTheoryMcpServer({ tools: {}, env: {} });
        const client = new Client({ name: 'market-test', version: '1' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try {
            await Promise.all([server.connect(a), client.connect(b)]);
            const { tools } = await client.listTools();
            for (const name of ['ugt_agreement_market', 'ugt_quote_agreement_shares', 'ugt_open_agreement_market', 'ugt_reclaim_market_seed']) expect(tools.some(t => t.name === name)).toBe(true);
            for (const [name, extra] of [
                ['ugt_buy_agreement_shares_on_account', { side: 'yes', amountUsdc: '0.1' }],
                ['ugt_sell_agreement_shares', { side: 'no', shares: '1' }],
                ['ugt_resolve_market', {}], ['ugt_claim_market', { side: 'yes' }],
                ['ugt_open_agreement_market', { liquidityUsdc: '5', maxFundingUsdc: '3.5' }], ['ugt_reclaim_market_seed', {}]
            ]) {
                const result = await client.callTool({ name, arguments: { ...identity, ...extra, confirm: true } });
                expect(result.isError).toBe(true);
                expect(result.structuredContent.code).toBe('live-disabled');
            }
            const bad = await client.callTool({ name: 'ugt_resolve_market', arguments: { agreementAccount: key, confirm: true } });
            expect(bad.structuredContent.code).toBe('invalid-arguments');
        } finally { await client.close(); await server.close(); }
    });
});
