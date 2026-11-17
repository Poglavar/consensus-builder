import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { createEvmBettor } from '../agents/evm-bettor.js';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { localMarketChain } from './helpers/evm-market-chain.cjs';
const require = createRequire(import.meta.url);
const Markets = require('../../frontend/js/chain/evm-markets.js');
let chain;
beforeAll(async () => { chain = await localMarketChain(); }, 60000);
afterAll(async () => { await chain?.close(); });
describe('EVM adapter against real Gnosis contracts', () => {
    it('runs the existing MCP buy and sell tools against the real chain and validates read outputs', async () => {
        const a = await chain.createAgreement();
        await chain.adapter(chain.sponsor).open({ key: a.key, liquidity: '5000000', maxFunding: '3500000' });
        const evmMarketTools = createEvmBettor({ env: { UGT_MCP_LIVE: '1' }, adapter: () => chain.adapter(chain.trader) });
        const server = createUrbanGameTheoryMcpServer({ tools: {}, env: {}, evmMarketTools });
        const client = new Client({ name: 'market-integration', version: '1' });
        const [left, right] = InMemoryTransport.createLinkedPair();
        const identity = { chainId: '31337', agreementAccount: a.key };
        try {
            await Promise.all([server.connect(left), client.connect(right)]);
            const inspected = await client.callTool({ name: 'ugt_agreement_market', arguments: identity });
            expect(inspected.isError).not.toBe(true);
            expect(inspected.structuredContent.agreementStatus).toBe('active');
            const quote = await client.callTool({ name: 'ugt_quote_agreement_shares', arguments: { ...identity, side: 'no', shares: '0.1' } });
            expect(quote.isError).not.toBe(true);
            expect(BigInt(quote.structuredContent.amountAtomic)).toBeGreaterThan(0n);
            const bought = await client.callTool({ name: 'ugt_buy_agreement_shares_on_account', arguments: { ...identity, side: 'yes', amountUsdc: '0.1', confirm: true } });
            expect(bought.isError).not.toBe(true);
            const boughtShares = BigInt(bought.structuredContent.positions.yes);
            expect(boughtShares).toBeGreaterThan(100000n);
            const sold = await client.callTool({ name: 'ugt_sell_agreement_shares', arguments: { ...identity, side: 'yes', shares: '0.1', confirm: true } });
            expect(sold.isError).not.toBe(true);
            expect(BigInt(sold.structuredContent.positions.yes)).toBe(boughtShares - 100000n);
        } finally { await client.close(); await server.close(); }
    }, 60000);

    it('buys both sides, sells with a negative limit, settles YES and redeems after sponsor reclaim', async () => {
        const a = await chain.createAgreement(), sponsor = chain.adapter(chain.sponsor), trader = chain.adapter(chain.trader);
        const opened = await sponsor.open({ key: a.key, liquidity: '5000000', maxFunding: '3500000' });
        expect(opened.funding).toBe(3465736n);
        expect(opened.chanceYes).toBeCloseTo(0.5);
        const who = await chain.trader.getAddress();
        const before = await chain.token.balanceOf(who);
        const quote = await trader.quoteBudget({ key: a.key, side: 'yes', budget: '250000' });
        expect(quote.amountAtomic).toBeLessThanOrEqual(250000n);
        const status = [];
        let read = await trader.trade({ ...quote, limit: '250000', onStatus: event => status.push(event) });
        expect(read.positions.yes).toBe(quote.shares);
        expect(status.filter(s => s.state === 'confirmed').map(s => s.operation)).toEqual(['approve', 'trade']);
        expect(before - await chain.token.balanceOf(who)).toBe(quote.amountAtomic);
        const no = await trader.quote({ key: a.key, side: 'no', shares: '100000' });
        await trader.trade({ ...no, limit: no.amountAtomic });
        const sale = await trader.quote({ key: a.key, side: 'yes', shares: '100000', action: 'sell' });
        read = await trader.trade({ ...sale, limit: sale.amountAtomic });
        expect(read.positions.yes).toBe(quote.shares - 100000n);
        await chain.execute(a);
        await expect(trader.quote({ key: a.key, side: 'no', shares: '1' })).rejects.toMatchObject({ code: 'market-closed' });
        expect((await trader.resolve({ key: a.key })).outcome).toBe('yes');
        expect((await sponsor.reclaim({ key: a.key })).reclaimed).toBe(true);
        const balance = await chain.token.balanceOf(who);
        const claimed = await trader.claim({ key: a.key });
        expect(claimed.positions).toEqual({ yes: 0n, no: 0n });
        expect(await chain.token.balanceOf(who) - balance).toBe(quote.shares - 100000n);
    }, 60000);
    it('refuses overspending, slippage, overselling and wrong networks before signing', async () => {
        const a = await chain.createAgreement(), sponsor = chain.adapter(chain.sponsor), trader = chain.adapter(chain.trader);
        await expect(trader.open({ key: a.key, liquidity: '5000000', maxFunding: '3500000' })).rejects.toMatchObject({ code: 'not-sponsor' });
        await expect(sponsor.open({ key: a.key, liquidity: '5000000', maxFunding: '1' })).rejects.toMatchObject({ code: 'funding-cap' });
        await sponsor.open({ key: a.key, liquidity: '5000000', maxFunding: '3500000' });
        const nonce = await chain.provider.getTransactionCount(await chain.trader.getAddress());
        await expect(trader.trade({ key: a.key, side: 'yes', shares: '1000000', action: 'buy', limit: '1' })).rejects.toMatchObject({ code: 'slippage' });
        await expect(trader.trade({ key: a.key, side: 'no', shares: '1000000', action: 'sell', limit: '1' })).rejects.toMatchObject({ code: 'insufficient-shares' });
        expect(await chain.provider.getTransactionCount(await chain.trader.getAddress())).toBe(nonce);
        const wrong = Markets.create({ ethers, provider: chain.provider, chainId: 84532, addresses: chain.addresses });
        await expect(wrong.read(a.key)).rejects.toMatchObject({ code: 'wrong-chain' });
        expect(() => Markets.create({ ethers, provider: chain.provider, chainId: 84532, addresses: {} })).toThrow(/not configured/);
        expect(() => Markets.amounts('maybe', '1', 'buy')).toThrow();
        expect(() => Markets.atomic(null)).toThrow();
    }, 60000);
    it('cancellation pays NO and expiration can be settled permissionlessly', async () => {
        for (const cancelled of [true, false]) {
            const a = await chain.createAgreement(30), sponsor = chain.adapter(chain.sponsor), trader = chain.adapter(chain.trader);
            await sponsor.open({ key: a.key, liquidity: '5000000', maxFunding: '3500000' });
            const quote = await trader.quote({ key: a.key, side: 'no', shares: '100000' });
            await trader.trade({ ...quote, limit: quote.amountAtomic });
            if (cancelled) await (await chain.agreement.cancel(a.key)).wait();
            else { await chain.provider.send('evm_setNextBlockTimestamp', [a.deadline + 1]); await chain.provider.send('evm_mine', []); }
            expect((await trader.resolve({ key: a.key })).outcome).toBe('no');
            const balance = await chain.token.balanceOf(await chain.trader.getAddress());
            await trader.claim({ key: a.key, side: 'no' });
            expect(await chain.token.balanceOf(await chain.trader.getAddress()) - balance).toBe(100000n);
        }
    }, 60000);
});
