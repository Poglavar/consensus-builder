// LMSR trading for a published agreement's sponsor-created devnet-USDC market. Agent wallets may
// buy shares once that canonical market exists; they never create it or derive a market for themselves.
import { createRequire } from 'node:module';
import { createAgreementChain, agreementAccountOf } from '../agreements/onchain.js';
import { DEVNET_USDC_MINT } from '../solana/address-book.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const market = require('../../frontend/js/solana/lmsr-client.js');
const lmsr = require('../../frontend/js/bets/lmsr.js');
const contract = require('../../frontend/js/bets/betting-contract.js');
market.configure({ web3 });

const chains = new WeakMap();
function agreementChain(connection) {
    let chain = chains.get(connection);
    if (!chain) { chain = createAgreementChain({ connection }); chains.set(connection, chain); }
    return chain;
}

export const DEFAULT_B = 100_000_000n;
export const GRACE_SECONDS = 0;
export const MAX_POSITION = 0n;

function failure(message, code) {
    return Object.assign(new Error(message), { code });
}

function sideName(side) {
    if (side === market.constants.SIDE_YES || String(side).toLowerCase() === 'yes') return 'yes';
    if (side === market.constants.SIDE_NO || String(side).toLowerCase() === 'no') return 'no';
    throw new Error('side must be 0 (NO) or 1 (YES)');
}

function marketTerms(raw, address, agreement) {
    if (!raw) return null;
    const expectedSeed = lmsr.maxLoss(DEFAULT_B);
    if (raw.kind !== market.constants.KIND_PROPOSAL
        || raw.proposal !== agreement.address
        || raw.creator !== agreement.authority
        || raw.stakeMint !== DEVNET_USDC_MINT
        || raw.b !== DEFAULT_B
        || raw.closesAt !== BigInt(agreement.deadline)
        || raw.graceSeconds !== GRACE_SECONDS
        || raw.maxPosition !== MAX_POSITION
        || raw.seed !== expectedSeed) {
        throw failure('Agreement market terms do not match the canonical LMSR contract.', 'MARKET_TERMS_MISMATCH');
    }
    const [expected] = market.getMarketPda(agreement.address, agreement.authority);
    if (!expected.equals(address)) throw failure('Market address is not the agreement sponsor PDA.', 'MARKET_ADDRESS_MISMATCH');
    return raw;
}

/** Fresh, batched, genesis-verified agreement and sponsor-bound market reads. */
export async function readAgreementMarkets(connection, subjects = []) {
    if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('a Solana connection is required');
    const unique = [...new Set(subjects.filter(Boolean))];
    const chain = agreementChain(connection);
    const observed = unique.length ? await chain.readAccounts(unique, { batchSize: accountsPerRequest() }) : [];
    const connectionReady = await chain.connection();
    const entries = observed.map((row, index) => {
        if (!row || row.problem || !row.account) throw failure(`Agreement chain account is unavailable (${row?.problem || 'missing'}).`, 'AGREEMENT_UNAVAILABLE');
        const agreement = row.account, subject = unique[index];
        if (agreement.address !== subject || agreementAccountOf(agreement.cid, agreement.authority) !== subject) {
            throw failure('Agreement identity does not match its canonical chain account.', 'AGREEMENT_IDENTITY_MISMATCH');
        }
        const [address] = market.getMarketPda(subject, agreement.authority);
        return { connection: connectionReady, agreement, address, market: null };
    });
    const infos = await getMultipleAccountsBatched(connectionReady, entries.map(entry => entry.address), { batchSize: accountsPerRequest() });
    entries.forEach((entry, index) => {
        const info = infos[index];
        if (!info?.data) return;
        if (!info.owner || !new web3.PublicKey(info.owner).equals(new web3.PublicKey(market.constants.PROGRAM_ID))) {
            throw failure('Agreement market belongs to another program.', 'MARKET_PROGRAM_MISMATCH');
        }
        entry.market = marketTerms(market.decodeMarket(info.data), entry.address, entry.agreement);
        if (!market.getVaultAddress(entry.address, entry.market.stakeMint).equals(new web3.PublicKey(entry.market.vault))) {
            throw failure('Agreement market vault does not match its mint and address.', 'MARKET_VAULT_MISMATCH');
        }
    });
    return new Map(entries.map(entry => [entry.agreement.address, entry]));
}

/** Read one canonical subject through the same batched and network-verified path. */
export async function readAgreementMarket(connection, subject) {
    if (!subject) throw new Error('agreement account is required');
    return (await readAgreementMarkets(connection, [subject])).get(subject);
}

async function send(connection, instructions, signer, sendAndConfirm) {
    const transaction = new web3.Transaction().add(...instructions);
    transaction.feePayer = signer.publicKey;
    return sendAndConfirm(connection, transaction, [signer], { commitment: 'confirmed' });
}

async function chainTime(connection) {
    const slot = await connection.getSlot('confirmed');
    const timestamp = await connection.getBlockTime(slot);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Devnet block time is unavailable.');
    return timestamp;
}

/** Buy the shares affordable under `amountAtomic`; exact LMSR math supplies shares and maxCost. */
export async function buyAgreementShares({
    connection, ownerKeypair, subject, stakeMint = DEVNET_USDC_MINT, side, amountAtomic,
    programId, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) throw new Error('amountAtomic must be a positive bigint budget');
    if (stakeMint !== DEVNET_USDC_MINT) throw new Error('Agent agreement markets use devnet USDC.');
    const sideText = sideName(side);
    const context = await readAgreementMarket(connection, subject);
    const { agreement, address, market: raw } = context;
    if (!raw) throw failure('The sponsor has not opened the canonical agreement market.', 'MARKET_NOT_OPEN');
    if (agreement.status !== 'Active') throw failure('Only Active agreements can be traded.', 'MARKET_CLOSED');
    const now = await chainTime(context.connection);
    if (!agreement.deadline || agreement.deadline <= now || raw.closesAt <= BigInt(now) || raw.resolved) {
        throw failure('Trading has closed for this agreement.', 'MARKET_CLOSED');
    }
    const owner = ownerKeypair.publicKey;
    if (owner.equals(new web3.PublicKey(agreement.authority)) || owner.equals(new web3.PublicKey(agreement.lens))) {
        throw failure('The agreement sponsor and lens cannot trade this market.', 'INSIDER_TRADE');
    }
    const model = { model: 'lmsr', b: raw.b, qYes: raw.qYes, qNo: raw.qNo, closesAt: Number(raw.closesAt), graceSeconds: raw.graceSeconds };
    const quote = contract.quote(model, sideText, amountAtomic);
    const ata = market.getAssociatedTokenAddress(owner, raw.stakeMint);
    const instructions = [];
    if (!await context.connection.getAccountInfo(ata, 'confirmed')) {
        instructions.push(splToken.createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, new web3.PublicKey(raw.stakeMint)));
    }
    instructions.push(market.buildBuyIx({ market: address, proposal: subject, owner, stakeMint: raw.stakeMint,
        side: sideText === 'yes' ? market.constants.SIDE_YES : market.constants.SIDE_NO,
        shares: quote.shares, maxCost: quote.maxCost, programId }));
    const signature = await send(context.connection, instructions, ownerKeypair, sendAndConfirm);
    return { marketPda: address.toBase58(), signature, shares: quote.shares, quotedCost: quote.amount, maxCost: quote.maxCost, replayed: false };
}

/** Sell a fixed share quantity from the caller's position with a quoted minimum return. */
export async function sellAgreementShares({
    connection, ownerKeypair, subject, stakeMint = DEVNET_USDC_MINT, side, sharesAtomic,
    programId, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    if (typeof sharesAtomic !== 'bigint' || sharesAtomic <= 0n) throw new Error('sharesAtomic must be a positive bigint');
    if (stakeMint !== DEVNET_USDC_MINT) throw new Error('Agent agreement markets use devnet USDC.');
    const sideText = sideName(side);
    const context = await readAgreementMarket(connection, subject);
    const { agreement, address, market: raw } = context;
    if (!raw) throw failure('The sponsor has not opened the canonical agreement market.', 'MARKET_NOT_OPEN');
    if (agreement.status !== 'Active') throw failure('Only Active agreements can be traded.', 'MARKET_CLOSED');
    const now = await chainTime(context.connection);
    if (!agreement.deadline || agreement.deadline <= now || raw.closesAt <= BigInt(now) || raw.resolved) {
        throw failure('Trading has closed for this agreement.', 'MARKET_CLOSED');
    }
    const owner = ownerKeypair.publicKey;
    if (owner.equals(new web3.PublicKey(agreement.authority)) || owner.equals(new web3.PublicKey(agreement.lens))) {
        throw failure('The agreement sponsor and lens cannot trade this market.', 'INSIDER_TRADE');
    }
    const sideId = sideText === 'yes' ? market.constants.SIDE_YES : market.constants.SIDE_NO;
    const position = await market.readPosition(context.connection, address, owner, sideId);
    if (!position || position.claimed || position.amount < sharesAtomic) throw failure('The position does not hold that many unclaimed shares.', 'INSUFFICIENT_SHARES');
    const quote = contract.quote({ model: 'lmsr', b: raw.b, qYes: raw.qYes, qNo: raw.qNo, closesAt: Number(raw.closesAt), graceSeconds: raw.graceSeconds }, sideText, sharesAtomic, 'sell');
    const signature = await send(context.connection, [market.buildSellIx({ market: address, proposal: subject, owner, stakeMint: raw.stakeMint,
        side: sideId, shares: sharesAtomic, minReturn: quote.minReturn, programId })], ownerKeypair, sendAndConfirm);
    return { marketPda: address.toBase58(), signature, shares: sharesAtomic, quotedReturn: quote.amount, minReturn: quote.minReturn, replayed: false };
}

/** Kept as the sole USDC decimal parser for agent policy configuration. */
export function usdcToAtomic(decimalString) {
    if (typeof decimalString !== 'string') throw new Error('usdcToAtomic takes a decimal STRING, not a number');
    const text = decimalString.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error(`"${decimalString}" is not a non-negative decimal amount of USDC with up to six decimals`);
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
}
