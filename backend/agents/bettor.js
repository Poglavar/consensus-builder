// Staking side of the agent runner: makes sure a proposal has a parimutuel market and puts the
// persona's devnet-USDC stake on one side of it. All encoding and PDA derivation come from the
// shared UMD client frontend/js/solana/market-client.js (the same bytes the browser sends); this
// file only wires it to a node keypair and a connection.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const marketClient = require('../../frontend/js/solana/market-client.js');

// The UMD module resolves @solana/web3.js relative to itself (frontend/js/solana), where it is not
// installed, so the backend's copy has to be injected.
marketClient.configure({ web3 });

const USDC_DECIMALS = 6;

/**
 * "0.25" → 250000n. Exact string arithmetic — a JS number is refused because 0.1 + 0.2 is not the
 * kind of thing that should decide how much money moves.
 *
 * @param {string} decimalString
 * @returns {bigint} atomic units (6 decimals)
 */
export function usdcToAtomic(decimalString) {
    if (typeof decimalString !== 'string') {
        throw new Error('usdcToAtomic takes a decimal STRING (e.g. "0.25"), not a number — floats lose exactness');
    }
    const text = decimalString.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) {
        throw new Error(`"${decimalString}" is not a non-negative decimal amount of USDC`);
    }
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > USDC_DECIMALS) {
        throw new Error(`"${decimalString}" has more than ${USDC_DECIMALS} decimals — USDC cannot represent it`);
    }
    return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0');
}

async function send(connection, instruction, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(instruction);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
}

/**
 * Create the proposal's market if it does not exist yet, then stake on it.
 *
 * @param {{ connection: object, ownerKeypair: object, proposalPda: string, stakeMint: string,
 *           side: number, amountAtomic: bigint, targetAmount?: boolean,
 *           programId?: string, sendAndConfirm?: Function }} options
 * @returns {Promise<{ marketPda: string, created: boolean, createSignature: string|null,
 *                     stakeSignature: string, positionPda: string }>}
 */
export async function ensureMarketAndStake({
    connection,
    ownerKeypair,
    proposalPda,
    stakeMint,
    side,
    amountAtomic,
    targetAmount = false,
    programId,
    sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('a solana connection is required');
    if (!ownerKeypair || !ownerKeypair.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    if (!proposalPda) throw new Error('proposalPda is required');
    if (!stakeMint) throw new Error('stakeMint is required');
    if (typeof amountAtomic !== 'bigint') throw new Error('amountAtomic must be a bigint of atomic units');
    if (amountAtomic <= 0n) throw new Error('amountAtomic must be positive');

    const owner = ownerKeypair.publicKey;
    const [marketPda] = marketClient.getMarketPda(proposalPda, programId);
    const [positionPda] = marketClient.getPositionPda(marketPda, owner, side, programId);

    const existing = await marketClient.readMarket(connection, proposalPda, programId);
    let created = false;
    let createSignature = null;
    if (!existing) {
        const createIx = marketClient.buildCreateMarketIx({ proposal: proposalPda, stakeMint, creator: owner, programId });
        createSignature = await send(connection, createIx, ownerKeypair, sendAndConfirm);
        created = true;
    }

    let stakeAmount = amountAtomic;
    if (targetAmount && existing) {
        const position = await marketClient.readPosition(connection, proposalPda, owner, side, programId);
        const current = position?.amount || 0n;
        if (current >= amountAtomic) {
            return {
                marketPda: marketPda.toBase58(), created, createSignature,
                stakeSignature: null, positionPda: positionPda.toBase58(), replayed: true
            };
        }
        stakeAmount = amountAtomic - current;
    }

    const stakeIx = marketClient.buildStakeIx({ proposal: proposalPda, stakeMint, staker: owner, side, amount: stakeAmount, programId });
    const stakeSignature = await send(connection, stakeIx, ownerKeypair, sendAndConfirm);

    return {
        marketPda: marketPda.toBase58(),
        created,
        createSignature,
        stakeSignature,
        positionPda: positionPda.toBase58(),
        ...(targetAmount ? { replayed: false } : {})
    };
}
