// Immutable answer contract for points and devnet-USDC LMSR markets on dated agreements.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { MARKET_GRACE_SECONDS, MARKET_LIQUIDITY } from '../markets/agreement-source.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const lmsrClient = require('../../frontend/js/solana/lmsr-client.js').configure({ web3 });
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

export function validateAgreementRecipeSource(source, expectedAccount) {
    if (!source || typeof source !== 'object' || source.account !== expectedAccount
        || !canonicalAccount(source.account) || !canonicalAccount(source.sponsor)
        || typeof source.cid !== 'string' || !source.cid || source.cid.length > 120
        || !Number.isSafeInteger(source.closesAt) || source.closesAt <= 0
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

export function deriveAgreementMarketAddress(account, sponsor) {
    return lmsrClient.getMarketPda(account, sponsor)[0].toBase58();
}

export function buildAgreementExecutionByDeadlineRecipe(source, canonicalMarket) {
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
            address: canonicalMarket,
            model: 'lmsr',
            b: MARKET_LIQUIDITY,
            closesAt: source.closesAt,
            graceSeconds: source.graceSeconds
        },
        atomicDecimals: 6,
        assets: ['points', 'devnet-usdc'],
        priceBooks: 'independent per asset',
        payouts: { yes: { yes: '1', no: '0' }, no: { yes: '0', no: '1' }, void: { yes: '0.5', no: '0.5' } },
        rules: {
            executed: 'A valid positive executedAt is required: at or before closesAt is YES, after closesAt is NO; invalid time cannot settle',
            expired: 'NO',
            cancelled: 'VOID',
            active: 'NO once chainTime reaches closesAt plus graceSeconds; before then unresolved'
        }
    };
    const hash = `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
    return { ...body, hash };
}

export function observeAgreementRecipe(source, nowSeconds) {
    let outcome;
    try {
        outcome = bettingContract.executionOutcome(source, source, Math.min(nowSeconds, source.chainTime));
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
