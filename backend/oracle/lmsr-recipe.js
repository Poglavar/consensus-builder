// Immutable answer contract for points and devnet-USDC LMSR markets on dated agreements.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { MARKET_GRACE_SECONDS, MARKET_LIQUIDITY } from '../markets/agreement-source.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const cid = require('../../frontend/js/cid.js');
const bettingContract = require('../../frontend/js/bets/betting-contract.js');
const { PublicKey } = web3;

export const AGREEMENT_EXECUTION_BY_DEADLINE_RECIPE_ID = 'agreement-execution-by-deadline-v1';
const STATUSES = new Set(['active', 'executed', 'cancelled', 'expired']);

function error(message, status) {
    return Object.assign(new Error(message), { status });
}

export function canonicalAccount(value) {
    if (typeof value !== 'string' || !value) return false;
    try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function validateAgreementRecipeSource(source, expectedAccount, { allowUndated = false } = {}) {
    if (!source || typeof source !== 'object' || source.account !== expectedAccount
        || !canonicalAccount(source.account) || !canonicalAccount(source.sponsor) || !Array.isArray(source.lenses)
        || typeof source.cid !== 'string' || !source.cid || source.cid.length > 120
        || !Number.isSafeInteger(source.closesAt) || source.closesAt < (allowUndated ? 0 : 1)
        || source.graceSeconds !== MARKET_GRACE_SECONDS
        || !Number.isSafeInteger(source.chainTime) || source.chainTime <= 0
        || !Number.isSafeInteger(source.observedSlot) || source.observedSlot <= 0
        || !STATUSES.has(source.chainStatus)
        || (source.executedAt !== null && (!Number.isSafeInteger(source.executedAt) || source.executedAt <= 0))
        || (source.chainStatus === 'executed' && (!Number.isSafeInteger(source.executedAt)
            || source.executedAt <= 0 || source.executedAt > source.chainTime))) {
        throw error('Agreement source evidence is invalid or unavailable', 503);
    }
    return source;
}

export function buildAgreementExecutionByDeadlineRecipe(source, address = null, terms = null) {
    const body = {
        id: AGREEMENT_EXECUTION_BY_DEADLINE_RECIPE_ID,
        version: 1,
        questionTitle: 'Will this agreement execute on-chain by its deadline?',
        network: 'devnet',
        agreement: {
            cid: source.cid,
            account: source.account,
            program: AGREEMENT_PROGRAM_ID,
            sponsor: source.sponsor
        },
        market: {
            address, model: 'lmsr', b: String(terms?.b ?? MARKET_LIQUIDITY),
            closesAt: Number(terms?.closesAt ?? source.closesAt), graceSeconds: terms?.graceSeconds ?? source.graceSeconds,
            ...(terms ? { creator: terms.creator, stakeMint: terms.stakeMint, maxPosition: String(terms.maxPosition), seed: String(terms.seed) } : {})
        },
        atomicDecimals: 6,
        assets: [terms ? 'devnet-usdc' : 'points'],
        payouts: { yes: { yes: '1', no: '0' }, no: { yes: '0', no: '1' }, void: { yes: '0.5', no: '0.5' } },
        rules: {
            executed: 'A valid positive executedAt is required: at or before closesAt is YES, after closesAt is NO; invalid time cannot settle',
            expired: 'NO',
            cancelled: 'NO',
            active: 'NO strictly after closesAt plus graceSeconds'
        }
    };
    const hash = `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
    return { ...body, hash };
}

export function externalRecipeProjection(source, address, market) {
    const hash = bytes => 'sha256:' + Buffer.from(bytes).toString('hex');
    return {
        recipe: { kind: 'recipe', agreement: source.account, market: { address, creator: market.creator,
            b: String(market.b), seed: String(market.seed), closesAt: Number(market.closesAt), graceSeconds: market.graceSeconds,
            maxPosition: String(market.maxPosition), stakeMint: market.stakeMint },
            hash: hash(market.recipeHash), cid: cid.rawCidOfDigest(market.recipeHash),
            subjectHash: hash(market.subjectHash), yesValueHash: hash(market.yesValueHash), noValueHash: hash(market.noValueHash),
            trustedAttester: market.trustedAttester, credential: market.credential, schema: market.schema },
        observation: { outcome: market.resolved ? ['no', 'yes', 'void'][market.outcome] : null,
            proposedOutcome: market.proposed ? ['no', 'yes', 'void'][market.outcome] : null,
            challengeEndsAt: market.challengeEndsAt == null ? null : Number(market.challengeEndsAt), slot: source.observedSlot }
    };
}

export function observeAgreementRecipe(source, nowSeconds, market = source) {
    let outcome;
    try {
        outcome = bettingContract.executionOutcome(source, market, Math.min(nowSeconds, source.chainTime));
    } catch {
        throw error('Agreement decision evidence is invalid or unavailable', 503);
    }
    return {
        chainStatus: source.chainStatus,
        executedAt: source.executedAt,
        chainTime: source.chainTime,
        slot: source.observedSlot,
        outcome
    };
}
