// Agent operations on term-bound LMSR markets. Scheduled strategies that target a specific
// execution forecast use the same default terms each run.
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
const externalRecipe = require('../../frontend/js/bets/external-recipe.js');
market.configure({ web3 });

const chains = new WeakMap();
function agreementChain(connection) {
    let chain = chains.get(connection);
    if (!chain) { chain = createAgreementChain({ connection }); chains.set(connection, chain); }
    return chain;
}

export const DEFAULT_B = 5_000_000n;
export const GRACE_SECONDS = 0;
export const MAX_POSITION = 0n;
export const MARKET_SEED_ATOMIC = lmsr.maxLoss(DEFAULT_B);

function failure(message, code) {
    return Object.assign(new Error(message), { code });
}

function sideName(side) {
    if (side === market.constants.SIDE_YES || String(side).toLowerCase() === 'yes') return 'yes';
    if (side === market.constants.SIDE_NO || String(side).toLowerCase() === 'no') return 'no';
    throw new Error('side must be 0 (NO) or 1 (YES)');
}

function verifyBinding(raw, agreement) {
    if (raw && (raw.proposal !== agreement.address || raw.stakeMint !== DEVNET_USDC_MINT ||
        raw.seed !== lmsr.maxLoss(raw.b) || (raw.kind === 1 && !agreement.lenses.includes(raw.trustedAttester)))) {
        throw failure('Market does not match the selected agreement and funded USDC terms.', 'MARKET_BINDING_MISMATCH');
    }
    return raw;
}

/** Fresh, batched, genesis-verified agreement and sponsor-bound market reads. */
export async function readAgreementMarkets(connection, subjects = [], { marketAddress = null } = {}) {
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
        const [address] = marketAddress
            ? [new web3.PublicKey(marketAddress)]
            : market.getMarketPda(subject, agreement.authority, { stakeMint: DEVNET_USDC_MINT, b: DEFAULT_B, closesAt: agreement.deadline, graceSeconds: GRACE_SECONDS, maxPosition: MAX_POSITION });
        return { connection: connectionReady, agreement, address, market: null };
    });
    const infos = await getMultipleAccountsBatched(connectionReady, entries.map(entry => entry.address), { batchSize: accountsPerRequest() });
    for (const [index, entry] of entries.entries()) {
        entry.market = verifyBinding(market.readMarketAccount(infos[index], entry.address), entry.agreement);
    }
    return new Map(entries.map(entry => [entry.agreement.address, entry]));
}

/** Read one canonical subject through the same batched and network-verified path. */
export async function readAgreementMarket(connection, subject, options = {}) {
    if (!subject) throw new Error('agreement account is required');
    return (await readAgreementMarkets(connection, [subject], options)).get(subject);
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

async function checkTrade({ agreement, market: raw, connection }, owner) {
    if (!raw) throw failure('Selected market is not open.', 'MARKET_NOT_OPEN');
    if (raw.resolved || raw.proposed || (raw.kind === 0 && agreement.status !== 'Active') || raw.closesAt <= BigInt(await chainTime(connection))) {
        throw failure('Trading has closed for this market.', 'MARKET_CLOSED');
    }
    if ([agreement.authority, ...agreement.lenses, raw.kind === 1 && raw.trustedAttester].includes(owner.toBase58())) {
        throw failure('The agreement sponsor and verifier cannot trade this market.', 'INSIDER_TRADE');
    }
}

/** Buy the shares affordable under `amountAtomic`; exact LMSR math supplies shares and maxCost. */
export async function buyAgreementShares({
    connection, ownerKeypair, subject, marketAddress, stakeMint = DEVNET_USDC_MINT, side, amountAtomic,
    programId, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) throw new Error('amountAtomic must be a positive bigint budget');
    if (stakeMint !== DEVNET_USDC_MINT) throw new Error('Agent agreement markets use devnet USDC.');
    const sideText = sideName(side);
    const context = await readAgreementMarket(connection, subject, { marketAddress });
    const { address, market: raw } = context;
    const owner = ownerKeypair.publicKey;
    await checkTrade(context, owner);
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
    connection, ownerKeypair, subject, marketAddress, stakeMint = DEVNET_USDC_MINT, side, sharesAtomic,
    programId, sendAndConfirm = web3.sendAndConfirmTransaction
} = {}) {
    if (!ownerKeypair?.publicKey) throw new Error('ownerKeypair (a web3 Keypair) is required');
    if (typeof sharesAtomic !== 'bigint' || sharesAtomic <= 0n) throw new Error('sharesAtomic must be a positive bigint');
    if (stakeMint !== DEVNET_USDC_MINT) throw new Error('Agent agreement markets use devnet USDC.');
    const sideText = sideName(side);
    const context = await readAgreementMarket(connection, subject, { marketAddress });
    const { address, market: raw } = context;
    const owner = ownerKeypair.publicKey;
    await checkTrade(context, owner);
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

/**
 * Fund a market as its creator. Replaying the same terms returns the existing funded account. A
 * public-record (`external`) market names one of the agreement's lens members as its verifier:
 * `trustedAttester`, or the first member when not given.
 */
export async function openAgreementMarket({ connection, creatorKeypair, sponsorKeypair, subject, b = DEFAULT_B, closesAt, external, trustedAttester = null, publishRecipe, maxSeedAtomic,
    ensureSeed = async () => {}, readSeedBalance = async (rpc, wallet) => {
        const ata = splToken.getAssociatedTokenAddressSync(new web3.PublicKey(DEVNET_USDC_MINT), wallet);
        try {
            const token = await splToken.getAccount(rpc, ata, 'confirmed');
            if (!token.owner.equals(wallet) || !token.mint.equals(new web3.PublicKey(DEVNET_USDC_MINT))) throw new Error('Market seed account identity mismatch');
            return token.amount;
        } catch (error) {
            if (error instanceof splToken.TokenAccountNotFoundError) return 0n;
            throw error;
        }
    }, sendAndConfirm = web3.sendAndConfirmTransaction } = {}) {
    creatorKeypair ||= sponsorKeypair;
    if (!creatorKeypair?.publicKey) throw new Error('creatorKeypair is required');
    const chain = agreementChain(connection);
    const [observed] = await chain.readAccounts([subject]);
    const agreement = observed?.account;
    if (!agreement || agreement.address !== subject || agreementAccountOf(agreement.cid, agreement.authority) !== subject) {
        throw failure('Agreement account identity is unavailable.', 'AGREEMENT_UNAVAILABLE');
    }
    const rpc = await chain.connection();
    const attester = trustedAttester ?? agreement.lenses[0] ?? null;
    if (external && !agreement.lenses.includes(attester)) throw failure('The verifier must be one of the agreement\'s lens members.', 'ATTESTER_NOT_IN_LENS');
    const data = external ? { proposal: subject, trustedAttester: attester, external } : null;
    const prepared = data ? externalRecipe.build(data) : null;
    closesAt ??= prepared?.closesAt ?? agreement.deadline;
    if (!Number.isSafeInteger(closesAt) || (prepared && closesAt !== prepared.closesAt)) throw failure('Invalid question deadline.', 'INVALID_DEADLINE');
    const terms = { proposal: subject, creator: creatorKeypair.publicKey, stakeMint: DEVNET_USDC_MINT, b, closesAt,
        graceSeconds: GRACE_SECONDS, maxPosition: MAX_POSITION, ...prepared?.commitments };
    const instruction = prepared ? market.buildCreateLmsrExternalMarketIx(terms) : market.buildCreateLmsrMarketIx(terms);
    const creatorAddress = instruction.keys[0].pubkey;
    const raw = verifyBinding(await market.readMarket(rpc, creatorAddress), agreement);
    if (raw) return { replayed: true, signature: null, address: creatorAddress.toBase58(), seedAtomic: String(raw.seed) };
    if ((!prepared && agreement.status !== 'Active') || closesAt <= await chainTime(rpc)) throw failure('This market cannot open with those terms.', 'MARKET_CLOSED');
    const seedAtomic = lmsr.maxLoss(b);
    if (typeof maxSeedAtomic !== 'bigint' || maxSeedAtomic < seedAtomic) throw failure('Market seed exceeds configured allowance.', 'MARKET_SEED_CAP');
    const funding = await ensureSeed(seedAtomic);
    const balance = await readSeedBalance(rpc, creatorKeypair.publicKey);
    if (typeof balance !== 'bigint' || balance < seedAtomic) throw failure(`Market seed requires ${seedAtomic} atomic devnet USDC units.`, 'INSUFFICIENT_USDC');
    if (prepared && typeof publishRecipe !== 'function') throw new Error('publishRecipe is required for external markets');
    if (prepared) await publishRecipe(data, prepared.cid);
    const signature = await send(rpc, [instruction], creatorKeypair, sendAndConfirm);
    return { replayed: false, signature, address: creatorAddress.toBase58(), seedAtomic: String(seedAtomic), funding };
}
