// Machine-ready bundle sold by the x402 oracle endpoint. The paid response does not invent a new
// fact: it packages one already-source-hashed land event, an agreement's terminal `agreement_lifecycle`
// event (oracle/agreement-lifecycle.js), with the exact resolution recipe the agreement's market settles
// by (agreement-execution-v1, oracle/market-recipe.js), which an agent can independently inspect and use.

import { createHash } from 'node:crypto';
import { AGREEMENT_PROGRAM_ID, AgreementClient } from '../agreements/onchain.js';
import { AGREEMENT_LIFECYCLE_EVENT_TYPE } from './agreement-lifecycle.js';
import { agreementEventMatches, buildAgreementExecutionRecipe } from './market-recipe.js';
import { evaluateResolutionRecipe } from './recipe-evaluator.js';

const { constants } = AgreementClient;
const OUTCOME_STATUS = Object.freeze({
    executed: constants.STATUS_EXECUTED,
    cancelled: constants.STATUS_CANCELLED,
    expired: constants.STATUS_EXPIRED
});

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

function validIsoDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * @param {{ event: object, agreementAccount: string, marketAccount?: string|null }} input
 *   event as routes/land-events.js eventFromRow serves it
 */
export function buildVerifiedAgreementFact({ event, agreementAccount, marketAccount = null } = {}) {
    if (!event || typeof event !== 'object') throw new Error('event is required');
    if (event.eventType !== AGREEMENT_LIFECYCLE_EVENT_TYPE) throw new Error(`eventType must be ${AGREEMENT_LIFECYCLE_EVENT_TYPE}`);
    if (event.subject?.type !== 'agreement' || event.subject?.id !== agreementAccount) {
        throw new Error('event subject does not match the requested agreement account');
    }
    const expectedStatus = OUTCOME_STATUS[event.outcome];
    if (expectedStatus === undefined) throw new Error('event outcome is not a terminal agreement status');
    if (event.attester?.kind !== 'solana_program' || event.attester?.address !== AGREEMENT_PROGRAM_ID) {
        throw new Error('event was not attested by the agreement program');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(event.source?.hash || '')) {
        throw new Error('event has no canonical source hash');
    }
    if (!event.source?.transaction || !validIsoDate(event.observedAt)) {
        throw new Error('event has no source transaction or source timestamp');
    }

    // The account bytes the event hashed: their status and CID must be the event's, so neither can be
    // swapped without breaking the source hash.
    const accountData = Buffer.from(String(event.evidence?.accountDataBase64 || ''), 'base64');
    if (`sha256:${sha256Hex(accountData)}` !== event.source.hash) {
        throw new Error('event agreement account bytes do not match its source hash');
    }
    let account = null;
    try { account = AgreementClient.readAgreement(new Uint8Array(accountData), agreementAccount); } catch { account = null; }
    if (!account) throw new Error('event account bytes are not an agreement account');
    if (account.statusCode !== expectedStatus) throw new Error('event outcome does not match its agreement account status');
    if (account.cid !== event.evidence?.agreementCid) throw new Error('event agreement CID does not match its account');

    const recipe = buildAgreementExecutionRecipe({ agreementAccount, agreementCid: account.cid, marketAccount });
    const lens = evaluateResolutionRecipe({
        recipe,
        evidence: [event],
        now: event.recordedAt || event.observedAt,
        subjectMatches: agreementEventMatches
    });
    if (lens.status !== 'resolved' || lens.outcome !== event.outcome) {
        throw new Error(`event does not satisfy its resolution recipe: ${lens.reason}`);
    }
    return {
        fact: event,
        recipe,
        verification: {
            status: 'verified',
            method: 'source-hashed Solana agreement account plus its terminal transaction',
            eventId: event.id,
            recipeId: recipe.id,
            recipeHash: recipe.hash,
            lens,
            checks: {
                subjectMatches: true,
                terminalStatusMatches: true,
                trustedAttesterMatches: true,
                sourceHashPresent: true,
                accountBytesMatchSourceHash: true,
                sourceTransactionPresent: true,
                sourceTimestampPresent: true
            }
        }
    };
}
