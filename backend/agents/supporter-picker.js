// Deterministic, zero-model-spend policy for a supporter persona. It only considers agreements that are
// open on chain (Active and before their deadline), sponsored and authored by somebody else, that this
// wallet has not already supported, then uses a stable daily hash to avoid always supporting the
// newest row. The returned rationale is stored beside the signed activity.
import { createHash } from 'node:crypto';
import { isOpen } from './discovery.js';

function stableNumber(value) {
    return createHash('sha256').update(String(value)).digest().readUInt32BE(0);
}

function normalizedActions(persona = {}) {
    const configured = persona.support?.actions;
    const actions = Array.isArray(configured) && configured.length ? configured : ['pledge'];
    const allowed = actions.map(action => String(action).toLowerCase())
        .filter(action => ['pledge', 'donate', 'stake'].includes(action));
    if (!allowed.length) throw new Error(`${persona.name || 'supporter'} has no valid support actions`);
    return allowed;
}

/** Open on chain and neither sponsored by this wallet nor authored by this persona. */
export function isOthersOpen(agreement, { wallet = null, personaName = null, now = Date.now() } = {}) {
    if (!isOpen(agreement, now)) return false;
    if (wallet && String(agreement.sponsor || '') === String(wallet)) return false;
    if (personaName && String(agreement.author || '') === String(personaName)) return false;
    return true;
}

export function eligibleSupportAgreements(agreements, { wallet = null, personaName = null, excludeCids = [], now = Date.now() } = {}) {
    const excluded = new Set((excludeCids || []).map(String));
    return (agreements || []).filter(agreement => isOthersOpen(agreement, { wallet, personaName, now }) && !excluded.has(agreement.cid));
}

export function selectSupportAction({ day, persona, agreements, wallet = null, excludeCids = [], now = Date.now() } = {}) {
    if (!day) throw new Error('day is required');
    if (!persona?.name) throw new Error('persona.name is required');
    const excluded = Array.from(new Set((excludeCids || []).map(String)));
    const eligible = eligibleSupportAgreements(agreements, { wallet, personaName: persona.name, excludeCids: excluded, now });
    if (!eligible.length) {
        return {
            selected: null,
            eligibleCids: [],
            excludedCids: excluded,
            reason: excluded.length
                ? `No open agreement by another actor remains unsupported (${excluded.length} already supported).`
                : 'No open agreement by another actor was available.'
        };
    }
    const ranked = eligible.map(agreement => ({
        agreement,
        rank: stableNumber(`${day}:${persona.name}:${agreement.cid}`)
    })).sort((left, right) => left.rank - right.rank);
    const agreement = ranked[0].agreement;
    const actions = normalizedActions(persona);
    const type = actions[stableNumber(`${day}:${persona.name}:action`) % actions.length];
    const amount = String(persona.support?.amountUsdc || '0.10');
    const skipped = excluded.length ? `, skipping ${excluded.length} already supported` : '';
    const selected = {
        type,
        amount,
        side: type === 'stake' ? 'yes' : null,
        agreementCid: agreement.cid,
        account: agreement.account,
        agreementName: agreement.name,
        rationale: `Selected deterministically from ${eligible.length} open agreement${eligible.length === 1 ? '' : 's'} by other actors${skipped}; ${type} records visible support without using an LLM.`
    };
    return {
        selected,
        eligibleCids: eligible.map(item => item.cid),
        excludedCids: excluded,
        reason: selected.rationale
    };
}

// A signer adapter that finds the support already on-chain returns replayed:true with no signature.
// That is not a new action: the run must record it as a no-op instead of a completed support.
export function classifySupportExecution(outcome) {
    const acted = Boolean(outcome?.signature || outcome?.stakeSignature) && outcome?.replayed !== true;
    return { acted, runOutcome: acted ? 'completed' : 'already-supported' };
}

export { stableNumber };
