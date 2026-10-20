import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readSupportEligibility, assertSupportEligibility } from '../agents/supporter-state.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';
import { PROPOSAL_PROGRAM_ID } from '../agents/lifecycle-actions.js';

const require = createRequire(import.meta.url), web3 = require('@solana/web3.js');
const market = require('../../frontend/js/solana/market-client.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
market.configure({ web3 }); pledge.configure({ web3 });
const addresses = [PROPOSAL_PROGRAM_ID, market.constants.PROGRAM_ID, pledge.constants.PROGRAM_ID];
const wallet = PublicKey.default.toBase58();
const rows = () => addresses.map((address, index) => ({ proposalId: `p-${index}`, lifecycleStatus: 'Active', onchain: { proposalId: address } }));
const persona = { name: 'supporter', support: { actions: ['stake', 'pledge', 'donate'] } };
const owned = (data, program = market.constants.PROGRAM_ID) => ({ data, owner: new PublicKey(program) });
function marketData(resolved) {
    const b = Buffer.alloc(market.MARKET_SIZE); b.set(market.ACCOUNT_DISCRIMINATORS.Market); b[120] = resolved ? 1 : 0; return b;
}
function positionData() {
    const b = Buffer.alloc(market.POSITION_SIZE); b.set(market.ACCOUNT_DISCRIMINATORS.Position); b.writeBigUInt64LE(100000n, 73); return b;
}
function pledgeData(status) {
    const b = Buffer.alloc(pledge.PLEDGE_COMMITMENT_SIZE); b.set(pledge.ACCOUNT_DISCRIMINATORS.PledgeCommitment); b[112] = status; return b;
}
function rpc(accounts = new Map()) {
    return { getMultipleAccountsInfo: vi.fn(async keys => keys.map(key => accounts.get(key.toBase58()) || null)) };
}
const marketAddress = address => market.getMarketPda(address)[0].toBase58();
const positionAddress = address => market.getPositionPda(market.getMarketPda(address)[0], wallet, 1)[0].toBase58();
const pledgeAddress = address => pledge.getPledgeCommitmentPda(pledge.getPledgeBookPda(address)[0], wallet)[0].toBase58();

describe('supporter on-chain eligibility', () => {
    it('excludes a resolved market and existing support while allowing a new market', async () => {
        const connection = rpc(new Map([
            [marketAddress(addresses[0]), owned(marketData(true))],
            [marketAddress(addresses[1]), owned(marketData(false))],
            [positionAddress(addresses[1]), owned(positionData())]
        ]));
        const out = await readSupportEligibility({ connection, wallet, persona, proposals: rows(), env: { SOLANA_RPC_MAX_ACCOUNTS: '2' } });
        expect(out.closedMarketIds).toEqual(['p-0']);
        expect(out.alreadySupportedIds).toEqual(['p-1']);
        expect(out.proposals.map(p => p.proposalId)).toEqual(['p-1', 'p-2']);
        expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 2, 2, 1]);
        expect(connection.getAccountInfo).toBeUndefined();
    });

    it.each([0, 1, 2, 3])('preserves pledge status %s semantics', async status => {
        const connection = rpc(new Map([[pledgeAddress(addresses[0]), owned(pledgeData(status), pledge.constants.PROGRAM_ID)]]));
        const out = await readSupportEligibility({ connection, wallet, persona, proposals: rows().slice(0, 1) });
        expect(out.alreadySupportedIds).toEqual(status < 2 ? ['p-0'] : []);
    });

    it('does not request markets for a donation-only policy', async () => {
        const connection = rpc();
        const out = await readSupportEligibility({ connection, wallet, persona: { name: 'supporter', support: { actions: ['donate'] } }, proposals: rows() });
        expect(out.proposals).toHaveLength(3);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });

    it.each([owned(Buffer.alloc(4)), owned(marketData(false), PublicKey.default.toBase58())])('fails closed on corrupt or foreign market state', async bad => {
        await expect(readSupportEligibility({ connection: rpc(new Map([[marketAddress(addresses[0]), bad]])), wallet, persona, proposals: rows() })).rejects.toThrow();
    });

    it('rechecks an expired selection before reading its stake market', async () => {
        const connection = { getMultipleAccountsInfo: vi.fn(async () => [owned(proposalAccountBytes({ status: 3 }), PROPOSAL_PROGRAM_ID)]), getAccountInfo: vi.fn() };
        await expect(assertSupportEligibility({ connection, decision: { type: 'donate', proposalId: 'p-0', proposalAccount: addresses[0] } })).rejects.toThrow(/Expired on-chain/);
        expect(connection.getAccountInfo).not.toHaveBeenCalled();
    });

    it('refuses a market resolved after selection', async () => {
        const connection = { getMultipleAccountsInfo: async () => [owned(proposalAccountBytes(), PROPOSAL_PROGRAM_ID)], getAccountInfo: vi.fn(async () => owned(marketData(true))) };
        await expect(assertSupportEligibility({ connection, decision: { type: 'stake', proposalId: 'p-0', proposalAccount: addresses[0] } })).rejects.toThrow(/market is resolved/);
    });

    it('permits a new stake market after confirming an active proposal', async () => {
        const connection = { getMultipleAccountsInfo: async () => [owned(proposalAccountBytes(), PROPOSAL_PROGRAM_ID)], getAccountInfo: vi.fn(async () => null) };
        await expect(assertSupportEligibility({ connection, decision: { type: 'stake', proposalId: 'p-0', proposalAccount: addresses[0] } })).resolves.toBeUndefined();
    });

    it('propagates provider failure rather than treating unreadable accounts as no support', async () => {
        const connection = { getMultipleAccountsInfo: async () => { throw new Error('RPC unavailable'); } };
        await expect(readSupportEligibility({ connection, wallet, persona, proposals: rows() })).rejects.toThrow('RPC unavailable');
    });
});
