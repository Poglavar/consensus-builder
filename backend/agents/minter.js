// Node port of the browser's `mint_and_fund` (frontend/js/solana/proposal-bridge.js): the same
// Anchor discriminator, the same borsh argument encoding and the same PDAs, signed with a persona
// keypair instead of a wallet extension. Encoding and PDA derivation are pure and byte-compared
// against the browser code in test/agents-minter.test.js; only mintProposal() touches the network.

import { createHash } from 'node:crypto';
import pkg from '@solana/web3.js';

const { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = pkg;

const PROPOSAL_COUNTER_SEED = 'proposal_counter';
const PROPOSAL_SEED = 'proposal';
const COUNTER_VALUE_OFFSET = 8; // 8-byte Anchor account discriminator, then the u64 count.

/** sha256("global:<name>")[0..8] — Anchor's instruction discriminator, as the browser computes it. */
export function instructionDiscriminator(name) {
    return new Uint8Array(createHash('sha256').update(`global:${name}`).digest()).slice(0, 8);
}

function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function encodeU32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

function encodeU64(value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}

function encodeBorshString(text) {
    const utf8 = new TextEncoder().encode(text);
    return concatBytes([encodeU32(utf8.length), utf8]);
}

function encodeBorshVecString(items) {
    return concatBytes([encodeU32(items.length), ...items.map(encodeBorshString)]);
}

function encodeBorshVecPubkey(addresses) {
    return concatBytes([encodeU32(addresses.length), ...addresses.map(a => new Uint8Array(toPublicKey(a, 'lens entry').toBytes()))]);
}

function toPublicKey(value, label) {
    if (value === null || value === undefined || value === '') throw new Error(`${label} is required`);
    if (value instanceof PublicKey) return value;
    if (typeof value === 'string') return new PublicKey(value);
    if (typeof value.toBase58 === 'function') return new PublicKey(value.toBase58());
    if (value instanceof Uint8Array || Array.isArray(value)) return new PublicKey(value);
    throw new Error(`${label} must be a base58 address or a PublicKey`);
}

// Mirror of the browser's parseIntegerBigInt: a lamport amount is a non-negative integer, and
// anything else (a float, a negative, "12.5") is a caller bug rather than something to round.
function toLamports(value, label = 'lamports') {
    if (value === undefined || value === null || value === '') return 0n;
    if (typeof value === 'bigint') {
        if (value < 0n) throw new Error(`${label} cannot be negative`);
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
            throw new Error(`${label} must be a non-negative integer`);
        }
        return BigInt(value);
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
    return BigInt(text);
}

/**
 * The instruction data for `mint_and_fund`, byte-identical to the browser's:
 * discriminator ‖ vec<string> parcel_ids ‖ u8 is_conditional ‖ string image_uri ‖ u64 sol_lamports ‖ vec<pubkey> lens.
 * Parcel ids are de-duplicated and stringified exactly as the browser does, so the same logical
 * input produces the same bytes on both sides.
 *
 * @param {{ parcelIds: string[], isConditional?: boolean, imageUri?: string, lamports?: bigint|number|string, lens?: Array }} args
 * @returns {Uint8Array}
 */
export function encodeMintAndFundData({ parcelIds, isConditional = true, imageUri = '', lamports = 0n, lens = [] } = {}) {
    const ids = [...new Set((Array.isArray(parcelIds) ? parcelIds : []).map(String).filter(Boolean))];
    if (ids.length === 0) throw new Error('No parcel identifiers provided');
    const lensAddresses = (Array.isArray(lens) ? lens : [])
        .map(entry => (typeof entry === 'string' ? entry : (entry?.address || entry?.toBase58?.() || entry?.toString?.())))
        .filter(Boolean);
    return concatBytes([
        instructionDiscriminator('mint_and_fund'),
        encodeBorshVecString(ids),
        Uint8Array.from([isConditional ? 1 : 0]),
        encodeBorshString(imageUri || ''),
        encodeU64(toLamports(lamports, 'SOL lamports')),
        encodeBorshVecPubkey(lensAddresses)
    ]);
}

/**
 * The two PDAs `mint_and_fund` touches: the global counter and the proposal the current count names.
 * Seeds match blockchain/solana/tests/helpers.ts and the browser bridge.
 *
 * @returns {{ counterPda: PublicKey, proposalPda: PublicKey, bump: number }} bump is the proposal PDA's
 */
export function deriveProposalPdas(programId, count) {
    const program = toPublicKey(programId, 'programId');
    if (typeof count !== 'bigint') throw new Error('count must be a bigint');
    if (count < 0n) throw new Error('count cannot be negative');
    const [counterPda] = PublicKey.findProgramAddressSync([Buffer.from(PROPOSAL_COUNTER_SEED)], program);
    const [proposalPda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from(PROPOSAL_SEED), Buffer.from(encodeU64(count))],
        program
    );
    return { counterPda, proposalPda, bump };
}

/**
 * The next proposal index, read off the counter account (u64 LE at offset 8).
 * @returns {Promise<bigint>}
 */
export async function readProposalCounter(connection, programId) {
    if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('a solana connection is required');
    const program = toPublicKey(programId, 'programId');
    const [counterPda] = PublicKey.findProgramAddressSync([Buffer.from(PROPOSAL_COUNTER_SEED)], program);
    const info = await connection.getAccountInfo(counterPda);
    if (!info || !info.data) {
        throw new Error(`proposal counter ${counterPda.toBase58()} does not exist — initialize program ${program.toBase58()} first`);
    }
    const data = info.data instanceof Uint8Array ? info.data : Uint8Array.from(info.data);
    if (data.length < COUNTER_VALUE_OFFSET + 8) {
        throw new Error(`proposal counter ${counterPda.toBase58()} is ${data.length} bytes, expected at least ${COUNTER_VALUE_OFFSET + 8}`);
    }
    return new DataView(data.buffer, data.byteOffset + COUNTER_VALUE_OFFSET, 8).getBigUint64(0, true);
}

/**
 * The `mint_and_fund` instruction. Account order and flags mirror the browser bridge:
 * proposal (w), counter (w), owner (signer, w), system program.
 */
export function buildMintInstruction({ programId, owner, count, data }) {
    const program = toPublicKey(programId, 'programId');
    const ownerKey = toPublicKey(owner, 'owner');
    const { counterPda, proposalPda } = deriveProposalPdas(program, count);
    if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array from encodeMintAndFundData()');
    return new TransactionInstruction({
        programId: program,
        keys: [
            { pubkey: proposalPda, isSigner: false, isWritable: true },
            { pubkey: counterPda, isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data: Buffer.from(data)
    });
}

// A concurrent mint takes the count we read, so our proposal PDA is already allocated. That shows up
// as a simulation failure naming the address ("already in use"); re-reading the counter fixes it.
function isCounterRace(error) {
    const parts = [error?.message ?? '', ...(Array.isArray(error?.logs) ? error.logs : [])].join(' ');
    return /already in use|Simulation failed|simulation failed/.test(parts);
}

/**
 * Mint one proposal NFT with the persona keypair.
 *
 * @param {{ connection: object, programId: string|PublicKey, ownerKeypair: object, parcelIds: string[],
 *           isConditional?: boolean, imageUri?: string, lamports?: bigint, lens?: Array,
 *           sendAndConfirm?: Function }} options sendAndConfirm is the injection seam for tests.
 * @returns {Promise<{ signature: string, proposalPda: string, count: bigint, chainId: string,
 *                     contractAddress: string, transactionHash: string }>}
 */
export async function mintProposal({
    connection,
    programId,
    ownerKeypair,
    parcelIds,
    isConditional = true,
    imageUri = '',
    lamports = 0n,
    lens,
    sendAndConfirm = sendAndConfirmTransaction
} = {}) {
    if (!connection) throw new Error('a solana connection is required');
    if (!ownerKeypair || !ownerKeypair.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    const program = toPublicKey(programId, 'programId');
    const owner = ownerKeypair.publicKey;
    const lensAddresses = lens === undefined || lens === null ? [owner] : lens;
    const data = encodeMintAndFundData({ parcelIds, isConditional, imageUri, lamports, lens: lensAddresses });

    const attempt = async (count) => {
        const { proposalPda } = deriveProposalPdas(program, count);
        const transaction = new Transaction().add(buildMintInstruction({ programId: program, owner, count, data }));
        transaction.feePayer = owner;
        const signature = await sendAndConfirm(connection, transaction, [ownerKeypair], { commitment: 'confirmed' });
        return { signature, proposalPda: proposalPda.toBase58(), count };
    };

    let result;
    const count = await readProposalCounter(connection, program);
    try {
        result = await attempt(count);
    } catch (err) {
        if (!isCounterRace(err)) throw err;
        const retryCount = await readProposalCounter(connection, program);
        if (retryCount === count) throw err;
        result = await attempt(retryCount);
    }

    return {
        ...result,
        chainId: 'solana-devnet',
        contractAddress: program.toBase58(),
        transactionHash: result.signature
    };
}
