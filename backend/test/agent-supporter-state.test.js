// The supporter's fresh on-chain eligibility (agents/supporter-state.js) on agreement accounts: each
// candidate's sponsor-bound LMSR market and YES position read through the genesis-verified agreement
// chain, pledge commitments in batches (resolved markets and existing support are never new attempts),
// and the re-check of the chosen agreement account right before anything is funded or signed.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { cidOfObject } from '../cid.js';
import { assertSupportEligibility, readSupportEligibility } from '../agents/supporter-state.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { AGREEMENT_PROGRAM_ID, DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { encodeAgreementAccount, lmsrMarketAccount, lmsrPositionAccount, pledgeCommitmentAccount } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url), web3 = require('@solana/web3.js');
const market = require('../../frontend/js/solana/lmsr-client.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
market.configure({ web3 }); pledge.configure({ web3 });

const wallet = Keypair.generate().publicKey.toBase58();
const sponsor = Keypair.generate().publicKey.toBase58();
const lens = Keypair.generate().publicKey.toBase58();
const DEADLINE = Math.floor(Date.now() / 1000) + 3600;
const cidOf = n => cidOfObject({ schema: 'agreement/v1', title: `Agreement ${n}` });
// discovery.js summaries, open on chain.
const agreements = () => [0, 1, 2].map(n => ({
    cid: cidOf(n), name: `Agreement ${n}`, author: `author-${n}`, sponsor, account: agreementAccountOf(cidOf(n), sponsor),
    deadline: null, chainStatus: 'active'
}));
const persona = { name: 'supporter', support: { actions: ['stake', 'pledge', 'donate'] } };
const marketAddress = account => market.getMarketPda(account, sponsor)[0].toBase58();
// The agreement account as the program holds it (status 0 Active … 3 Expired).
const agreementEntry = (cid, fields = {}) => ({ address: agreementAccountOf(cid, sponsor), owner: AGREEMENT_PROGRAM_ID,
    data: encodeAgreementAccount({ cid, authority: sponsor, lens, payout: sponsor, deadline: DEADLINE, status: 0, ...fields }) });
const marketEntry = (account, resolved = false) => lmsrMarketAccount({ agreement: account, sponsor, closesAt: DEADLINE, resolved });
const yesPosition = account => lmsrPositionAccount({ market: marketAddress(account), owner: wallet, side: market.constants.SIDE_YES, amount: 100000n });

// A devnet connection over `entries` ({ address, owner, data }): the agreement chain's batched reads,
// the pledge batches and the single position reads, each recorded.
function rpc(entries = [], { genesis = DEVNET_GENESIS_HASH } = {}) {
    const accounts = new Map(entries.map(entry => [entry.address, entry]));
    const info = key => {
        const entry = accounts.get(typeof key === 'string' ? key : key.toBase58());
        return entry ? { owner: new PublicKey(entry.owner), data: Buffer.from(entry.data), lamports: 1_000_000, executable: false } : null;
    };
    return {
        getGenesisHash: vi.fn(async () => genesis),
        getMultipleAccountsInfoAndContext: vi.fn(async keys => ({ context: { slot: 1 }, value: keys.map(info) })),
        getMultipleAccountsInfo: vi.fn(async keys => keys.map(info)),
        getAccountInfo: vi.fn(async key => info(key))
    };
}
const minted = list => list.map(item => agreementEntry(item.cid));

describe('supporter on-chain eligibility', () => {
    it('keys every read on the agreement account, excludes a resolved market and existing support, allows a new market', async () => {
        const list = agreements();
        const [a, b] = list;
        const connection = rpc([...minted(list), marketEntry(a.account, true), marketEntry(b.account), yesPosition(b.account)]);
        const out = await readSupportEligibility({ connection, wallet, persona, agreements: list, env: { SOLANA_RPC_MAX_ACCOUNTS: '2' } });
        expect(out.closedMarketCids).toEqual([cidOf(0)]);
        expect(out.alreadySupportedCids).toEqual([cidOf(1)]);
        expect(out.agreements.map(item => item.cid)).toEqual([cidOf(1), cidOf(2)]);
        // Every agreement account is read under the verified cluster, its market at the sponsor-bound PDA.
        const chainReads = connection.getMultipleAccountsInfoAndContext.mock.calls.map(([keys]) => keys.map(key => key.toBase58()));
        expect(chainReads.flat()).toEqual(expect.arrayContaining(list.map(item => item.account)));
        const marketReads = connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.map(key => key.toBase58()));
        expect(marketReads.flat()).toEqual(expect.arrayContaining(list.map(item => marketAddress(item.account))));
        // The pledge commitments of three agreements, two per request.
        const pledgeAddress = account => pledge.getPledgeCommitmentPda(pledge.getPledgeBookPda(account)[0], wallet)[0].toBase58();
        expect(marketReads.slice(-2)).toEqual([[pledgeAddress(a.account), pledgeAddress(b.account)], [pledgeAddress(list[2].account)]]);
        expect(connection.getGenesisHash).toHaveBeenCalled();
    });

    it.each([[0, true], [1, true], [2, false], [3, false]])('treats pledge status %s as supported: %s', async (status, supported) => {
        const [a] = agreements();
        const connection = rpc([pledgeCommitmentAccount({ agreement: a.account, owner: wallet, status })]);
        const out = await readSupportEligibility({ connection, wallet, persona: { name: 'supporter', support: { actions: ['pledge'] } }, agreements: [a] });
        expect(out.alreadySupportedCids).toEqual(supported ? [a.cid] : []);
    });

    it('reads nothing for a donation-only policy, and leaves out agreements that are not open', async () => {
        const connection = rpc();
        const list = agreements();
        list[2].chainStatus = 'expired';
        const out = await readSupportEligibility({ connection, wallet, persona: { name: 'supporter', support: { actions: ['donate'] } }, agreements: list });
        expect(out.agreements.map(item => item.cid)).toEqual([cidOf(0), cidOf(1)]);
        expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
        expect(connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
    });

    it.each([
        ['corrupt', account => ({ ...marketEntry(account), data: new Uint8Array(4) }), /./],
        ['foreign', account => ({ ...marketEntry(account), owner: PublicKey.default.toBase58() }), /another program/],
        ['off-contract', account => lmsrMarketAccount({ agreement: account, sponsor, closesAt: DEADLINE + 1 }), /canonical LMSR contract/]
    ])('fails closed on %s market state', async (_label, bad, message) => {
        const [a] = agreements();
        await expect(readSupportEligibility({ connection: rpc([agreementEntry(a.cid), bad(a.account)]), wallet, persona, agreements: [a] })).rejects.toThrow(message);
    });

    it('refuses an RPC of another cluster and a candidate with no agreement account', async () => {
        const [a] = agreements();
        await expect(readSupportEligibility({ connection: rpc([agreementEntry(a.cid)], { genesis: 'mainnet-genesis' }), wallet, persona, agreements: [a] }))
            .rejects.toMatchObject({ code: 'rpc-wrong-cluster' });
        await expect(readSupportEligibility({ connection: rpc(), wallet, persona, agreements: [a] }))
            .rejects.toMatchObject({ code: 'AGREEMENT_UNAVAILABLE' });
    });

    it('propagates a provider failure rather than treating unreadable accounts as no support', async () => {
        const connection = { ...rpc(), getMultipleAccountsInfoAndContext: async () => { throw new Error('RPC unavailable'); } };
        await expect(readSupportEligibility({ connection, wallet, persona, agreements: agreements() })).rejects.toThrow('RPC unavailable');
        const pledges = { ...rpc(), getMultipleAccountsInfo: async () => { throw new Error('RPC unavailable'); } };
        await expect(readSupportEligibility({ connection: pledges, wallet, persona: { name: 'supporter', support: { actions: ['pledge'] } }, agreements: agreements() }))
            .rejects.toThrow('RPC unavailable');
    });
});

describe('re-check before funding or signing', () => {
    const [target] = agreements();
    const decision = type => ({ type, agreementCid: target.cid, account: target.account });

    it('lets a stake through on an Active agreement whose market is open or not created yet', async () => {
        for (const entries of [[agreementEntry(target.cid)], [agreementEntry(target.cid), marketEntry(target.account)]]) {
            await expect(assertSupportEligibility({ connection: rpc(entries), decision: decision('stake') })).resolves.toBeUndefined();
        }
    });

    it('re-reads the agreement and its market for a pledge or a donation too', async () => {
        const connection = rpc([agreementEntry(target.cid)]);
        await assertSupportEligibility({ connection, decision: decision('donate') });
        expect(connection.getMultipleAccountsInfoAndContext.mock.calls.map(([keys]) => keys.map(key => key.toBase58()))).toEqual([[target.account]]);
        expect(connection.getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.map(key => key.toBase58()))).toEqual([[marketAddress(target.account)]]);
    });

    it.each([[1, 'Executed'], [2, 'Cancelled'], [3, 'Expired']])('refuses an agreement that became %s (status %s)', async (status, word) => {
        const connection = rpc([agreementEntry(target.cid, { status }), marketEntry(target.account)]);
        await expect(assertSupportEligibility({ connection, decision: decision('stake') })).rejects.toThrow(new RegExp(`is ${word} on-chain; no action submitted`));
    });

    it('refuses a missing account, one holding another CID, one of another program, and a market resolved after selection', async () => {
        await expect(assertSupportEligibility({ connection: rpc(), decision: decision('pledge') })).rejects.toThrow(/account is unavailable \(missing\)/);
        const otherCid = { ...agreementEntry(cidOf(9)), address: target.account };
        await expect(assertSupportEligibility({ connection: rpc([otherCid]), decision: decision('pledge') })).rejects.toThrow(/does not match its canonical chain account/);
        const foreign = { ...agreementEntry(target.cid), owner: PublicKey.default.toBase58() };
        await expect(assertSupportEligibility({ connection: rpc([foreign]), decision: decision('pledge') })).rejects.toThrow(/account is unavailable \(wrong-program\)/);
        await expect(assertSupportEligibility({ connection: rpc([agreementEntry(target.cid), marketEntry(target.account, true)]), decision: decision('stake') }))
            .rejects.toThrow(/market is resolved/);
    });

    it('propagates the RPC failure of the re-check', async () => {
        const connection = { ...rpc(), getMultipleAccountsInfoAndContext: vi.fn(async () => { throw new Error('RPC unavailable'); }) };
        await expect(assertSupportEligibility({ connection, decision: decision('donate') })).rejects.toThrow('RPC unavailable');
    });
});
