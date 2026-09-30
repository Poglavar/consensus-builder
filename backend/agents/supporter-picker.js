// Deterministic, zero-model-spend policy for a supporter persona. It only considers active,
// minted proposals by somebody else that this wallet has not already supported, then uses a stable
// daily hash to avoid always supporting the first API row. The returned rationale is stored beside
// the signed activity.
import { createHash } from 'node:crypto';

function stableNumber(value) {
    return createHash('sha256').update(String(value)).digest().readUInt32BE(0);
}

function proposalAccount(proposal = {}) {
    return proposal.onchain?.proposalId || proposal.onchainData?.proposalId || null;
}

function proposalKey(proposal = {}) {
    return String(proposal.proposalId || proposal.id);
}

function normalizedActions(persona = {}) {
    const configured = persona.support?.actions;
    const actions = Array.isArray(configured) && configured.length ? configured : ['pledge'];
    const allowed = actions.map(action => String(action).toLowerCase())
        .filter(action => ['pledge', 'donate', 'stake'].includes(action));
    if (!allowed.length) throw new Error(`${persona.name || 'supporter'} has no valid support actions`);
    return allowed;
}

export function eligibleSupportProposals(proposals, { wallet = null, personaName = null, excludeProposalIds = [] } = {}) {
    const excluded = new Set((excludeProposalIds || []).map(String));
    return (proposals || []).filter(proposal => {
        if (String(proposal?.lifecycleStatus || '').toLowerCase() !== 'active') return false;
        if (!proposalAccount(proposal)) return false;
        if (wallet && String(proposal.author || '') === String(wallet)) return false;
        if (personaName && String(proposal.agent?.persona || '') === String(personaName)) return false;
        if (excluded.has(proposalKey(proposal))) return false;
        return true;
    });
}

export function selectSupportAction({ day, persona, proposals, wallet = null, excludeProposalIds = [] } = {}) {
    if (!day) throw new Error('day is required');
    if (!persona?.name) throw new Error('persona.name is required');
    const excluded = Array.from(new Set((excludeProposalIds || []).map(String)));
    const eligible = eligibleSupportProposals(proposals, { wallet, personaName: persona.name, excludeProposalIds: excluded });
    if (!eligible.length) {
        return {
            selected: null,
            eligibleProposalIds: [],
            excludedProposalIds: excluded,
            reason: excluded.length
                ? `No active minted proposal by another actor remains unsupported (${excluded.length} already supported).`
                : 'No active minted proposal by another actor was available.'
        };
    }
    const ranked = eligible.map(proposal => ({
        proposal,
        rank: stableNumber(`${day}:${persona.name}:${proposalKey(proposal)}`)
    })).sort((left, right) => left.rank - right.rank);
    const proposal = ranked[0].proposal;
    const actions = normalizedActions(persona);
    const type = actions[stableNumber(`${day}:${persona.name}:action`) % actions.length];
    const amount = String(persona.support?.amountUsdc || '0.10');
    const skipped = excluded.length ? `, skipping ${excluded.length} already supported` : '';
    const selected = {
        type,
        amount,
        side: type === 'stake' ? 'yes' : null,
        proposalId: proposalKey(proposal),
        proposalAccount: proposalAccount(proposal),
        proposalName: proposal.name || proposal.title || proposalKey(proposal),
        rationale: `Selected deterministically from ${eligible.length} active minted proposal${eligible.length === 1 ? '' : 's'} by other actors${skipped}; ${type} records visible support without using an LLM.`
    };
    return {
        selected,
        eligibleProposalIds: eligible.map(proposalKey),
        excludedProposalIds: excluded,
        reason: selected.rationale
    };
}

// A signer adapter that finds the support already on-chain returns replayed:true with no signature.
// That is not a new action: the run must record it as a no-op instead of a completed support.
export function classifySupportExecution(outcome) {
    const acted = Boolean(outcome?.signature) && outcome?.replayed !== true;
    return { acted, runOutcome: acted ? 'completed' : 'already-supported' };
}

export { proposalAccount, stableNumber };
