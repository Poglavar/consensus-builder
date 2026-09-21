#!/usr/bin/env node
// Two-phase devnet runner for a market that must exist before its evidence. Opening never reads an
// attestation. V2 evidence commits the official source-observation time, and both this runner and
// proposal_market enforce that the source and attestation appeared only after trading closed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    buildCourtParcelOperationRecipeV2,
    COURT_ATTESTER,
    COURT_CREDENTIAL,
    COURT_SCHEMA_V2,
    MARKET_PROGRAM_ID
} from '../../../backend/oracle/court-parcel-operation.js';
import {
    assertProspectiveChronology,
    classifyExternalMarketChronology
} from '../../../backend/oracle/external-market-chronology.js';
import { assertCourtAttestation, decodeCourtAttestation } from '../../../backend/oracle/sas-court-attestation.js';
import { selectProspectiveCourtEvidence } from '../../../backend/oracle/prospective-evidence.js';
import { sendAndConfirmPolling } from '../../../backend/agents/solana-send.js';

// Resolve chain-only packages from blockchain/solana's own package boundary. Production operator
// hosts must run `npm ci` there before invoking this root-level script.
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
marketClient.configure({ web3: { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey(process.env.EXTERNAL_MARKET_STAKE_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const STATE_FILE = path.resolve(process.env.PROSPECTIVE_MARKET_STATE || '.prospective-external-market.private.json');

function required(value, label) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error(`${label} is required`);
    return text;
}

function expandHome(value) {
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function loadKeypair(file, label) {
    const location = expandHome(required(file, label));
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(location, 'utf8'))));
}

function amountAtomic() {
    const value = BigInt(process.env.PROSPECTIVE_STAKE_ATOMIC || '10000');
    if (value <= 0n || value > 1_000_000_000n) throw new Error('PROSPECTIVE_STAKE_ATOMIC must be between 1 and 1000000000');
    return value;
}

function closeTime() {
    const raw = required(process.env.PROSPECTIVE_CLOSES_AT, 'PROSPECTIVE_CLOSES_AT');
    const numeric = /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
    if (!Number.isSafeInteger(numeric) || numeric <= Math.floor(Date.now() / 1000) + 300) {
        throw new Error('PROSPECTIVE_CLOSES_AT must be at least five minutes in the future');
    }
    return numeric;
}

function schemaAddress(value = COURT_SCHEMA_V2) {
    try {
        return new PublicKey(required(value, 'PROSPECTIVE_COURT_SCHEMA'));
    } catch {
        throw new Error('PROSPECTIVE_COURT_SCHEMA must be a Solana public key');
    }
}

function commitment(recipe, name) {
    const value = recipe.verification.commitments[name];
    if (!value) throw new Error(`recipe is missing ${name}`);
    return value;
}

async function send(connection, transaction, signers) {
    return sendAndConfirmPolling(connection, transaction, signers, { commitment: 'confirmed' });
}

async function transactionTime(connection, signature) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (tx?.blockTime) return tx.blockTime;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`transaction ${signature} has no confirmed block time`);
}

async function firstAddressTime(connection, address) {
    let before;
    let oldest = null;
    for (let page = 0; page < 10; page += 1) {
        const rows = await connection.getSignaturesForAddress(address, { before, limit: 1000 }, 'confirmed');
        if (!rows.length) break;
        oldest = rows.at(-1);
        if (rows.length < 1000) break;
        before = oldest.signature;
    }
    if (!oldest?.blockTime) throw new Error(`cannot establish first on-chain time for ${address.toBase58()}`);
    return { signature: oldest.signature, blockTime: oldest.blockTime };
}

async function verifiedCandidate(connection, address, schema) {
    const evidence = decodeCourtAttestation(
        await connection.getAccountInfo(address, 'confirmed'),
        { address: address.toBase58() }
    );
    assertCourtAttestation(evidence, {
        credential: COURT_CREDENTIAL,
        schema,
        attester: COURT_ATTESTER,
        requireSourceTime: true
    });
    const firstSeen = await firstAddressTime(connection, address);
    return {
        address: address.toBase58(), evidence,
        firstSeenAt: firstSeen.blockTime, firstSeenSignature: firstSeen.signature
    };
}

async function discoverEvidence(connection, state, schema) {
    const supplied = process.env.PROSPECTIVE_ATTESTATION?.trim();
    let candidates = [];
    if (supplied) {
        candidates = [await verifiedCandidate(connection, new PublicKey(supplied), schema)];
    } else {
        const accounts = await connection.getProgramAccounts(new PublicKey(state.recipe.verification.sasProgram), {
            commitment: 'confirmed',
            filters: [
                { memcmp: { offset: 33, bytes: COURT_CREDENTIAL } },
                { memcmp: { offset: 65, bytes: schema.toBase58() } }
            ]
        });
        candidates = (await Promise.all(accounts.map(async account => {
            try { return await verifiedCandidate(connection, account.pubkey, schema); } catch { return null; }
        }))).filter(Boolean);
    }
    return selectProspectiveCourtEvidence({
        candidates,
        parcelUid: state.privateRecipe.parcelUid,
        yesOperation: state.privateRecipe.yesOperation,
        noOperation: state.privateRecipe.noOperation,
        closesAt: state.recipe.verification.closesAt
    });
}

function publicState(state) {
    return {
        version: state.version,
        phase: state.phase,
        cluster: 'devnet',
        program: MARKET_PROGRAM_ID,
        market: state.market,
        recipeHash: state.recipe.hash,
        closesAt: new Date(state.recipe.verification.closesAt * 1000).toISOString(),
        stakePerSideAtomic: state.stakePerSideAtomic,
        transactions: state.transactions,
        chronology: state.chronology || null,
        redacted: ['parcelUid', 'yesOperation', 'noOperation', 'decisionUuid', 'decisionLink', 'rpcUrl']
    };
}

function writeState(state) {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function openMarket(connection, live) {
    const closesAt = closeTime();
    const schema = schemaAddress(process.env.PROSPECTIVE_COURT_SCHEMA || COURT_SCHEMA_V2);
    const privateRecipe = {
        parcelUid: required(process.env.PROSPECTIVE_PARCEL_UID, 'PROSPECTIVE_PARCEL_UID'),
        yesOperation: required(process.env.PROSPECTIVE_YES_OPERATION, 'PROSPECTIVE_YES_OPERATION'),
        noOperation: required(process.env.PROSPECTIVE_NO_OPERATION, 'PROSPECTIVE_NO_OPERATION'),
        closesAt
    };
    const recipe = buildCourtParcelOperationRecipeV2({ ...privateRecipe, schema: schema.toBase58() });
    const [market] = marketClient.getExternalMarketPda(recipe.hash);
    const amount = amountAtomic();
    const planned = {
        version: 2, phase: live ? 'opening' : 'plan', market: market.toBase58(), recipe,
        privateRecipe, stakePerSideAtomic: amount.toString(), transactions: {}
    };
    if (!live) return console.log(JSON.stringify(publicState(planned), null, 2));
    if (fs.existsSync(STATE_FILE)) throw new Error(`state file already exists: ${STATE_FILE}`);

    const owner = loadKeypair(process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json', 'SOLANA_KEYPAIR');
    const bettor = loadKeypair(process.env.PROSPECTIVE_BETTOR_KEYPAIR, 'PROSPECTIVE_BETTOR_KEYPAIR');
    if (owner.publicKey.equals(bettor.publicKey)) throw new Error('creator and bettor must be different wallets');
    const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
    const bettorAta = getAssociatedTokenAddressSync(USDC_MINT, bettor.publicKey);
    const balance = BigInt((await connection.getTokenAccountBalance(ownerAta, 'confirmed')).value.amount);
    if (balance < amount * 2n) throw new Error(`creator needs at least ${amount * 2n} atomic stake tokens`);

    const setup = await send(connection, new Transaction()
        .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: bettor.publicKey, lamports: 25_000_000 }))
        .add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, bettorAta, bettor.publicKey, USDC_MINT))
        .add(createTransferCheckedInstruction(ownerAta, USDC_MINT, bettorAta, owner.publicKey, Number(amount), 6)), [owner]);
    const create = await send(connection, new Transaction().add(marketClient.buildCreateExternalMarketIx({
        recipeHash: recipe.hash,
        subjectHash: commitment(recipe, 'subjectHash'),
        yesValueHash: commitment(recipe, 'yesValueHash'),
        noValueHash: commitment(recipe, 'noValueHash'),
        trustedAttester: COURT_ATTESTER,
        closesAt,
        stakeMint: USDC_MINT,
        credential: COURT_CREDENTIAL,
        schema,
        creator: owner.publicKey
    })), [owner]);
    const yes = await send(connection, new Transaction().add(marketClient.buildStakeExternalIx({
        recipeHash: recipe.hash, stakeMint: USDC_MINT, staker: owner.publicKey,
        side: marketClient.constants.SIDE_YES, amount
    })), [owner]);
    const no = await send(connection, new Transaction().add(marketClient.buildStakeExternalIx({
        recipeHash: recipe.hash, stakeMint: USDC_MINT, staker: bettor.publicKey,
        side: marketClient.constants.SIDE_NO, amount
    })), [bettor]);
    const [createdAt, yesStakeAt, noStakeAt] = await Promise.all([
        transactionTime(connection, create), transactionTime(connection, yes), transactionTime(connection, no)
    ]);
    const state = {
        ...planned, phase: 'open', creator: owner.publicKey.toBase58(), bettor: bettor.publicKey.toBase58(),
        transactions: { setup, create, yesStake: yes, noStake: no },
        timestamps: { marketCreatedAt: createdAt, yesStakeAt, noStakeAt }
    };
    writeState(state);
    console.log(JSON.stringify(publicState(state), null, 2));
}

async function settleMarket(connection, live) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (state.phase === 'settled') return console.log(JSON.stringify(publicState(state), null, 2));
    if (state.phase !== 'open') throw new Error(`market state is ${state.phase}, expected open`);
    if (now < state.recipe.verification.closesAt) {
        return console.log(JSON.stringify({
            ...publicState(state), readiness: 'market_open',
            secondsUntilClose: state.recipe.verification.closesAt - now
        }, null, 2));
    }

    const schema = new PublicKey(state.recipe.verification.schema);
    const selection = await discoverEvidence(connection, state, schema);
    if (selection.status === 'waiting') {
        return console.log(JSON.stringify({
            ...publicState(state), phase: 'awaiting_evidence', readiness: 'no_matching_post_close_attestation'
        }, null, 2));
    }
    if (selection.status === 'conflict') {
        throw new Error('conflicting post-close attestations map to both market outcomes');
    }
    const selected = selection.selected;
    const attestation = new PublicKey(selected.address);
    const evidence = selected.evidence;
    const firstEvidence = { signature: selected.firstSeenSignature, blockTime: selected.firstSeenAt };
    const sourceObservedAt = evidence.fields.sourceObservedAt;
    const sourceTimeCommitted = true;
    const chronologyInput = {
        ...state.timestamps,
        marketClosesAt: state.recipe.verification.closesAt,
        evidenceCreatedAt: firstEvidence.blockTime,
        sourceObservedAt,
        sourceTimeCommitted,
        resolvedAt: now
    };
    const preflight = classifyExternalMarketChronology(chronologyInput);
    assertProspectiveChronology(chronologyInput);
    if (!live) return console.log(JSON.stringify({
        ...publicState(state), phase: 'settlement-plan', chronology: preflight,
        evidence: { address: selected.address, hash: `sha256:${evidence.accountHash}` },
        eligibleEvidenceCount: selection.eligible.length
    }, null, 2));

    const owner = loadKeypair(process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json', 'SOLANA_KEYPAIR');
    const bettor = loadKeypair(process.env.PROSPECTIVE_BETTOR_KEYPAIR, 'PROSPECTIVE_BETTOR_KEYPAIR');
    const resolve = await send(connection, new Transaction().add(marketClient.buildResolveExternalIx({
        recipeHash: state.recipe.hash, attestation, schema
    })), [bettor]);
    const outcome = evidence.fields.operation === state.privateRecipe.yesOperation
        ? marketClient.constants.SIDE_YES : marketClient.constants.SIDE_NO;
    const winner = outcome === marketClient.constants.SIDE_YES ? owner : bettor;
    const claim = await send(connection, new Transaction().add(marketClient.buildClaimExternalIx({
        recipeHash: state.recipe.hash, stakeMint: USDC_MINT, claimer: winner.publicKey, side: outcome
    })), [winner]);
    const [resolvedAt, claimedAt] = await Promise.all([
        transactionTime(connection, resolve), transactionTime(connection, claim)
    ]);
    state.phase = 'settled';
    state.transactions = { ...state.transactions, evidenceFirstSeen: firstEvidence.signature, resolve, claim };
    state.chronology = classifyExternalMarketChronology({
        ...state.timestamps,
        marketClosesAt: state.recipe.verification.closesAt,
        evidenceCreatedAt: firstEvidence.blockTime,
        sourceObservedAt,
        sourceTimeCommitted,
        resolvedAt,
        claimedAt
    });
    state.outcome = outcome === marketClient.constants.SIDE_YES ? 'YES' : 'NO';
    state.evidence = { address: attestation.toBase58(), hash: `sha256:${evidence.accountHash}` };
    writeState(state);
    console.log(JSON.stringify(publicState(state), null, 2));
}

async function main() {
    const open = process.argv.includes('--open');
    const settle = process.argv.includes('--settle');
    if (open === settle) throw new Error('choose exactly one phase: --open or --settle');
    const live = process.argv.includes('--live');
    const connection = new Connection(RPC_URL, 'confirmed');
    if (open) return openMarket(connection, live);
    return settleMarket(connection, live);
}

main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
});
