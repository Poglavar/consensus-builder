// Machine-ready bundle sold by the x402 oracle endpoint. The paid response does not invent a new
// fact: it packages one already-source-hashed land event with the exact resolution recipe an agent
// can independently inspect and use.

import {
    buildProposalLifecycleRecipe,
    EVENT_TYPE,
    PROPOSAL_PROGRAM_ID,
    STATUS_CANCELLED,
    STATUS_EXECUTED
} from './proposal-lifecycle.js';

const OUTCOME_STATUS = Object.freeze({
    executed: STATUS_EXECUTED,
    cancelled: STATUS_CANCELLED
});

function validIsoDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function buildVerifiedProposalFact({ event, proposalAccount, marketAccount = null } = {}) {
    if (!event || typeof event !== 'object') throw new Error('event is required');
    if (event.eventType !== EVENT_TYPE) throw new Error(`eventType must be ${EVENT_TYPE}`);
    if (event.subject?.type !== 'proposal' || event.subject?.id !== proposalAccount) {
        throw new Error('event subject does not match the requested proposal');
    }
    const expectedStatus = OUTCOME_STATUS[event.outcome];
    if (!expectedStatus) throw new Error('event outcome is not a supported terminal state');
    if (event.evidence?.proposalStatusByte !== expectedStatus) {
        throw new Error('event outcome does not match its proposal status evidence');
    }
    if (event.attester?.kind !== 'solana_program' || event.attester?.address !== PROPOSAL_PROGRAM_ID) {
        throw new Error('event was not attested by the trusted ProposalNFT program');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(event.source?.hash || '')) {
        throw new Error('event has no canonical source hash');
    }
    if (!event.source?.transaction || !validIsoDate(event.observedAt)) {
        throw new Error('event has no source transaction or source timestamp');
    }

    const recipe = buildProposalLifecycleRecipe({ proposalAccount, marketAccount });
    return {
        fact: event,
        recipe,
        verification: {
            status: 'verified',
            method: 'source-hashed Solana program account plus terminal transaction',
            eventId: event.id,
            recipeHash: recipe.hash,
            checks: {
                subjectMatches: true,
                terminalStatusMatches: true,
                trustedAttesterMatches: true,
                sourceHashPresent: true,
                sourceTransactionPresent: true,
                sourceTimestampPresent: true
            }
        }
    };
}
