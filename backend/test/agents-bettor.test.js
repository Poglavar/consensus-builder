import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buyAgreementShares, sellAgreementShares, readAgreementMarket, usdcToAtomic, DEFAULT_B, openAgreementMarket, MARKET_SEED_ATOMIC } from '../agents/bettor.js';
import { agreementAccountOf, AGREEMENT_PROGRAM_ID, DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { encodeAgreementAccount, lmsrPositionAccount } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const market = require('../../frontend/js/solana/lmsr-client.js');
const lmsr = require('../../frontend/js/bets/lmsr.js');
const contract = require('../../frontend/js/bets/betting-contract.js');
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const NOW = Math.floor(Date.now() / 1000);

function encodeMarket({ account, sponsor, deadline, qYes = 0n, qNo = 0n, b = DEFAULT_B, resolved = false }) {
    const [address] = market.getMarketPda(account, sponsor);
    const data = Buffer.alloc(market.MARKET_SIZE);
    Buffer.from(market.ACCOUNT_DISCRIMINATORS.LmsrMarket).copy(data, 0);
    data[8] = 0;
    new PublicKey(account).toBuffer().copy(data, 9);
    new PublicKey(sponsor).toBuffer().copy(data, 41);
    new PublicKey(mint).toBuffer().copy(data, 73);
    market.getVaultAddress(address, mint).toBuffer().copy(data, 105);
    data.writeBigUInt64LE(b, 137);
    data.writeBigUInt64LE(qYes, 145);
    data.writeBigUInt64LE(qNo, 153);
    data.writeBigUInt64LE(lmsr.maxLoss(b), 161);
    data.writeBigInt64LE(BigInt(deadline), 169);
    data.writeUInt32LE(0, 177);
    data.writeBigUInt64LE(0n, 181);
    data[413] = resolved ? 1 : 0;
    return { address, data: new Uint8Array(data), owner: market.constants.PROGRAM_ID };
}

function setup({ signer = Keypair.generate(), sponsor = Keypair.generate(), lens = Keypair.generate(), withMarket = true, wrongNetwork = false, qYes = 0n, b = DEFAULT_B } = {}) {
    const deadline = NOW + 3600;
    const cid = `bafybeigdyrzt5sfp7udm7hu76uhy26nf3nqg4o3x2kpcew7saf4r5x4sfu`;
    const subject = agreementAccountOf(cid, sponsor.publicKey.toBase58());
    const records = new Map();
    records.set(subject, { data: encodeAgreementAccount({ cid, authority: sponsor.publicKey.toBase58(), lens: lens.publicKey.toBase58(), payout: sponsor.publicKey.toBase58(), deadline, status: 0 }), owner: AGREEMENT_PROGRAM_ID });
    if (withMarket) {
        const entry = encodeMarket({ account: subject, sponsor: sponsor.publicKey.toBase58(), deadline, qYes, b });
        records.set(entry.address.toBase58(), entry);
    }
    records.set(subject, { ...records.get(subject), owner: new PublicKey(AGREEMENT_PROGRAM_ID) });
    const sends = [];
    const connection = {
        getGenesisHash: async () => wrongNetwork ? 'mainnet-genesis' : DEVNET_GENESIS_HASH,
        getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 1 }, value: addresses.map(key => records.get(key.toBase58()) || null) }),
        getMultipleAccountsInfo: async addresses => addresses.map(key => records.get(key.toBase58()) || null),
        getAccountInfo: async key => records.get(key.toBase58()) || null,
        getSlot: async () => 1,
        getBlockTime: async () => NOW
    };
    const sendAndConfirm = async (_connection, transaction, signers, options) => {
        sends.push({ transaction, signers, options });
        return 'signature-1';
    };
    return { signer, sponsor, lens, subject, deadline, connection, sends, sendAndConfirm, records };
}

describe('agent LMSR buy path', () => {
    it('turns an exact USDC budget into quoted shares and submits a bounded buy', async () => {
        const h = setup();
        const budget = usdcToAtomic('0.25');
        const [address] = market.getMarketPda(h.subject, h.sponsor.publicKey.toBase58());
        const quote = contract.quote({ model: 'lmsr', b: DEFAULT_B, qYes: 0n, qNo: 0n, closesAt: h.deadline, graceSeconds: 0 }, 'yes', budget);
        const result = await buyAgreementShares({ connection: h.connection, ownerKeypair: h.signer, subject: h.subject, side: market.constants.SIDE_YES, amountAtomic: budget, sendAndConfirm: h.sendAndConfirm });
        expect(result).toMatchObject({ marketPda: address.toBase58(), signature: 'signature-1', shares: quote.shares, quotedCost: quote.amount, maxCost: quote.maxCost });
        expect(h.sends).toHaveLength(1);
        const ix = h.sends[0].transaction.instructions.at(-1);
        expect(ix.programId.toBase58()).toBe(market.constants.PROGRAM_ID);
        expect(Array.from(ix.data.slice(0, 8))).toEqual(market.IX_DISCRIMINATORS.buy);
        expect(ix.data[8]).toBe(market.constants.SIDE_YES);
        expect(Buffer.from(ix.data).readBigUInt64LE(9)).toBe(quote.shares);
        expect(Buffer.from(ix.data).readBigUInt64LE(17)).toBe(quote.maxCost);
    });

    it('trades a market opened before 2026-10-30 at its own b = 100 and rejects any other b', async () => {
        const legacyB = 100_000_000n, budget = usdcToAtomic('0.25');
        const h = setup({ b: legacyB });
        const quote = contract.quote({ model: 'lmsr', b: legacyB, qYes: 0n, qNo: 0n, closesAt: h.deadline, graceSeconds: 0 }, 'yes', budget);
        const result = await buyAgreementShares({ connection: h.connection, ownerKeypair: h.signer, subject: h.subject, side: market.constants.SIDE_YES, amountAtomic: budget, sendAndConfirm: h.sendAndConfirm });
        expect(result).toMatchObject({ shares: quote.shares, maxCost: quote.maxCost });
        expect(quote.shares).not.toBe(contract.quote({ model: 'lmsr', b: DEFAULT_B, qYes: 0n, qNo: 0n, closesAt: h.deadline, graceSeconds: 0 }, 'yes', budget).shares);
        const odd = setup({ b: 7_000_000n });
        await expect(readAgreementMarket(odd.connection, odd.subject)).rejects.toMatchObject({ code: 'MARKET_TERMS_MISMATCH' });
    });

    it('never creates a missing market and reports MARKET_NOT_OPEN', async () => {
        const h = setup({ withMarket: false });
        await expect(buyAgreementShares({ connection: h.connection, ownerKeypair: h.signer, subject: h.subject, side: 1, amountAtomic: 1n, sendAndConfirm: h.sendAndConfirm }))
            .rejects.toMatchObject({ code: 'MARKET_NOT_OPEN' });
        expect(h.sends).toHaveLength(0);
    });

    it('sells only held shares with the quoted minimum return', async () => {
        const h = setup({ qYes: 500_000n });
        const [address] = market.getMarketPda(h.subject, h.sponsor.publicKey.toBase58());
        const held = lmsrPositionAccount({ market: address, owner: h.signer.publicKey, side: market.constants.SIDE_YES, amount: 500_000n });
        h.records.set(held.address, { data: held.data, owner: market.constants.PROGRAM_ID });
        const quote = contract.quote({ model: 'lmsr', b: DEFAULT_B, qYes: 500_000n, qNo: 0n, closesAt: h.deadline, graceSeconds: 0 }, 'yes', 250_000n, 'sell');
        const result = await sellAgreementShares({ connection: h.connection, ownerKeypair: h.signer, subject: h.subject, side: 'yes', sharesAtomic: 250_000n, sendAndConfirm: h.sendAndConfirm });
        expect(result).toMatchObject({ signature: 'signature-1', shares: 250_000n, minReturn: quote.minReturn });
        const ix = h.sends[0].transaction.instructions.at(-1);
        expect(Array.from(ix.data.slice(0, 8))).toEqual(market.IX_DISCRIMINATORS.sell);
        expect(Buffer.from(ix.data).readBigUInt64LE(9)).toBe(250_000n);
        expect(Buffer.from(ix.data).readBigUInt64LE(17)).toBe(quote.minReturn);
    });

    it('bars both sponsor and lens and refuses a non-devnet RPC', async () => {
        const sponsor = Keypair.generate();
        const h = setup({ sponsor, signer: sponsor });
        await expect(buyAgreementShares({ connection: h.connection, ownerKeypair: h.signer, subject: h.subject, side: 1, amountAtomic: 1n, sendAndConfirm: h.sendAndConfirm }))
            .rejects.toMatchObject({ code: 'INSIDER_TRADE' });
        const lens = Keypair.generate();
        const h2 = setup({ lens, signer: lens });
        await expect(buyAgreementShares({ connection: h2.connection, ownerKeypair: lens, subject: h2.subject, side: 1, amountAtomic: 1n, sendAndConfirm: h2.sendAndConfirm }))
            .rejects.toMatchObject({ code: 'INSIDER_TRADE' });
        const h3 = setup({ wrongNetwork: true });
        await expect(readAgreementMarket(h3.connection, h3.subject)).rejects.toMatchObject({ code: 'rpc-wrong-cluster' });
        expect(h.sends).toHaveLength(0);
        expect(h2.sends).toHaveLength(0);
    });

    it('parses exact six-decimal budgets and rejects floats or excess precision', () => {
        expect(usdcToAtomic('0.25')).toBe(250000n);
        expect(usdcToAtomic('0.000001')).toBe(1n);
        expect(() => usdcToAtomic(0.25)).toThrow(/STRING/);
        expect(() => usdcToAtomic('0.1234567')).toThrow(/six decimals/);
    });
});

describe('sponsor canonical market opening', () => {
    it('opens the canonical market once with bounded seed and replays an existing market without funding', async () => {
        const sponsor = Keypair.generate();
        const h = setup({ sponsor, signer: sponsor, withMarket: false });
        let funded = 0;
        const options = { connection: h.connection, sponsorKeypair: sponsor, subject: h.subject,
            maxSeedAtomic: 3_500_000n, ensureSeed: async amount => { funded++; expect(amount).toBe(3_465_737n); },
            readSeedBalance: async () => MARKET_SEED_ATOMIC, sendAndConfirm: h.sendAndConfirm };
        const result = await openAgreementMarket(options);
        expect(result).toMatchObject({ replayed: false, signature: 'signature-1', seedAtomic: '3465737' });
        expect(h.sends).toHaveLength(1); expect(funded).toBe(1);
        // A new market opens with b = 5 devnet USDC, the liquidity that follows the instruction discriminator.
        expect(Buffer.from(h.sends[0].transaction.instructions[0].data).readBigUInt64LE(8)).toBe(5_000_000n);
        expect(h.sends[0].transaction.instructions[0].keys.some(k => k.pubkey.toBase58() === h.subject)).toBe(true);
        const encoded = encodeMarket({ account: h.subject, sponsor: sponsor.publicKey.toBase58(), deadline: h.deadline });
        h.records.set(encoded.address.toBase58(), encoded);
        expect(await openAgreementMarket({ ...options, maxSeedAtomic: 0n,
            ensureSeed: async () => { throw new Error('must not fund twice'); } })).toMatchObject({ replayed: true, signature: null });
        expect(h.sends).toHaveLength(1);
    });
    it('refuses non-sponsors, missing seed and cap overruns without a transaction', async () => {
        const h = setup({ withMarket: false });
        const base = { connection: h.connection, subject: h.subject, sponsorKeypair: h.sponsor,
            maxSeedAtomic: 70_000_000n, readSeedBalance: async () => 0n, sendAndConfirm: h.sendAndConfirm };
        await expect(openAgreementMarket({ ...base, sponsorKeypair: h.signer })).rejects.toMatchObject({ code: 'NOT_SPONSOR' });
        await expect(openAgreementMarket({ ...base, maxSeedAtomic: 350_000n })).rejects.toMatchObject({ code: 'MARKET_SEED_CAP' });
        await expect(openAgreementMarket(base)).rejects.toMatchObject({ code: 'INSUFFICIENT_USDC' });
        expect(h.sends).toEqual([]);
    });
    it('rejects wrong-network and past-deadline agreements before funding', async () => {
        const wrong = setup({ withMarket: false, wrongNetwork: true });
        await expect(openAgreementMarket({ connection: wrong.connection, subject: wrong.subject, sponsorKeypair: wrong.sponsor,
            maxSeedAtomic: 70_000_000n })).rejects.toThrow(/devnet|genesis/i);
        const past = setup({ withMarket: false }); past.connection.getBlockTime = async () => past.deadline + 1;
        await expect(openAgreementMarket({ connection: past.connection, subject: past.subject, sponsorKeypair: past.sponsor,
            maxSeedAtomic: 70_000_000n })).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
    });
});
