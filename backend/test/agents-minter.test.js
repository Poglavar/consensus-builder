// Unit tests for agents/minter.js — the node port of the browser's mint_and_fund.
// The parity check is not a copy of the browser encoding: frontend/js/solana/proposal-bridge.js is
// loaded in THIS realm with its internal borsh helpers exposed, the browser's own instruction data
// is composed from them exactly as its mintProposal() does, and the bytes are compared. So a change
// to either side that moves a single byte fails here. The discriminator is additionally pinned to
// the generated IDL, and the PDAs to blockchain/solana/tests/helpers.ts's seeds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    encodeMintAndFundData,
    instructionDiscriminator,
    deriveProposalPdas,
    readProposalCounter,
    buildMintInstruction,
    mintProposal
} from '../agents/minter.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const { PublicKey, Keypair, SystemProgram } = web3;

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_nft.json'), 'utf8'));
const PROGRAM_ID = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';

const LENS_A = Keypair.generate().publicKey.toBase58();
const LENS_B = Keypair.generate().publicKey.toBase58();
const FIXTURE = {
    // The duplicate is deliberate: the browser de-duplicates before encoding and so must we.
    parcelIds: ['HR-1234-5678', 'HR-1234-5679', 'HR-1234-5678'],
    isConditional: true,
    imageUri: 'http://backend.test:3999/proposals/agent-densifier-01-2026-09-17-1',
    lamports: 1234567890n,
    lens: [LENS_A, LENS_B]
};

let bridge; // the browser module's own internals

beforeAll(() => {
    // proposal-bridge.js is a classic-script IIFE that keeps its borsh helpers private. Load it in
    // this realm (never a vm realm — see MEMORY.md) with the helpers published on the way out.
    const file = path.join(REPO, 'frontend/js/solana/proposal-bridge.js');
    const source = readFileSync(file, 'utf8');
    const exposeLine = '    globalScope.__bridgeInternals = { encodeBorshString, encodeBorshVecString, encodeBorshVecPubkey, concatBuffers, sha256Discriminator };\n})();';
    const patched = source.replace(/\}\)\(\);\s*$/, exposeLine);
    if (patched === source) throw new Error('could not patch proposal-bridge.js: its IIFE tail changed');
    globalThis.window = globalThis;
    globalThis.solanaWeb3 = web3;
    (0, eval)(patched);
    bridge = globalThis.__bridgeInternals;
    if (!bridge || typeof bridge.encodeBorshVecString !== 'function') throw new Error('proposal-bridge.js exposed no internals');
});

afterAll(() => {
    delete globalThis.__bridgeInternals;
    delete globalThis.SolanaProposalChainBridge;
    delete globalThis.solanaWeb3;
    delete globalThis.window;
});

// Byte-for-byte what frontend/js/solana/proposal-bridge.js's mintProposal() puts in the instruction.
async function browserMintAndFundData({ parcelIds, isConditional, imageUri, lamports, lens }) {
    const uniqueParcelIds = [...new Set(parcelIds.map(String).filter(Boolean))];
    const discriminator = await bridge.sha256Discriminator('mint_and_fund');
    const solAmountBuf = new Uint8Array(8);
    new DataView(solAmountBuf.buffer).setBigUint64(0, lamports, true);
    const lensAddresses = lens.map(l => (typeof l === 'string' ? l : (l?.address || l?.toString?.())));
    const args = bridge.concatBuffers([
        bridge.encodeBorshVecString(uniqueParcelIds),
        new Uint8Array([isConditional ? 1 : 0]),
        bridge.encodeBorshString(imageUri || ''),
        solAmountBuf,
        bridge.encodeBorshVecPubkey(lensAddresses.filter(Boolean))
    ]);
    return bridge.concatBuffers([discriminator, args]);
}

function counterAccount(count) {
    const data = Buffer.alloc(16);
    data.writeBigUInt64LE(count, 8);
    return { data };
}

describe('encodeMintAndFundData', () => {
    it('is byte-identical to the browser bridge for the same proposal', async () => {
        const expected = await browserMintAndFundData(FIXTURE);
        const actual = encodeMintAndFundData(FIXTURE);
        expect(Array.from(actual)).toEqual(Array.from(expected));
    });

    it('matches the browser on the edges too: no lens, empty image, zero lamports, one parcel', async () => {
        const edge = { parcelIds: ['HR-1'], isConditional: false, imageUri: '', lamports: 0n, lens: [] };
        expect(Array.from(encodeMintAndFundData(edge))).toEqual(Array.from(await browserMintAndFundData(edge)));
    });

    it('starts with the IDL discriminator for mint_and_fund', () => {
        const idl = IDL.instructions.find(ix => ix.name === 'mint_and_fund');
        expect(idl.discriminator).toEqual([255, 122, 242, 119, 64, 81, 64, 208]);
        expect(Array.from(instructionDiscriminator('mint_and_fund'))).toEqual(idl.discriminator);
        expect(Array.from(encodeMintAndFundData(FIXTURE).slice(0, 8))).toEqual(idl.discriminator);
    });

    it('lays the arguments out in the declared order', () => {
        const bytes = encodeMintAndFundData(FIXTURE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(8, true)).toBe(2); // vec<string> length, after de-duplication
        let offset = 12;
        for (const id of ['HR-1234-5678', 'HR-1234-5679']) {
            expect(view.getUint32(offset, true)).toBe(id.length);
            expect(Buffer.from(bytes.slice(offset + 4, offset + 4 + id.length)).toString('utf8')).toBe(id);
            offset += 4 + id.length;
        }
        expect(bytes[offset]).toBe(1); // is_conditional
        offset += 1;
        const uriLength = view.getUint32(offset, true);
        expect(Buffer.from(bytes.slice(offset + 4, offset + 4 + uriLength)).toString('utf8')).toBe(FIXTURE.imageUri);
        offset += 4 + uriLength;
        expect(view.getBigUint64(offset, true)).toBe(1234567890n);
        offset += 8;
        expect(view.getUint32(offset, true)).toBe(2); // vec<pubkey> length
        expect(new PublicKey(bytes.slice(offset + 4, offset + 36)).toBase58()).toBe(LENS_A);
        expect(new PublicKey(bytes.slice(offset + 36, offset + 68)).toBase58()).toBe(LENS_B);
        expect(bytes.length).toBe(offset + 68);
    });

    it('refuses a proposal with no parcels and a fractional lamport amount', () => {
        expect(() => encodeMintAndFundData({ parcelIds: [] })).toThrow(/No parcel identifiers/);
        expect(() => encodeMintAndFundData({ parcelIds: ['HR-1'], lamports: 1.5 })).toThrow(/non-negative integer/);
        expect(() => encodeMintAndFundData({ parcelIds: ['HR-1'], lamports: -1n })).toThrow(/negative/);
    });
});

describe('deriveProposalPdas', () => {
    // The seeds blockchain/solana/tests/helpers.ts uses, rebuilt here independently.
    function helpersDerivation(programId, count) {
        const program = new PublicKey(programId);
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(BigInt(count));
        return {
            counter: PublicKey.findProgramAddressSync([Buffer.from('proposal_counter')], program),
            proposal: PublicKey.findProgramAddressSync([Buffer.from('proposal'), buf], program)
        };
    }

    it('derives the counter and the proposal PDA from the same seeds as the on-chain tests', () => {
        for (const count of [0n, 1n, 42n, 4294967296n]) {
            const expected = helpersDerivation(PROGRAM_ID, count);
            const { counterPda, proposalPda, bump } = deriveProposalPdas(PROGRAM_ID, count);
            expect(counterPda.toBase58()).toBe(expected.counter[0].toBase58());
            expect(proposalPda.toBase58()).toBe(expected.proposal[0].toBase58());
            expect(bump).toBe(expected.proposal[1]);
        }
    });

    it('insists on a bigint count', () => {
        expect(() => deriveProposalPdas(PROGRAM_ID, 3)).toThrow(/bigint/);
        expect(() => deriveProposalPdas(PROGRAM_ID, -1n)).toThrow(/negative/);
    });
});

describe('readProposalCounter', () => {
    it('reads the u64 that follows the account discriminator', async () => {
        const connection = { getAccountInfo: async () => counterAccount(97n) };
        expect(await readProposalCounter(connection, PROGRAM_ID)).toBe(97n);
    });

    it('asks for the counter PDA, not some other account', async () => {
        const seen = [];
        const connection = { getAccountInfo: async (pk) => { seen.push(pk.toBase58()); return counterAccount(0n); } };
        await readProposalCounter(connection, PROGRAM_ID);
        expect(seen).toEqual([deriveProposalPdas(PROGRAM_ID, 0n).counterPda.toBase58()]);
    });

    it('names the missing account instead of returning a zero count', async () => {
        const connection = { getAccountInfo: async () => null };
        await expect(readProposalCounter(connection, PROGRAM_ID)).rejects.toThrow(/does not exist — initialize program/);
        const short = { getAccountInfo: async () => ({ data: Buffer.alloc(8) }) };
        await expect(readProposalCounter(short, PROGRAM_ID)).rejects.toThrow(/expected at least 16/);
    });
});

describe('buildMintInstruction', () => {
    it('uses the account order and flags of the browser bridge', () => {
        const owner = Keypair.generate().publicKey;
        const data = encodeMintAndFundData(FIXTURE);
        const ix = buildMintInstruction({ programId: PROGRAM_ID, owner, count: 12n, data });
        const { counterPda, proposalPda } = deriveProposalPdas(PROGRAM_ID, 12n);

        expect(ix.programId.toBase58()).toBe(PROGRAM_ID);
        expect(ix.keys.map(k => ({ key: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable }))).toEqual([
            { key: proposalPda.toBase58(), signer: false, writable: true },
            { key: counterPda.toBase58(), signer: false, writable: true },
            { key: owner.toBase58(), signer: true, writable: true },
            { key: SystemProgram.programId.toBase58(), signer: false, writable: false }
        ]);
        expect(Array.from(ix.data)).toEqual(Array.from(data));
    });
});

describe('mintProposal', () => {
    function stubbedRun({ counts, sendResults }) {
        const reads = [];
        const sends = [];
        const connection = {
            getAccountInfo: async () => {
                const next = counts[Math.min(reads.length, counts.length - 1)];
                reads.push(next);
                return counterAccount(next);
            }
        };
        const sendAndConfirm = async (conn, transaction, signers, options) => {
            sends.push({ conn, transaction, signers, options });
            const result = sendResults[sends.length - 1];
            if (result instanceof Error) throw result;
            return result;
        };
        return { connection, sendAndConfirm, sends, reads };
    }

    it('reads the counter, signs with the persona keypair and reports the proposal PDA', async () => {
        const ownerKeypair = Keypair.generate();
        const { connection, sendAndConfirm, sends } = stubbedRun({ counts: [5n], sendResults: ['SIGNATURE-1'] });

        const result = await mintProposal({
            connection, programId: PROGRAM_ID, ownerKeypair,
            parcelIds: FIXTURE.parcelIds, isConditional: true, imageUri: FIXTURE.imageUri,
            lamports: FIXTURE.lamports, lens: FIXTURE.lens, sendAndConfirm
        });

        expect(sends).toHaveLength(1);
        const { transaction, signers, options } = sends[0];
        expect(signers).toEqual([ownerKeypair]);
        expect(options).toEqual({ commitment: 'confirmed' });
        expect(transaction.feePayer.toBase58()).toBe(ownerKeypair.publicKey.toBase58());
        expect(transaction.instructions).toHaveLength(1);
        expect(Array.from(transaction.instructions[0].data)).toEqual(Array.from(encodeMintAndFundData(FIXTURE)));
        expect(transaction.instructions[0].keys[2].pubkey.toBase58()).toBe(ownerKeypair.publicKey.toBase58());
        expect(result).toEqual({
            signature: 'SIGNATURE-1',
            transactionHash: 'SIGNATURE-1',
            proposalPda: deriveProposalPdas(PROGRAM_ID, 5n).proposalPda.toBase58(),
            count: 5n,
            chainId: 'solana-devnet',
            contractAddress: PROGRAM_ID
        });
    });

    it('defaults lens to the owner when none is given', async () => {
        const ownerKeypair = Keypair.generate();
        const { connection, sendAndConfirm, sends } = stubbedRun({ counts: [0n], sendResults: ['SIG'] });
        await mintProposal({ connection, programId: PROGRAM_ID, ownerKeypair, parcelIds: ['HR-1'], sendAndConfirm });
        const expected = encodeMintAndFundData({ parcelIds: ['HR-1'], isConditional: true, imageUri: '', lamports: 0n, lens: [ownerKeypair.publicKey] });
        expect(Array.from(sends[0].transaction.instructions[0].data)).toEqual(Array.from(expected));
    });

    it('re-reads the counter and retries ONCE when another mint took the index', async () => {
        const ownerKeypair = Keypair.generate();
        const race = new Error('Transaction simulation failed: Error processing Instruction 0');
        race.logs = ['Allocate: account Address { .. } already in use'];
        const { connection, sendAndConfirm, sends } = stubbedRun({ counts: [5n, 6n], sendResults: [race, 'SIGNATURE-2'] });

        const result = await mintProposal({ connection, programId: PROGRAM_ID, ownerKeypair, parcelIds: ['HR-1'], sendAndConfirm });

        expect(sends).toHaveLength(2);
        expect(result.count).toBe(6n);
        expect(result.signature).toBe('SIGNATURE-2');
        expect(result.proposalPda).toBe(deriveProposalPdas(PROGRAM_ID, 6n).proposalPda.toBase58());
        // The retry is built for the NEW index, not resent as-is.
        expect(sends[1].transaction.instructions[0].keys[0].pubkey.toBase58()).toBe(result.proposalPda);
    });

    it('gives up after the one retry and never retries a failure that is not a counter race', async () => {
        const ownerKeypair = Keypair.generate();
        const race = new Error('already in use');
        const second = new Error('still already in use');
        const raced = stubbedRun({ counts: [5n, 6n], sendResults: [race, second] });
        await expect(mintProposal({ connection: raced.connection, programId: PROGRAM_ID, ownerKeypair, parcelIds: ['HR-1'], sendAndConfirm: raced.sendAndConfirm }))
            .rejects.toThrow(/still already in use/);
        expect(raced.sends).toHaveLength(2);

        const other = stubbedRun({ counts: [5n], sendResults: [new Error('insufficient funds for rent')] });
        await expect(mintProposal({ connection: other.connection, programId: PROGRAM_ID, ownerKeypair, parcelIds: ['HR-1'], sendAndConfirm: other.sendAndConfirm }))
            .rejects.toThrow(/insufficient funds/);
        expect(other.sends).toHaveLength(1);
    });

    it('refuses to mint without a keypair or a connection', async () => {
        await expect(mintProposal({ programId: PROGRAM_ID, parcelIds: ['HR-1'] })).rejects.toThrow(/connection/);
        await expect(mintProposal({ connection: {}, programId: PROGRAM_ID, parcelIds: ['HR-1'] })).rejects.toThrow(/ownerKeypair/);
    });
});
