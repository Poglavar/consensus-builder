#!/usr/bin/env node
// Redacted devnet proof for a recipe-bound external market:
//   real SAS court attestation -> precommitted market -> two-sided USDC stake ->
//   permissionless resolution -> winning payout.
//
// The default is a read-only dry run. Pass --live to submit transactions. Court payload values and
// credential-bearing RPC URLs are deliberately never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    buildCourtParcelOperationRecipe,
    COURT_ATTESTER,
    COURT_CREDENTIAL,
    COURT_SCHEMA,
    MARKET_PROGRAM_ID
} from '../../../backend/oracle/court-parcel-operation.js';
import { assertCourtAttestation, decodeCourtAttestation } from '../../../backend/oracle/sas-court-attestation.js';
import { sendAndConfirmPolling } from '../../../backend/agents/solana-send.js';

const solanaRequire = createRequire(new URL('../package.json', import.meta.url));
const localRequire = createRequire(import.meta.url);
const {
    Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction
} = solanaRequire('@solana/web3.js');
const {
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync
} = solanaRequire('@solana/spl-token');
const marketClient = localRequire('../../../frontend/js/solana/market-client.js');
marketClient.configure({
    web3: { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction }
});

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const ATTESTATION = new PublicKey(
    process.env.COURT_DEMO_ATTESTATION || '12VxrWBkHfabA1jdV9HfniPNSj95Tp16uhXprpXzPgWk'
);
const USDC_MINT = new PublicKey(
    process.env.EXTERNAL_MARKET_STAKE_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);
const AMOUNT = 10_000n; // 0.01 devnet USDC on each side.
const CLOSE_DELAY_SECONDS = 75;

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function loadKeypair(file) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(file), 'utf8'))));
}

function explorer(signature) {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function commitment(recipe, name) {
    const value = recipe.verification.commitments[name];
    if (!value) throw new Error(`recipe is missing ${name}`);
    return value;
}

async function tokenBalance(connection, account) {
    const response = await connection.getTokenAccountBalance(account, 'confirmed');
    return BigInt(response.value.amount);
}

async function send(connection, transaction, signers) {
    return sendAndConfirmPolling(connection, transaction, signers, { commitment: 'confirmed' });
}

async function waitUntil(unixSeconds) {
    while (Math.floor(Date.now() / 1000) < unixSeconds) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

function publicPlan({ live, owner, recipe, market, evidence }) {
    return {
        mode: live ? 'live' : 'dry-run',
        cluster: 'devnet',
        program: MARKET_PROGRAM_ID,
        stakeMint: USDC_MINT.toBase58(),
        creator: owner.toBase58(),
        attestation: ATTESTATION.toBase58(),
        attestationHash: `sha256:${evidence.accountHash}`,
        recipeHash: recipe.hash,
        subjectHash: commitment(recipe, 'subjectHash'),
        yesValueHash: commitment(recipe, 'yesValueHash'),
        noValueHash: commitment(recipe, 'noValueHash'),
        market: market.toBase58(),
        closesAt: recipe.verification.closesAt,
        stakePerSideAtomic: AMOUNT.toString(),
        redacted: ['parcelUid', 'decisionUuid', 'operation', 'decisionLink', 'rpcUrl']
    };
}

async function main() {
    const live = process.argv.includes('--live');
    const connection = new Connection(RPC_URL, 'confirmed');
    const owner = loadKeypair(process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json');
    const attestationInfo = await connection.getAccountInfo(ATTESTATION, 'confirmed');
    const evidence = decodeCourtAttestation(attestationInfo, { address: ATTESTATION.toBase58() });
    assertCourtAttestation(evidence, {
        credential: COURT_CREDENTIAL,
        schema: COURT_SCHEMA,
        attester: COURT_ATTESTER
    });

    const closesAt = Math.floor(Date.now() / 1000) + CLOSE_DELAY_SECONDS;
    const noOperation = evidence.fields.operation === 'no_court_operation'
        ? 'different_court_operation'
        : 'no_court_operation';
    const recipe = buildCourtParcelOperationRecipe({
        parcelUid: evidence.fields.parcelUid,
        yesOperation: evidence.fields.operation,
        noOperation,
        closesAt
    });
    const [market] = marketClient.getExternalMarketPda(recipe.hash);
    const plan = publicPlan({ live, owner: owner.publicKey, recipe, market, evidence });
    if (!live) {
        console.log(JSON.stringify({ ...plan, ready: true }, null, 2));
        return;
    }

    const existing = await connection.getAccountInfo(market, 'confirmed');
    if (existing) throw new Error(`external market ${market.toBase58()} already exists`);

    const bettor = Keypair.generate();
    const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
    const bettorAta = getAssociatedTokenAddressSync(USDC_MINT, bettor.publicKey);
    const ownerAtaInfo = await connection.getAccountInfo(ownerAta, 'confirmed');
    if (!ownerAtaInfo) throw new Error(`creator has no token account for ${USDC_MINT.toBase58()}`);
    const ownerInitial = await tokenBalance(connection, ownerAta);
    if (ownerInitial < AMOUNT * 2n) throw new Error(`creator needs at least ${AMOUNT * 2n} atomic stake tokens`);

    const setupSignature = await send(connection, new Transaction()
        .add(SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: bettor.publicKey,
            lamports: 25_000_000
        }))
        .add(createAssociatedTokenAccountIdempotentInstruction(
            owner.publicKey, bettorAta, bettor.publicKey, USDC_MINT
        ))
        .add(createTransferCheckedInstruction(
            ownerAta, USDC_MINT, bettorAta, owner.publicKey, Number(AMOUNT), 6
        )), [owner]);

    const createSignature = await send(connection, new Transaction().add(
        marketClient.buildCreateExternalMarketIx({
            recipeHash: recipe.hash,
            subjectHash: commitment(recipe, 'subjectHash'),
            yesValueHash: commitment(recipe, 'yesValueHash'),
            noValueHash: commitment(recipe, 'noValueHash'),
            trustedAttester: COURT_ATTESTER,
            closesAt,
            stakeMint: USDC_MINT,
            credential: COURT_CREDENTIAL,
            schema: COURT_SCHEMA,
            creator: owner.publicKey
        })
    ), [owner]);

    const yesStakeSignature = await send(connection, new Transaction().add(
        marketClient.buildStakeExternalIx({
            recipeHash: recipe.hash,
            stakeMint: USDC_MINT,
            staker: owner.publicKey,
            side: marketClient.constants.SIDE_YES,
            amount: AMOUNT
        })
    ), [owner]);
    const noStakeSignature = await send(connection, new Transaction().add(
        marketClient.buildStakeExternalIx({
            recipeHash: recipe.hash,
            stakeMint: USDC_MINT,
            staker: bettor.publicKey,
            side: marketClient.constants.SIDE_NO,
            amount: AMOUNT
        })
    ), [bettor]);

    await waitUntil(closesAt + 1);
    const resolveSignature = await send(connection, new Transaction().add(
        marketClient.buildResolveExternalIx({
            recipeHash: recipe.hash,
            attestation: ATTESTATION,
            schema: COURT_SCHEMA
        })
    ), [bettor]);
    const claimSignature = await send(connection, new Transaction().add(
        marketClient.buildClaimExternalIx({
            recipeHash: recipe.hash,
            stakeMint: USDC_MINT,
            claimer: owner.publicKey,
            side: marketClient.constants.SIDE_YES
        })
    ), [owner]);

    const [marketInfo, yesPositionInfo, ownerFinal] = await Promise.all([
        connection.getAccountInfo(market, 'confirmed'),
        connection.getAccountInfo(marketClient.getPositionPda(
            market, owner.publicKey, marketClient.constants.SIDE_YES
        )[0], 'confirmed'),
        tokenBalance(connection, ownerAta)
    ]);
    if (!marketInfo || !yesPositionInfo) throw new Error('settled market accounts are missing');
    const settled = marketClient.decodeExternalMarket(marketInfo.data);
    const winningPosition = marketClient.decodePosition(yesPositionInfo.data);
    if (!settled.resolved || settled.outcome !== marketClient.constants.SIDE_YES) {
        throw new Error('external market did not resolve YES from the committed evidence');
    }
    if (settled.evidence !== ATTESTATION.toBase58() || settled.evidenceHash !== evidence.accountHash) {
        throw new Error('settled evidence commitment does not match the SAS account');
    }
    if (settled.yesPool !== AMOUNT || settled.noPool !== AMOUNT || !winningPosition.claimed) {
        throw new Error('external market stake or claim state is inconsistent');
    }
    const payout = marketClient.payoutAmount(
        marketClient.constants.SIDE_YES, AMOUNT, settled.yesPool, settled.noPool, settled.outcome
    );

    console.log(JSON.stringify({
        ...plan,
        completedAt: new Date().toISOString(),
        resolver: bettor.publicKey.toBase58(),
        outcome: 'YES',
        pools: { yesAtomic: settled.yesPool.toString(), noAtomic: settled.noPool.toString() },
        payoutAtomic: payout.toString(),
        winningPositionClaimed: winningPosition.claimed,
        ownerTokenDeltaAtomic: (ownerFinal - ownerInitial).toString(),
        onchainEvidenceHash: `sha256:${settled.evidenceHash}`,
        resolvedAt: settled.resolvedAt.toString(),
        transactions: Object.fromEntries(Object.entries({
            setup: setupSignature,
            create: createSignature,
            stakeYes: yesStakeSignature,
            stakeNo: noStakeSignature,
            resolve: resolveSignature,
            claim: claimSignature
        }).map(([name, signature]) => [name, { signature, explorer: explorer(signature) }]))
    }, null, 2));
}

main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
});
