// Unit tests for agents/bettor.js — the persona's stake on its own proposal's market.
// The connection is stubbed both ways (no market yet → create + stake; market present → stake
// only) and every instruction the module sends is checked against blockchain/solana/idl/
// proposal_market.json: program id, account order, and each account's signer/writable flag.
// usdcToAtomic is pure string arithmetic and is pinned to the exact atomic values.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMarketAndStake, usdcToAtomic } from '../agents/bettor.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const marketClient = require('../../frontend/js/solana/market-client.js');
const { Keypair, PublicKey } = web3;

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_market.json'), 'utf8'));
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIDE_YES = 1;
const SIDE_NO = 0;

const PROPOSAL_PDA = Keypair.generate().publicKey.toBase58();

function idlFlags(name) {
    const ix = IDL.instructions.find(entry => entry.name === name);
    if (!ix) throw new Error(`no ${name} in the market IDL`);
    return ix.accounts.map(account => ({ name: account.name, signer: Boolean(account.signer), writable: Boolean(account.writable) }));
}

function actualFlags(instruction, names) {
    return instruction.keys.map((key, index) => ({ name: names[index], signer: key.isSigner, writable: key.isWritable }));
}

// A Market account as the program lays it out: discriminator, three pubkeys, two u64 pools, flags.
function marketAccount({ proposal, stakeMint, vault, yesPool = 0n, noPool = 0n, resolved = false, outcome = 0, bump = 255 }) {
    const data = Buffer.alloc(marketClient.MARKET_SIZE);
    Buffer.from(marketClient.ACCOUNT_DISCRIMINATORS.Market).copy(data, 0);
    new PublicKey(proposal).toBuffer().copy(data, 8);
    new PublicKey(stakeMint).toBuffer().copy(data, 40);
    new PublicKey(vault).toBuffer().copy(data, 72);
    data.writeBigUInt64LE(yesPool, 104);
    data.writeBigUInt64LE(noPool, 112);
    data.writeUInt8(resolved ? 1 : 0, 120);
    data.writeUInt8(outcome, 121);
    data.writeUInt8(bump, 122);
    return { data };
}

function stubbedChain(accountFor) {
    const reads = [];
    const sends = [];
    const connection = {
        getAccountInfo: async (pubkey) => {
            reads.push(pubkey.toBase58());
            return accountFor(pubkey);
        }
    };
    const sendAndConfirm = async (conn, transaction, signers, options) => {
        sends.push({ transaction, signers, options });
        return `SIGNATURE-${sends.length}`;
    };
    return { connection, sendAndConfirm, reads, sends };
}

describe('usdcToAtomic', () => {
    it('converts exactly, to the last of the six decimals', () => {
        expect(usdcToAtomic('0.25')).toBe(250000n);
        expect(usdcToAtomic('1')).toBe(1000000n);
        expect(usdcToAtomic('0.000001')).toBe(1n);
        expect(usdcToAtomic('0')).toBe(0n);
        expect(usdcToAtomic('12.5')).toBe(12500000n);
        expect(usdcToAtomic(' 1.000000 ')).toBe(1000000n);
        expect(usdcToAtomic('18446744073709.551615')).toBe(18446744073709551615n);
    });

    it('rejects anything it cannot represent exactly', () => {
        expect(() => usdcToAtomic('0.1234567')).toThrow(/more than 6 decimals/);
        expect(() => usdcToAtomic('abc')).toThrow(/not a non-negative decimal/);
        expect(() => usdcToAtomic('-1')).toThrow(/not a non-negative decimal/);
        expect(() => usdcToAtomic('')).toThrow(/not a non-negative decimal/);
        expect(() => usdcToAtomic('1e6')).toThrow(/not a non-negative decimal/);
        expect(() => usdcToAtomic(0.25)).toThrow(/decimal STRING/);
    });
});

describe('ensureMarketAndStake', () => {
    it('creates the market first when there is none, then stakes (two sends)', async () => {
        const owner = Keypair.generate();
        const { connection, sendAndConfirm, reads, sends } = stubbedChain(() => null);

        const result = await ensureMarketAndStake({
            connection, ownerKeypair: owner, proposalPda: PROPOSAL_PDA,
            stakeMint: USDC_DEVNET, side: SIDE_YES, amountAtomic: 250000n, sendAndConfirm
        });

        const [marketPda] = marketClient.getMarketPda(PROPOSAL_PDA);
        const [positionPda] = marketClient.getPositionPda(marketPda, owner.publicKey, SIDE_YES);
        expect(reads).toEqual([marketPda.toBase58()]);
        expect(sends).toHaveLength(2);
        expect(result).toEqual({
            marketPda: marketPda.toBase58(),
            created: true,
            createSignature: 'SIGNATURE-1',
            stakeSignature: 'SIGNATURE-2',
            positionPda: positionPda.toBase58()
        });

        // create_market: program id, account order and flags exactly as the IDL declares them.
        const createIx = sends[0].transaction.instructions[0];
        const createNames = idlFlags('create_market').map(a => a.name);
        expect(createIx.programId.toBase58()).toBe(IDL.address);
        expect(actualFlags(createIx, createNames)).toEqual(idlFlags('create_market'));
        expect(createIx.keys[0].pubkey.toBase58()).toBe(marketPda.toBase58());
        expect(createIx.keys[1].pubkey.toBase58()).toBe(PROPOSAL_PDA);
        expect(createIx.keys[2].pubkey.toBase58()).toBe(USDC_DEVNET);
        expect(createIx.keys[4].pubkey.toBase58()).toBe(owner.publicKey.toBase58());
        expect(Array.from(createIx.data)).toEqual([...marketClient.IX_DISCRIMINATORS.create_market]);

        // stake: side and amount are the trailing u8 + u64 of the data.
        const stakeIx = sends[1].transaction.instructions[0];
        const stakeNames = idlFlags('stake').map(a => a.name);
        expect(stakeIx.programId.toBase58()).toBe(IDL.address);
        expect(actualFlags(stakeIx, stakeNames)).toEqual(idlFlags('stake'));
        expect(stakeIx.keys[2].pubkey.toBase58()).toBe(positionPda.toBase58());
        expect(stakeIx.keys[5].pubkey.toBase58()).toBe(owner.publicKey.toBase58());
        expect(Array.from(stakeIx.data.slice(0, 8))).toEqual([...marketClient.IX_DISCRIMINATORS.stake]);
        expect(stakeIx.data[8]).toBe(SIDE_YES);
        expect(Buffer.from(stakeIx.data).readBigUInt64LE(9)).toBe(250000n);

        // Both transactions are paid for and signed by the persona.
        for (const send of sends) {
            expect(send.signers).toEqual([owner]);
            expect(send.options).toEqual({ commitment: 'confirmed' });
            expect(send.transaction.feePayer.toBase58()).toBe(owner.publicKey.toBase58());
        }
    });

    it('stakes only (one send) when the market already exists', async () => {
        const owner = Keypair.generate();
        const [marketPda] = marketClient.getMarketPda(PROPOSAL_PDA);
        const vault = marketClient.getVaultAddress(marketPda, USDC_DEVNET);
        const existing = marketAccount({ proposal: PROPOSAL_PDA, stakeMint: USDC_DEVNET, vault, yesPool: 1000000n, noPool: 500000n });
        const { connection, sendAndConfirm, sends } = stubbedChain(() => existing);

        const result = await ensureMarketAndStake({
            connection, ownerKeypair: owner, proposalPda: PROPOSAL_PDA,
            stakeMint: USDC_DEVNET, side: SIDE_NO, amountAtomic: 1n, sendAndConfirm
        });

        expect(sends).toHaveLength(1);
        expect(result.created).toBe(false);
        expect(result.createSignature).toBeNull();
        expect(result.stakeSignature).toBe('SIGNATURE-1');
        const stakeIx = sends[0].transaction.instructions[0];
        expect(Array.from(stakeIx.data.slice(0, 8))).toEqual([...marketClient.IX_DISCRIMINATORS.stake]);
        expect(stakeIx.data[8]).toBe(SIDE_NO);
        expect(Buffer.from(stakeIx.data).readBigUInt64LE(9)).toBe(1n);
        // The NO position is a different PDA from the YES one.
        const [noPosition] = marketClient.getPositionPda(marketPda, owner.publicKey, SIDE_NO);
        const [yesPosition] = marketClient.getPositionPda(marketPda, owner.publicKey, SIDE_YES);
        expect(result.positionPda).toBe(noPosition.toBase58());
        expect(result.positionPda).not.toBe(yesPosition.toBase58());
    });

    it('refuses a stake it cannot send: bad amount, missing keypair, unknown side', async () => {
        const owner = Keypair.generate();
        const { connection, sendAndConfirm, sends } = stubbedChain(() => null);
        const base = { connection, ownerKeypair: owner, proposalPda: PROPOSAL_PDA, stakeMint: USDC_DEVNET, side: SIDE_YES, sendAndConfirm };

        await expect(ensureMarketAndStake({ ...base, amountAtomic: 0n })).rejects.toThrow(/positive/);
        await expect(ensureMarketAndStake({ ...base, amountAtomic: 250000 })).rejects.toThrow(/bigint/);
        await expect(ensureMarketAndStake({ ...base, ownerKeypair: null, amountAtomic: 1n })).rejects.toThrow(/ownerKeypair/);
        await expect(ensureMarketAndStake({ ...base, connection: null, amountAtomic: 1n })).rejects.toThrow(/connection/);
        await expect(ensureMarketAndStake({ ...base, side: 7, amountAtomic: 1n })).rejects.toThrow(/side must be 0 \(NO\) or 1 \(YES\)/);
        expect(sends).toHaveLength(0);
    });
});
