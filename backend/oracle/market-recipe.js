// The settlement rule of an agreement's prediction market (plan-design-agreement.md, M3). A pool is
// keyed by the agreement's chain account and settles YES once that account is Executed, NO once it
// is Cancelled or Expired, and stays open while it is Active. `agreement-execution-v1` states the
// rule as a hash-committed recipe (oracle/recipe.schema.json), served at
// GET /oracle/recipes/agreement-execution-v1 (routes/markets.js) and bound into the paid verified fact
// (oracle/verified-fact.js); the markets and bet-link routes apply the same mapping to the status the
// lifecycle oracle observed on chain and wrote into the agreement index (`consensus.agreement.onchain`).

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AGREEMENT_PROGRAM_ID, AgreementClient, ONCHAIN_STATUSES } from '../agreements/onchain.js';
import { AGREEMENT_LIFECYCLE_EVENT_TYPE } from './agreement-lifecycle.js';
import { evaluateResolutionRecipe } from './recipe-evaluator.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
// The market program's codec (proposal_market): its program id goes into the recipe.
const marketClient = require('../../frontend/js/solana/market-client.js');

export const AGREEMENT_EXECUTION_RECIPE_ID = 'agreement-execution-v1';
// What each terminal status settles a pool to. Active, and a status nobody observed, settle nothing.
export const SETTLEMENT = Object.freeze({ executed: 'yes', cancelled: 'no', expired: 'no' });

/** The chain status the index's `onchain` column records for an agreement, or null when none is. */
export function chainStatusOf(onchain) {
    const status = onchain && typeof onchain === 'object' && typeof onchain.status === 'string' ? onchain.status : '';
    return ONCHAIN_STATUSES.includes(status) ? status : null;
}

/** 'yes' | 'no' once the agreement account is terminal; null while it is active or unobserved. */
export function marketOutcome(status) {
    return Object.prototype.hasOwnProperty.call(SETTLEMENT, status) ? SETTLEMENT[status] : null;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function account(value, label) {
    let key = null;
    try { key = new web3.PublicKey(String(value)); } catch { key = null; }
    if (!key || key.toBase58() !== value) throw new Error(`${label} must be a base58 Solana account`);
    return value;
}

/**
 * agreement-execution-v1 for one agreement's pool. The subject is the agreement account and its
 * CID; the trusted attester is the agreement program, which moves the account to Executed only on
 * the attestation of the lens key the account names (so the lens is committed through the account
 * rather than repeated here); the outcomes are the program's terminal statuses, observed as the
 * lifecycle oracle's `agreement_lifecycle` events. The body never changes under this id.
 */
export function buildAgreementExecutionRecipe({ agreementAccount, agreementCid, marketAccount = null } = {}) {
    account(agreementAccount, 'agreementAccount');
    if (typeof agreementCid !== 'string' || !agreementCid) throw new Error('agreementCid is required');
    if (marketAccount !== null) account(marketAccount, 'marketAccount');
    const { constants, AGREEMENT_OFFSETS } = AgreementClient;
    const body = {
        id: AGREEMENT_EXECUTION_RECIPE_ID,
        version: 1,
        question: 'Will this agreement execute on-chain?',
        eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
        subject: { chain: 'solana:devnet', agreementAccount, agreementCid, marketAccount },
        trustedAttesters: [{
            kind: 'solana_program',
            address: AGREEMENT_PROGRAM_ID,
            role: 'executes the agreement only on the attestation of the lens it names'
        }],
        outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
        verification: {
            kind: 'program_account_state',
            marketProgram: marketClient.constants.PROGRAM_ID,
            agreementProgram: AGREEMENT_PROGRAM_ID,
            statusOffset: AGREEMENT_OFFSETS.status,
            statusBytes: { executed: constants.STATUS_EXECUTED, cancelled: constants.STATUS_CANCELLED, expired: constants.STATUS_EXPIRED },
            permissionless: true
        }
    };
    return { ...body, hash: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}` };
}

/** A lifecycle event (as GET /oracle/events serves it) about this recipe's agreement account. */
export function agreementEventMatches(event, recipe) {
    const subject = event && event.subject;
    return Boolean(subject && subject.type === 'agreement'
        && typeof subject.id === 'string' && subject.id === recipe?.subject?.agreementAccount);
}

/**
 * Where a pool stands on the lifecycle events observed for its agreement account: the recipe
 * evaluator's verdict (`resolved` with decision YES or NO, `insufficient_evidence` while the
 * agreement is active, `disputed` on conflicting observations).
 */
export function evaluateAgreementMarket({ recipe, events = [], now = new Date() } = {}) {
    if (recipe?.id !== AGREEMENT_EXECUTION_RECIPE_ID) throw new Error(`expected an ${AGREEMENT_EXECUTION_RECIPE_ID} recipe`);
    return evaluateResolutionRecipe({ recipe, evidence: events, now, subjectMatches: agreementEventMatches });
}
