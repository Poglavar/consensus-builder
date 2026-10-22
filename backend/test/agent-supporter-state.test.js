// The supporter's fresh on-chain eligibility (agents/supporter-state.js) on agreement accounts: one
// batched read of each candidate's market, YES position and pledge commitment (resolved markets and
// existing support are never new attempts), and the re-check of the chosen agreement account right
// before anything is funded or signed.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { cidOfObject } from '../cid.js';
import { assertSupportEligibility, readSupportEligibility } from '../agents/supporter-state.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { agreementAccountInfo } from './fixtures/agreement-account.js';

const require = createRequire(import.meta.url), web3 = require('@solana/web3.js');
const market = require('../../frontend/js/solana/market-client.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
market.configure({ web3 }); pledge.configure({ web3 });

const wallet = Keypair.generate().publicKey.toBase58();
const sponsor = Keypair.generate().publicKey.toBase58();
const cidOf = n => cidOfObject({ schema: 'agreement/v1', title: `Agreement ${n}` });
// discovery.js summaries, open on chain, with no deadline.
const agreements = () => [0, 1, 2].map(n => ({
    cid: cidOf(n), name: `Agreement ${n}`, author: `author-${n}`, sponsor, account: agreementAccountOf(cidOf(n), sponsor),
    deadline: null, chainStatus: 'active'
}));
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
const marketAddress = account => market.getMarketPda(account)[0].toBase58();
const positionAddress = account => market.getPositionPda(market.getMarketPda(account)[0], wallet, 1)[0].toBase58();
const pledgeAddress = account => pledge.getPledgeCommitmentPda(pledge.getPledgeBookPda(account)[0], wallet)[0].toBase58();

describe('supporter on-chain eligibility', () => {
    it('keys every read on the agreement account, excludes a resolved market and existing support, allows a new market', async () => {
        const [a, b] = agreements();
        const connection = rpc(new Map([
            [marketAddress(a.account), owned(marketData(true))],
            [marketAddress(b.account), owned(marketData(false))],
            [positionAddress(b.account), owned(positionData())]
        ]));
        const out = await readSupportEligibility({ connection, wallet, persona, agreements: agreements(), env: { SOLANA_RPC_MAX_ACCOUNTS: '2' } });
        expect(out.closedMarketCids).toEqual([cidOf(0)]);
        expect(out.alreadySupportedCids).toEqual([cidOf(1)]);
        expect(out.agreements.map(item => item.cid)).toEqual([cidOf(1), cidOf(2)]);
        // market, YES position and pledge commitment of three agreements: nine reads, two per request.
        expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 2, 2, 1]);
        expect(connection.getMultipleAccountsInfo.mock.calls[0][0].map(key => key.toBase58())).toEqual([marketAddress(a.account), positionAddress(a.account)]);
    });

    it.each([[0, true], [1, true], [2, false], [3, false]])('treats pledge status %s as supported: %s', async (status, supported) => {
        const [a] = agreements();
        const connection = rpc(new Map([[pledgeAddress(a.account), owned(pledgeData(status), pledge.constants.PROGRAM_ID)]]));
        const out = await readSupportEligibility({ connection, wallet, persona, agreements: [a] });
        expect(out.alreadySupportedCids).toEqual(supported ? [a.cid] : []);
    });

    it('reads nothing for a donation-only policy, and leaves out agreements that are not open', async () => {
        const connection = rpc();
        const list = agreements();
        list[2].chainStatus = 'expired';
        const out = await readSupportEligibility({ connection, wallet, persona: { name: 'supporter', support: { actions: ['donate'] } }, agreements: list });
        expect(out.agreements.map(item => item.cid)).toEqual([cidOf(0), cidOf(1)]);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });

    it.each([
        ['corrupt', owned(Buffer.alloc(4))],
        ['foreign', owned(marketData(false), PublicKey.default.toBase58())]
    ])('fails closed on %s market state', async (_label, bad) => {
        const [a] = agreements();
        await expect(readSupportEligibility({ connection: rpc(new Map([[marketAddress(a.account), bad]])), wallet, persona, agreements: [a] })).rejects.toThrow();
    });

    it('propagates a provider failure rather than treating unreadable accounts as no support', async () => {
        const connection = { getMultipleAccountsInfo: async () => { throw new Error('RPC unavailable'); } };
        await expect(readSupportEligibility({ connection, wallet, persona, agreements: agreements() })).rejects.toThrow('RPC unavailable');
    });
});

describe('re-check before funding or signing', () => {
    const [target] = agreements();
    const decision = type => ({ type, agreementCid: target.cid, account: target.account });
    const accountInfo = (fields = {}) => agreementAccountInfo({ cid: target.cid, authority: sponsor, ...fields });
    const chain = (agreementInfo, marketInfo = null) => ({
        getAccountInfo: vi.fn(async key => (key.toBase58() === target.account ? agreementInfo : key.toBase58() === marketAddress(target.account) ? marketInfo : null))
    });

    it('lets a stake through on an Active agreement whose market is open or not created yet', async () => {
        for (const marketInfo of [null, owned(marketData(false))]) {
            const connection = chain(accountInfo(), marketInfo);
            await expect(assertSupportEligibility({ connection, decision: decision('stake') })).resolves.toBeUndefined();
            expect(connection.getAccountInfo.mock.calls.map(([key]) => key.toBase58())).toEqual([target.account, marketAddress(target.account)]);
        }
    });

    it('reads no market for a pledge or a donation', async () => {
        const connection = chain(accountInfo());
        await assertSupportEligibility({ connection, decision: decision('donate') });
        expect(connection.getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it.each([[1, 'Executed'], [2, 'Cancelled'], [3, 'Expired']])('refuses an agreement that became %s (status %s)', async (status, word) => {
        const connection = chain(accountInfo({ status }), owned(marketData(false)));
        await expect(assertSupportEligibility({ connection, decision: decision('stake') })).rejects.toThrow(new RegExp(`is ${word} on-chain; no action submitted`));
        expect(connection.getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('refuses a missing account, one holding another CID, and a market resolved after selection', async () => {
        await expect(assertSupportEligibility({ connection: chain(null), decision: decision('pledge') })).rejects.toThrow(/has no agreement account/);
        await expect(assertSupportEligibility({ connection: chain(accountInfo({ cid: cidOf(9) })), decision: decision('pledge') })).rejects.toThrow(/has no agreement account/);
        await expect(assertSupportEligibility({ connection: chain(accountInfo(), owned(marketData(true))), decision: decision('stake') })).rejects.toThrow(/market is resolved/);
        const foreign = { ...accountInfo(), owner: PublicKey.default };
        await expect(assertSupportEligibility({ connection: chain(foreign), decision: decision('pledge') })).rejects.toThrow(/another program/);
    });

    it('propagates the RPC failure of the re-check', async () => {
        const connection = { getAccountInfo: vi.fn(async () => { throw new Error('RPC unavailable'); }) };
        await expect(assertSupportEligibility({ connection, decision: decision('donate') })).rejects.toThrow('RPC unavailable');
    });
});
